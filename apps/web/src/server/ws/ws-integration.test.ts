/**
 * WS integration tests — boots the real `createServer` factory on an
 * ephemeral port with the in-memory repo (no Postgres), and drives it with
 * socket.io-client.
 */

import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { createServer, type CardCraftersServer } from "../../../server";
import { MemoryRepo } from "../repo/memory-repo";

let srv: CardCraftersServer;
let port: number;
let gameId: string;
let gameCode: string;
let joinTokenA: string;

beforeEach(async () => {
  const repo = new MemoryRepo();
  srv = await createServer({ repo, enableNext: false });
  await new Promise<void>((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
  port = (srv.httpServer.address() as AddressInfo).port;
  const setup = await srv.hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 3 });
  gameId = setup.game.id;
  gameCode = setup.game.code;
  joinTokenA = setup.teams[0]!.joinToken;
});

afterEach(async () => {
  await srv.close();
});

function connect(auth: Record<string, unknown> = {}): Socket {
  return io(`http://127.0.0.1:${port}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
  });
}

/** Emit and collect the ack. */
function emitAck<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  payload?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 3_000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

/** Wait for the next occurrence of an event. */
function waitFor<T = Record<string, unknown>>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, 3_000);
    const handler = (payload: T) => {
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

describe("ws integration (memory repo, ephemeral port)", () => {
  it("(a) GM joins with the game code → ack ok + sync:full", async () => {
    const socket = connect({ role: "gm" });
    const syncPromise = waitFor<Record<string, unknown>>(socket, "sync:full");

    const ack = await emitAck<{
      ok: boolean;
      identity?: { role: string; gameId: string };
      rooms?: string[];
    }>(socket, "join", { role: "gm", joinToken: gameCode });

    expect(ack.ok).toBe(true);
    expect(ack.identity?.role).toBe("gm");
    expect(ack.identity?.gameId).toBe(gameId);
    expect(ack.rooms).toContain(`game:${gameId}`);
    expect(ack.rooms).toContain(`game:${gameId}:gm`);

    const sync = await syncPromise;
    expect(sync).toMatchObject({ gameId, phase: "LOBBY", round: 1 });
    expect(sync.seq).toBeGreaterThan(0);
    expect(sync.teams).toHaveLength(3);
    socket.close();
  });

  it("(b) player joins via joinToken → identity + sync:full with team snapshot", async () => {
    const socket = connect();
    const syncPromise = waitFor<Record<string, unknown>>(socket, "sync:full");

    const ack = await emitAck<{
      ok: boolean;
      identity?: { role: string; playerId: string; teamId: string; sessionToken: string };
    }>(socket, "join", { role: "player", joinToken: joinTokenA, nickname: "Alex" });

    expect(ack.ok).toBe(true);
    expect(ack.identity?.role).toBe("player");
    expect(ack.identity?.playerId).toBeTruthy();
    expect(ack.identity?.sessionToken).toBeTruthy();

    const sync = await syncPromise;
    expect(sync.teams).toHaveLength(3);
    const teamA = (sync.teams as Array<Record<string, unknown>>).find((t) => t.label === "A");
    expect(teamA).toBeTruthy();
    expect(
      (teamA!.members as Array<{ nickname: string }>).map((m) => m.nickname),
    ).toContain("Alex");
    expect(teamA!.memberCount).toBe(1);
    socket.close();
  });

  it("(c) reconnect with the same sessionToken → same playerId + fresh sync:full", async () => {
    const first = connect();
    const firstSync = waitFor<Record<string, unknown>>(first, "sync:full");
    const ack = await emitAck<{ identity: { playerId: string; sessionToken: string } }>(
      first,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Alex" },
    );
    await firstSync;
    first.close();

    const second = connect({ sessionToken: ack.identity.sessionToken });
    const secondSync = waitFor<Record<string, unknown>>(second, "sync:full");
    const ack2 = await emitAck<{ ok: boolean; identity: { playerId: string; nickname: string } }>(
      second,
      "join",
      { role: "player" },
    );
    const sync2 = await secondSync;

    expect(ack2.ok).toBe(true);
    expect(ack2.identity.playerId).toBe(ack.identity.playerId);
    expect(ack2.identity.nickname).toBe("Alex");
    expect(sync2.gameId).toBeTruthy();
    second.close();
  });

  it("(d) bad payload (role 'hacker') → ack ok:false", async () => {
    const socket = connect();
    const ack = await emitAck<{ ok: boolean; error?: string }>(socket, "join", {
      role: "hacker",
      joinToken: joinTokenA,
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBeTruthy();
    socket.close();
  });

  it("(e) two sockets in the game room both receive player:joined", async () => {
    const gm = connect({ role: "gm" });
    const player = connect();

    // GM joins the game room first.
    const gmJoined = emitAck(gm, "join", { role: "gm", joinToken: gameCode });
    // Player A also joins the room.
    const playerAck = emitAck<{ identity: { nickname: string } }>(player, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Alex",
    });
    await Promise.all([gmJoined, playerAck]);

    // Both sockets listen; player B joining must reach both.
    const gmSaw = waitFor<{ nickname: string; isNewPlayer: boolean }>(gm, "player:joined");
    const playerSaw = waitFor<{ nickname: string; isNewPlayer: boolean }>(player, "player:joined");
    const second = connect();
    const secondJoin = emitAck(second, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Sam",
    });
    const [seenByGm, seenByPlayer] = await Promise.all([gmSaw, playerSaw, secondJoin]);

    expect(seenByGm.nickname).toBe("Sam");
    expect(seenByPlayer.nickname).toBe("Sam");
    expect(seenByGm.isNewPlayer).toBe(true);
    expect((seenByGm as unknown as Record<string, unknown>).seq).toBeGreaterThan(0);

    gm.close();
    player.close();
    second.close();
  });
});
