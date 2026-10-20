/**
 * WS integration tests — boots the real `createServer` factory on an
 * ephemeral port with the in-memory repo (no Postgres), and drives it with
 * socket.io-client.
 */

import { type AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";

import { DEFAULT_CARD_CONFIG, MAX_PROMPT_WORDS } from "@cardcrafters/shared";

import { createAiRouter, type AiRouter } from "../ai/router";
import { DEFAULT_ITEMS_DIR } from "../flows/item-image";
import { DEFAULT_MONTAGE_DIR } from "../flows/montage-accumulator";
import { MOCK_CRITIQUE_VERDICT } from "../layout/critique";
import { createServer, type CardCraftersServer } from "../../../server";
import { MemoryRepo } from "../repo/memory-repo";
import { normalizeSyncFull, type SyncFullEvent } from "../../lib/store";

let srv: CardCraftersServer;
let repo: MemoryRepo;
let ai: AiRouter;
let hub: CardCraftersServer["hub"];
let port: number;
let gameId: string;
let gameCode: string;
let joinTokenA: string;
let joinTokenB: string;
let teamAId: string;
let teamBId: string;
// Real PNGs the mock image handler writes under the Next public dir —
// removed in afterEach so the tests leave no artifacts behind.
const writtenFiles: string[] = [];

beforeEach(async () => {
  // Force the in-memory image queue even when the dev .env exports REDIS_URL
  // — ioredis/BullMQ would try to connect to Redis and spam teardown errors.
  delete process.env.REDIS_URL;
  repo = new MemoryRepo();
  // Force mock mode so tests never hit a real provider even when a local
  // OPENROUTER_API_KEY is present.
  ai = await createAiRouter({ repo, env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
  srv = await createServer({ repo, enableNext: false, ai });
  hub = srv.hub;
  await new Promise<void>((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
  port = (srv.httpServer.address() as AddressInfo).port;
  const setup = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 3 });
  gameId = setup.game.id;
  gameCode = setup.game.code;
  joinTokenA = setup.teams[0]!.joinToken;
  joinTokenB = setup.teams[1]!.joinToken;
  teamAId = setup.teams[0]!.id;
  teamBId = setup.teams[1]!.id;
});

afterEach(async () => {
  await srv.close();
  for (const f of writtenFiles) await rm(f, { force: true });
  writtenFiles.length = 0;
  // Montage posters persist under the real public dir (gameId subdir) —
  // remove the whole game's montage tree so tests leave no artifacts.
  if (gameId) await rm(path.join(DEFAULT_MONTAGE_DIR, gameId), { recursive: true, force: true });
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
function waitFor<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
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

  it("(c2) browser-style: session for team A + team B's link token → ack ok with team B identity (link wins)", async () => {
    // 1. Join team A (session token acts as the browser's cc_session cookie).
    const first = connect();
    const firstAck = await emitAck<{
      identity: { playerId: string; sessionToken: string; teamId: string };
    }>(first, "join", { role: "player", joinToken: joinTokenA, nickname: "Alex" });
    expect(firstAck.identity.teamId).toBe(teamAId);
    first.close();

    // 2. Same browser (session token now in the handshake "cookie") opens
    //    team B's join link: the client sends BOTH tokens. The server must
    //    honor the LINK and create a fresh player in team B (old player row
    //    untouched) — never land the user back on team A.
    const second = connect({ sessionToken: firstAck.identity.sessionToken });
    const secondSync = waitFor<Record<string, unknown>>(second, "sync:full");
    const ack2 = await emitAck<{
      ok: boolean;
      identity?: { playerId: string; teamId: string; nickname: string; sessionToken: string };
    }>(second, "join", {
      role: "player",
      joinToken: joinTokenB,
      nickname: "Alex",
      sessionToken: firstAck.identity.sessionToken,
    });
    const sync2 = await secondSync;

    expect(ack2.ok).toBe(true);
    expect(ack2.identity!.teamId).toBe(teamBId);
    expect(ack2.identity!.playerId).not.toBe(firstAck.identity.playerId); // NEW player
    expect(ack2.identity!.sessionToken).not.toBe(firstAck.identity.sessionToken);
    // Nickname is auto-suffixed: the old team-A row keeps "Alex" (it is
    // deliberately untouched) and gameId+nickname is unique, so the fresh
    // team-B player becomes "Alex 2" (same as the hub-level test).
    expect(ack2.identity!.nickname).toBe("Alex 2");
    // The sync:full snapshot shows the player as a member of team B only.
    const teamB = (sync2.teams as Array<Record<string, unknown>>).find(
      (t) => t.id === teamBId,
    ) as Record<string, unknown>;
    expect((teamB.members as Array<{ id: string }>).map((m) => m.id)).toContain(
      ack2.identity!.playerId,
    );
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

  it("(f) prompt with too many words → ack ok:false reason 'too_many_words'", async () => {
    const socket = connect();
    await emitAck(socket, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Alex",
    });

    // MAX_PROMPT_WORDS + 1 words — rejected by the shared word-count rules
    // BEFORE any hub/phase logic runs.
    const words = Array.from({ length: MAX_PROMPT_WORDS + 1 }, (_, i) => `w${i}`).join(" ");
    const ack = await emitAck<{ ok: boolean; reason?: string; count?: number }>(
      socket,
      "player:submitPrompt",
      { text: words },
    );
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("too_many_words");
    expect(ack.count).toBe(MAX_PROMPT_WORDS + 1);
    socket.close();
  });

  it("(g) whitespace-only prompt → ack ok:false reason 'empty_prompt'", async () => {
    const socket = connect();
    await emitAck(socket, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Alex",
    });

    const ack = await emitAck<{ ok: boolean; reason?: string }>(
      socket,
      "player:submitPrompt",
      { text: "   " },
    );
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("empty_prompt");
    socket.close();
  });

  it("(h) GM of game A cannot kick a player of game B → reason 'wrong_game'", async () => {
    // A second, independent game with its own player.
    const other = await srv.hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    const outsider = connect();
    const outsiderAck = await emitAck<{ identity: { playerId: string } }>(outsider, "join", {
      role: "player",
      joinToken: other.teams[0]!.joinToken,
      nickname: "Outsider",
    });
    const outsiderId = outsiderAck.identity.playerId;

    // GM of game A (created in beforeEach) tries to kick that player.
    const gm = connect({ role: "gm" });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });
    const ack = await emitAck<{ ok: boolean; reason?: string }>(gm, "gm:kick", {
      playerId: outsiderId,
    });
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("wrong_game");

    // The victim is untouched (not soft-kicked).
    expect(await srv.hub.isKicked(outsiderId)).toBe(false);
    outsider.close();
    gm.close();
  });

  it("(i) gm:kick of an own-game player evicts the victim's socket", async () => {
    const gm = connect({ role: "gm" });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

    const victim = connect();
    const victimAck = await emitAck<{ identity: { playerId: string } }>(victim, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Victim",
    });

    const disconnected = new Promise<void>((resolve) => {
      victim.on("disconnect", () => resolve());
    });

    const ack = await emitAck<{ ok: boolean }>(gm, "gm:kick", {
      playerId: victimAck.identity.playerId,
    });
    expect(ack.ok).toBe(true);

    // The server force-disconnects the victim's socket.
    await disconnected;
    gm.close();
  });

  // 15s: the critique buffer alone adds ~5s behind the ~2.5s build pipeline.
  it("(j) build flow end-to-end: submit → item:pending → item:ready → layout:updated", { timeout: 15_000 }, async () => {
    // Theme is auto-set at creation time via the hub (the GM console does this
    // right after creating a game) — moves LOBBY → GREETINGS so players may
    // join before approval.
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Balloon party", now: Date.now() });

    // REAL image path: the default memory image queue + the real
    // createItemImageHandler — createServer wires both automatically whenever
    // `ai` is passed (see registerSocketHandlers; no REDIS_URL in tests →
    // memory queue). The mock provider draws a real PNG (@napi-rs/canvas),
    // so an actual file lands in public/static/items/{itemId}.png.
    const gm = connect({ role: "gm", gameCode });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

    const maya = connect();
    const mayaAck = await emitAck<{ ok: boolean; identity: { teamId: string } }>(maya, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Maya",
    });
    expect(mayaAck.ok).toBe(true);
    const teamId = mayaAck.identity.teamId;

    // Register listeners BEFORE the submit so nothing is missed. layout:updated
    // needs extra headroom: the debouncer trails by 1.5s after item:ready.
    // layout:critique trails the layout commit by the 5s critique buffer (mock
    // mode short-circuits the vision call, so no render/AI latency on top).
    const pendingPromise = waitFor<Record<string, unknown>>(gm, "item:pending");
    const readyPromise = waitFor<Record<string, unknown>>(gm, "item:ready", 8_000);
    const layoutPromise = waitFor<Record<string, unknown>>(gm, "layout:updated", 5_000);
    const critiquePromise = waitFor<Record<string, unknown>>(gm, "layout:critique", 8_000);

    const approve = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:approveGreetings", {});
    expect(approve.ok).toBe(true);
    expect(approve.phase).toBe("BUILD");

    const submit = await emitAck<{ ok: boolean; itemId?: string }>(maya, "player:submitPrompt", {
      text: "red balloon",
    });
    expect(submit.ok).toBe(true);
    const itemId = submit.itemId!;
    expect(itemId).toBeTruthy();

    try {
      const pending = await pendingPromise;
      expect(pending).toMatchObject({ itemId, promptRaw: "red balloon", nickname: "Maya", teamId });

      const ready = await readyPromise;
      expect(ready.itemId).toBe(itemId);
      expect(typeof ready.imageUrl).toBe("string");
      expect((ready.imageUrl as string).length).toBeGreaterThan(0);

      const layout = await layoutPromise;
      expect(layout.teamId).toBe(teamId);
      expect(layout.version).toBeGreaterThan(0);
      expect(Array.isArray(layout.placements)).toBe(true);
      expect((layout.placements as unknown[]).length).toBeGreaterThan(0);

      // The vision critique trails the committed layout by the 5s buffer.
      // Mock mode short-circuits: the fixed passing verdict, hub-stamped, and
      // addressed to this team — GM-room only (the player socket must NOT get
      // a second layout:updated re-emit, since the verdict passes).
      const critique = await critiquePromise;
      expect(critique).toMatchObject({
        gameId,
        teamId,
        score: MOCK_CRITIQUE_VERDICT.score,
        issues: MOCK_CRITIQUE_VERDICT.issues,
        focalOk: MOCK_CRITIQUE_VERDICT.focalOk,
      });
      expect(critique.seq).toBeGreaterThan(0);
    } finally {
      // The real handler wrote a real file under the Next public dir — remove
      // it so the test leaves no artifacts behind (force:true tolerates a
      // failed run where no file was ever written).
      await rm(path.join(DEFAULT_ITEMS_DIR, `${itemId}.png`), { force: true });
    }

    maya.close();
    gm.close();
  });

  it("(k) validation reject during BUILD: teammate gets item:withdrawn (never item:rejected); owner gets item:rejected", async () => {
    // Theme moves LOBBY → GREETINGS so players may join, then approval moves
    // GREETINGS → BUILD (see test (j)).
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Balloon party", now: Date.now() });

    // Two players on the SAME team (same joinToken): owner + teammate.
    const owner = connect();
    const ownerAck = await emitAck<{ ok: boolean; identity: { playerId: string; teamId: string } }>(
      owner,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Maya" },
    );
    const teammate = connect();
    const teammateAck = await emitAck<{ ok: boolean; identity: { teamId: string } }>(
      teammate,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Sam" },
    );
    expect(ownerAck.ok).toBe(true);
    expect(teammateAck.ok).toBe(true);
    expect(teammateAck.identity.teamId).toBe(ownerAck.identity.teamId);

    const approve = await hub.applyEvent(gameId, { type: "gm:approveGreetings", now: Date.now() });
    if (!approve.ok) throw new Error(`approveGreetings failed: ${approve.reason}`);
    expect(approve.state.phase).toBe("BUILD");

    // Collect every item:* event on BOTH sockets from before the submit so an
    // unexpected item:rejected cannot slip past unnoticed.
    const ITEM_EVENTS = ["item:pending", "item:rejected", "item:failed", "item:withdrawn"] as const;
    type Seen = { event: string; payload: Record<string, unknown> };
    const ownerSeen: Seen[] = [];
    const teammateSeen: Seen[] = [];
    const track = (sock: Socket, sink: Seen[]) => {
      for (const ev of ITEM_EVENTS) sock.on(ev, (payload: Record<string, unknown>) => sink.push({ event: ev, payload }));
    };
    track(owner, ownerSeen);
    track(teammate, teammateSeen);

    // The mock validation provider rejects "happiness" (a feeling, not a
    // drawable object). Waiters are registered BEFORE the submit — the
    // owner-only event can land on the socket before the ack resolves.
    const rejectedPromise = waitFor<{ reason?: string; exampleFix?: string }>(owner, "item:rejected");
    const withdrawnPromise = waitFor<{ itemId?: string; teamId?: string }>(teammate, "item:withdrawn");
    const submit = await emitAck<{ ok: boolean; reason?: string; exampleFix?: string }>(
      owner,
      "player:submitPrompt",
      { text: "happiness" },
    );
    expect(submit.ok).toBe(false);

    // Owner socket: the private detail — item:rejected with reason + fix.
    const rejected = await rejectedPromise;
    expect(rejected.reason).toContain("feeling");
    expect(typeof rejected.exampleFix).toBe("string");

    // Teammate socket: ONLY the placeholder-cleanup broadcast.
    const withdrawn = await withdrawnPromise;
    expect(withdrawn.itemId).toBeTruthy();
    expect(withdrawn.teamId).toBe(ownerAck.identity.teamId);

    // Small grace period: if a leaked item:rejected were ever going to reach
    // the teammate, it would already be in the buffer (socket.io preserves
    // per-socket ordering and the owner event is emitted FIRST server-side).
    await new Promise((r) => setTimeout(r, 150));
    expect(teammateSeen.map((e) => e.event)).not.toContain("item:rejected");
    expect(teammateSeen.map((e) => e.event)).toEqual(expect.arrayContaining(["item:pending", "item:withdrawn"]));
    // The broadcast carries no reason/exampleFix — nothing leaks.
    const teammateWithdrawn = teammateSeen.find((e) => e.event === "item:withdrawn")!;
    expect(teammateWithdrawn.payload).not.toHaveProperty("reason");
    expect(teammateWithdrawn.payload).not.toHaveProperty("exampleFix");

    // The owner's socket DID get the rejected detail (reason + exampleFix).
    expect(ownerSeen.map((e) => e.event)).toContain("item:rejected");

    owner.close();
    teammate.close();
  });
});

// ---------------------------------------------------------------------------
// Greeting handlers (gm:updateGreeting / gm:regenGreeting) — Step 6 server.
// ---------------------------------------------------------------------------

import { generateGreetingsForGame } from "../flows/greetings";
import type { GreetingRow } from "../repo/repository";

describe("greeting handlers (gm:updateGreeting / gm:regenGreeting)", () => {
  it("sync:full carries teams[].greeting after generation", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Cats", now: Date.now() });
    await generateGreetingsForGame(hub, repo, ai, gameId);

    const gm = connect({ role: "gm", joinToken: gameCode });
    const syncPromise = waitFor<Record<string, unknown>>(gm, "sync:full");
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });
    const sync = await syncPromise;

    const teams = sync.teams as Array<{ greeting?: { text?: string; status?: string } }>;
    expect(teams).toHaveLength(3);
    for (const t of teams) {
      expect(t.greeting?.text).toBeTruthy();
      expect(t.greeting?.status).toBe("proposed");
    }
    gm.close();
  });

  it("gm:updateGreeting persists status 'edited' and emits greeting:updated", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Cats", now: Date.now() });
    const gm = connect({ role: "gm", joinToken: gameCode });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });
    const teams = await repo.listTeams(gameId);

    const updated = waitFor<Record<string, unknown>>(gm, "greeting:updated");
    const ack = await emitAck<{ ok: boolean; status?: string }>(gm, "gm:updateGreeting", {
      teamId: teams[0]!.id,
      text: "  Happy 30th, Sam!  ",
    });
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe("edited");

    const evt = await updated;
    expect(evt).toMatchObject({ teamId: teams[0]!.id, text: "Happy 30th, Sam!", status: "edited" });

    // Persisted (trim applied server-side).
    const rows = await repo.listGreetings(gameId, 1);
    const row = rows.find((g) => g.teamId === teams[0]!.id);
    expect(row?.text).toBe("Happy 30th, Sam!");
    expect(row?.status).toBe("edited");
    gm.close();
  });

  it("gm:regenGreeting returns new text + emits greeting:updated (status proposed)", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Cats", now: Date.now() });
    await generateGreetingsForGame(hub, repo, ai, gameId);
    const teams = await repo.listTeams(gameId);

    const gm = connect({ role: "gm", joinToken: gameCode });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

    const updated = waitFor<Record<string, unknown>>(gm, "greeting:updated");
    const ack = await emitAck<{ ok: boolean; text?: string; status?: string }>(
      gm,
      "gm:regenGreeting",
      { teamId: teams[1]!.id },
    );
    expect(ack.ok).toBe(true);
    expect(ack.text).toBeTruthy();
    expect(ack.status).toBe("proposed");

    const evt = await updated;
    expect(evt).toMatchObject({ teamId: teams[1]!.id, text: ack.text, status: "proposed" });
    const rows = await repo.listGreetings(gameId, 1);
    expect(rows.find((g) => g.teamId === teams[1]!.id)?.text).toBe(ack.text);
    gm.close();
  });

  it("player socket cannot emit gm:updateGreeting → ack forbidden", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Cats", now: Date.now() });
    const player = connect();
    await emitAck(player, "join", { role: "player", joinToken: joinTokenA, nickname: "Alex" });
    const teams = await repo.listTeams(gameId);

    const ack = await emitAck<{ ok: boolean; error?: string }>(player, "gm:updateGreeting", {
      teamId: teams[0]!.id,
      text: "nope",
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("GM only");
    player.close();
  });

  it("GM of game A updating a team of game B → ack ok:false wrong_game", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Cats", now: Date.now() });
    // Second game with its own teams + theme.
    const other = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    await hub.applyEvent(other.game.id, { type: "gm:setTheme", theme: "Dogs", now: Date.now() });

    const gm = connect({ role: "gm", joinToken: gameCode });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

    const ack = await emitAck<{ ok: boolean; reason?: string }>(gm, "gm:updateGreeting", {
      teamId: other.teams[0]!.id,
      text: "cross game",
    });
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("wrong_game");

    const ackRegen = await emitAck<{ ok: boolean; reason?: string }>(gm, "gm:regenGreeting", {
      teamId: other.teams[0]!.id,
    });
    expect(ackRegen.ok).toBe(false);
    expect(ackRegen.reason).toBe("wrong_game");
    gm.close();
  });
});

// ---------------------------------------------------------------------------
// Reconnect / refresh state preservation — regression tests for the bug where
// a page refresh (disconnect → reconnect → join → sync:full) cleared cards on
// GM and player UIs. Round 1 covers a mid-build refresh; round 2 covers a
// refresh after gm:newRound. Both assert the SERVER payload (buildSyncFull)
// AND the client reducer (normalizeSyncFull) keep items + layout.
// ---------------------------------------------------------------------------

describe("reconnect state preservation (refresh regression)", () => {
  /** Drive the game to BUILD with 2 ready items via the exact UI flow. */
  async function buildToReady(player: Socket, player2: Socket) {
    const gm = connect({ role: "gm" });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

    // approveGreetings moves GREETINGS → BUILD
    const approve = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:approveGreetings", {});
    if (!approve.ok) throw new Error(`approveGreetings failed: ${JSON.stringify(approve)}`);

    // listen for ready + layout on the GM socket (GM joins every team room)
    const readyA = waitFor<{ itemId: string }>(gm, "item:ready", 10_000);
    const readyB = waitFor<{ itemId: string }>(gm, "item:ready", 10_000);
    const layoutPromise = waitFor<{ version: number; placements: unknown[] }>(gm, "layout:updated", 10_000);

    const ackA = await emitAck<{ ok: boolean; itemId?: string }>(player, "player:submitPrompt", {
      text: "red balloon",
    });
    if (!ackA.ok) throw new Error(`submit A failed: ${JSON.stringify(ackA)}`);
    const ackB = await emitAck<{ ok: boolean; itemId?: string }>(player2, "player:submitPrompt", {
      text: "blue cake",
    });
    if (!ackB.ok) throw new Error(`submit B failed: ${JSON.stringify(ackB)}`);

    const [rA, rB, layout] = await Promise.all([readyA, readyB, layoutPromise]);
    writtenFiles.push(
      path.join(DEFAULT_ITEMS_DIR, `${rA.itemId}.png`),
      path.join(DEFAULT_ITEMS_DIR, `${rB.itemId}.png`),
    );
    gm.close();
    return { itemIds: [rA.itemId, rB.itemId], layoutVersion: layout.version, placementCount: layout.placements.length };
  }

  it("(r1) player disconnect → reconnect → sync:full keeps items + layout (server + client normalize)", async () => {
    // Theme moves LOBBY → GREETINGS so players may join before approval.
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Balloon party", now: Date.now() });

    // 1. Player joins (the join-link flow: joinToken + nickname).
    const p1 = connect();
    const p1Ack = await emitAck<{ ok: boolean; identity: { playerId: string; sessionToken: string; teamId: string } }>(
      p1,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Maya" },
    );
    expect(p1Ack.ok).toBe(true);
    expect(p1Ack.identity.teamId).toBe(teamAId);

    // 2. GM joins, approve greetings, submit 2 prompts (2 players — 5s
    // per-player cooldown), wait READY + layout.
    const p2helper = connect();
    const p2helperAck = await emitAck<{ ok: boolean }>(p2helper, "join", {
      role: "player",
      joinToken: joinTokenA,
      nickname: "Sam",
    });
    expect(p2helperAck.ok).toBe(true);
    const built = await buildToReady(p1, p2helper);
    expect(built.itemIds).toHaveLength(2);
    expect(built.placementCount).toBeGreaterThan(0);

    // 3. REFRESH: disconnect the player socket, reconnect a FRESH socket.
    const disconnect = new Promise<void>((resolve) => p1.on("disconnect", () => resolve()));
    p1.close();
    await disconnect;

    const p2 = connect({ sessionToken: p1Ack.identity.sessionToken });
    const syncPromise = waitFor<SyncFullEvent>(p2, "sync:full");
    const rejoin = await emitAck<{ ok: boolean; identity: { playerId: string } }>(p2, "join", {
      role: "player",
      sessionToken: p1Ack.identity.sessionToken,
    });
    expect(rejoin.ok).toBe(true);
    expect(rejoin.identity.playerId).toBe(p1Ack.identity.playerId);

    // 4. RAW server payload inspection — buildSyncFull evidence.
    const raw = await syncPromise;
    const teamA = (raw.teams as unknown as Array<Record<string, unknown>>).find((t) => t.id === teamAId)!;
    expect(teamA.items).toHaveLength(2); // ← SERVER evidence
    expect(teamA.layout).not.toBeNull();

    // 5. CLIENT reducer evidence — normalizeSyncFull with myPlayerId.
    const snapshot = normalizeSyncFull(raw, {}, p1Ack.identity.playerId);
    const clientTeam = snapshot.teams.find((t) => t.id === teamAId)!;
    expect(clientTeam.items).toHaveLength(2); // ← CLIENT evidence
    expect(clientTeam.items.every((i) => i.status === "ready")).toBe(true);
    expect(clientTeam.layout).not.toBeNull();
    expect(clientTeam.layout!.placements.length).toBe(built.placementCount);

    // 6. Ledger rebuild: the OWNER's rows must re-enter myItems (Sam's must
    // not — ownership via row.playerId).
    expect(Object.keys(snapshot.myItems).sort()).toEqual([built.itemIds[0]].sort());

    p2helper.close();
    p2.close();
  }, 25_000);

  it("(r2) refresh after gm:newRound → sync:full keeps round-2 items + layout", async () => {
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Balloon party", now: Date.now() });

    const p1 = connect();
    const p1Ack = await emitAck<{ ok: boolean; identity: { playerId: string; sessionToken: string } }>(
      p1,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Maya" },
    );
    expect(p1Ack.ok).toBe(true);
    const p2helper = connect();
    await emitAck(p2helper, "join", { role: "player", joinToken: joinTokenA, nickname: "Sam" });
    await buildToReady(p1, p2helper);

    // Drive to RESULTS then advance to round 2 (hub-level events, like the
    // GM console emits them).
    for (const event of [
      { type: "gm:stopBuild", now: Date.now() },
      { type: "gm:stopScoring", now: Date.now() },
      { type: "gm:pickWinner", teamId: teamAId, now: Date.now() },
      { type: "reveal:ack", now: Date.now() },
      { type: "gm:newRound", now: Date.now() },
    ] as const) {
      const r = await hub.applyEvent(gameId, event);
      if (!r.ok) throw new Error(`${event.type} failed: ${r.reason}`);
    }
    hub.shutdown(); // clear armed timers (untimed config anyway)
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Round two", now: Date.now() });
    const approve = await hub.applyEvent(gameId, { type: "gm:approveGreetings", now: Date.now() });
    if (!approve.ok) throw new Error(`approve failed: ${approve.reason}`);
    expect(approve.state.round).toBe(2);

    // Round-2 submission + ready (from Maya this time; the per-player submit
    // cooldown spans rounds — retry after remainingMs when still cooling).
    const readyPromise = waitFor<{ itemId: string }>(p1, "item:ready", 10_000);
    let submit: { ok: boolean; itemId?: string; remainingMs?: number; reason?: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      submit = await emitAck<{ ok: boolean; itemId?: string; remainingMs?: number; reason?: string }>(
        p1,
        "player:submitPrompt",
        { text: "green frog" },
      );
      if (submit.ok) break;
      if (submit.reason !== "cooldown") break;
      const remaining = submit.remainingMs ?? 5_000;
      await new Promise((r) => setTimeout(r, remaining + 250));
    }
    if (!submit!.ok) throw new Error(`round-2 submit failed: ${JSON.stringify(submit!)}`);
    const ready = await readyPromise;
    writtenFiles.push(path.join(DEFAULT_ITEMS_DIR, `${ready.itemId}.png`));
    // Wait for the round-2 layout to commit (1.5s trailing-edge debounce) —
    // refreshing before it fires would legitimately see layout: null.
    await waitFor<{ version: number }>(p1, "layout:updated", 10_000);

    // Refresh: disconnect → reconnect → sync:full.
    const disconnect = new Promise<void>((resolve) => p1.on("disconnect", () => resolve()));
    p1.close();
    p2helper.close();
    await disconnect;

    const p2 = connect({ sessionToken: p1Ack.identity.sessionToken });
    const syncPromise = waitFor<SyncFullEvent>(p2, "sync:full");
    await emitAck(p2, "join", { role: "player", sessionToken: p1Ack.identity.sessionToken });
    const raw = await syncPromise;
    expect(raw.round).toBe(2);
    const teamA = (raw.teams as unknown as Array<Record<string, unknown>>).find((t) => t.id === teamAId)!;
    expect((teamA.items as unknown[]).length).toBe(1);
    expect(teamA.layout).not.toBeNull();

    const snapshot = normalizeSyncFull(raw, {}, p1Ack.identity.playerId);
    const clientTeam = snapshot.teams.find((t) => t.id === teamAId)!;
    expect(clientTeam.items).toHaveLength(1);
    expect(clientTeam.items[0]!.status).toBe("ready");
    expect(clientTeam.layout).not.toBeNull();
    expect(Object.keys(snapshot.myItems)).toEqual([ready.itemId]);
    p2.close();
  }, 40_000);
});


// ---------------------------------------------------------------------------
// Scoring phase end-to-end (anonymous 1-10 ratings → judging → results).
// Exercises the WS surface: scoring:started (audience-scoped anonymity),
// score:submit acks + guards, live anonymous scores:update, sync:full
// scoring/myScores shapes, then judging:winner → reveal:ack → RESULTS.
// ---------------------------------------------------------------------------

describe("scoring phase end-to-end", () => {
  it("(s1) scoring:started anonymity, submit guards, live averages, judging → RESULTS", { timeout: 15_000 }, async () => {
    // Theme moves LOBBY → GREETINGS so players may join.
    await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Balloon party", now: Date.now() });

    // GM + one player per team (A and B) — the third team stays empty; its
    // card still appears in the scoring order and can be rated.
    const gm = connect({ role: "gm", gameCode });
    await emitAck(gm, "join", { role: "gm", joinToken: gameCode });
    const alex = connect();
    const alexAck = await emitAck<{ ok: boolean; identity: { playerId: string; teamId: string } }>(
      alex,
      "join",
      { role: "player", joinToken: joinTokenA, nickname: "Alex" },
    );
    const sam = connect();
    const samAck = await emitAck<{ ok: boolean; identity: { playerId: string; teamId: string } }>(
      sam,
      "join",
      { role: "player", joinToken: joinTokenB, nickname: "Sam" },
    );
    expect(alexAck.ok).toBe(true);
    expect(samAck.ok).toBe(true);
    expect(alexAck.identity.teamId).toBe(teamAId);
    expect(samAck.identity.teamId).toBe(teamBId);

    const approve = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:approveGreetings", {});
    expect(approve.ok).toBe(true);
    expect(approve.phase).toBe("BUILD");

    // Seed one sized READY item each for teams A and B (owner = the joined
    // player) so those teams take the accumulator's READY path at scoring
    // entry; team C stays itemless → its pass must fail-open to FALLBACK.
    const game = await repo.getGame(gameId);
    for (const ack of [alexAck, samAck]) {
      const item = await repo.createItem({
        teamId: ack.identity.teamId,
        playerId: ack.identity.playerId,
        round: game!.round,
        promptRaw: "seeded poster subject",
        subject: "seeded subject",
        status: "READY",
      });
      await repo.updateItem(item.id, { width: 512, height: 512, visualWeight: 1 });
    }

    // Waiters registered BEFORE gm:stopBuild so nothing is missed.
    const alexStarted = waitFor<{ cards: Array<Record<string, unknown>>; yourTeamCardId?: string | null }>(alex, "scoring:started");
    const samStarted = waitFor<{ cards: Array<Record<string, unknown>>; yourTeamCardId?: string | null }>(sam, "scoring:started");
    const gmStarted = waitFor<{ cards: Array<{ cardId: string; label: string; teamId: string }> }>(gm, "scoring:started");
    // Player-side montage payloads: each seeded team's own montage:updated
    // (team-room broadcast) must arrive with the persisted poster URL + the
    // exact sent prompt (prompt transparency: promptText rides the payload).
    const alexMontage = waitFor<{ teamId: string; status: string; imageUrl?: string | null; promptText?: string | null }>(alex, "montage:updated");
    const samMontage = waitFor<{ teamId: string; status: string; imageUrl?: string | null; promptText?: string | null }>(sam, "montage:updated");

    // Event-order collectors on the gm socket (registered BEFORE gm:stopBuild):
    // montage:started (GM-only heads-up) must precede scoring:started, and —
    // because the mock provider short-circuits the montage LAYOUT pass — there
    // must be NO montage-sourced layout:updated re-emit — the accumulator's
    // montage:generating / montage:updated DO fire (the mock router runs the
    // poster pipeline end-to-end: deterministic + $0).
    const gmEventLog: Array<{
      event: string;
      source?: string;
      teamId?: string;
      status?: string;
      imageUrl?: string;
      promptText?: string | null;
    }> = [];
    const collect = (event: string): void => {
      gm.on(event, (payload: Record<string, unknown>) => {
        gmEventLog.push({
          event,
          source: typeof payload?.source === "string" ? payload.source : undefined,
          teamId: typeof payload?.teamId === "string" ? payload.teamId : undefined,
          status: typeof payload?.status === "string" ? payload.status : undefined,
          imageUrl: typeof payload?.imageUrl === "string" ? payload.imageUrl : undefined,
          promptText:
            typeof payload?.promptText === "string" || payload?.promptText === null
              ? (payload.promptText as string | null)
              : undefined,
        });
      });
    };
    collect("montage:started");
    collect("scoring:started");
    collect("layout:updated");
    collect("montage:generating");
    collect("montage:updated");
    // The accumulator settles asynchronously (fire-and-forget inside the hub's
    // preScoring hook): one montage:updated EMIT per team — 2 READY + 1
    // FALLBACK. (The GM socket joins every team room, so each team-room emit
    // is DELIVERED to the GM socket twice — dedupe by teamId when asserting.)
    const allMontageUpdated = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timeout: montage:updated did not cover all 3 teams")),
        10_000,
      );
      const check = (): void => {
        const teams = new Set(
          gmEventLog.filter((e) => e.event === "montage:updated").map((e) => e.teamId),
        );
        if (teams.size >= 3) {
          clearTimeout(t);
          resolve();
        }
      };
      gm.on("montage:updated", check);
    });

    const stop = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:stopBuild", {});
    expect(stop.ok).toBe(true);
    expect(stop.phase).toBe("SCORING");

    // Player copy: ANONYMOUS cards + which card is their own team's — never
    // a teamId (the card↔team mapping must not reach players).
    const alexCopy = await alexStarted;
    const samCopy = await samStarted;
    expect(alexCopy.cards).toHaveLength(3);
    expect(alexCopy.cards.map((c) => c.label)).toEqual(["Card A", "Card B", "Card C"]);
    for (const c of alexCopy.cards) {
      expect(typeof c.cardId).toBe("string");
      expect(c).not.toHaveProperty("teamId");
    }
    expect(typeof alexCopy.yourTeamCardId).toBe("string");
    expect(alexCopy.cards.some((c) => c.cardId === alexCopy.yourTeamCardId)).toBe(true);
    // Each team's "your card" pointer differs (3 distinct teams → distinct cards).
    expect(typeof samCopy.yourTeamCardId).toBe("string");
    expect(samCopy.yourTeamCardId).not.toBe(alexCopy.yourTeamCardId);

    // GM copy: the full card→team mapping (moderation / judge console).
    const gmCopy = await gmStarted;
    expect(gmCopy.cards).toHaveLength(3);
    for (const c of gmCopy.cards) expect(typeof c.teamId).toBe("string");
    expect(new Set(gmCopy.cards.map((c) => c.teamId))).toEqual(
      new Set((await repo.listTeams(gameId)).map((t) => t.id)),
    );

    // The 3 accumulator passes (2 seeded teams → READY, empty team C →
    // FALLBACK) settle after scoring:started — await them, then assert.
    await allMontageUpdated;

    // Player-side payloads: each seeded team got its own READY montage with
    // the persisted /static URL (the accumulator's team-room broadcast).
    const alexMontagePayload = await alexMontage;
    const samMontagePayload = await samMontage;
    expect(alexMontagePayload.teamId).toBe(teamAId);
    expect(samMontagePayload.teamId).toBe(teamBId);
    for (const p of [alexMontagePayload, samMontagePayload]) {
      expect(p.status).toBe("ready");
      expect(p.imageUrl).toMatch(/^\/static\/montages\//);
    }

    // Ordering: montage:started (GM heads-up) < scoring:started < the
    // accumulator's montage:generating < montage:updated — the hub emits the
    // heads-up, awaits the (non-blocking) preScoring hook, then announces
    // scoring; the accumulator fires after that within the same void async
    // block. AND: no montage-sourced layout:updated was emitted (mock
    // short-circuit for the layout pass — see collector comment above).
    const montageIdx = gmEventLog.findIndex((e) => e.event === "montage:started");
    const scoringIdx = gmEventLog.findIndex((e) => e.event === "scoring:started");
    const generatingIdx = gmEventLog.findIndex((e) => e.event === "montage:generating");
    const updatedIdx = gmEventLog.findIndex((e) => e.event === "montage:updated");
    expect(montageIdx).toBeGreaterThanOrEqual(0);
    expect(scoringIdx).toBeGreaterThan(montageIdx);
    expect(generatingIdx).toBeGreaterThan(scoringIdx);
    expect(updatedIdx).toBeGreaterThan(generatingIdx);
    expect(
      gmEventLog.filter((e) => e.event === "layout:updated" && e.source === "montage"),
    ).toHaveLength(0);

    // Counts + routing (deduped by teamId — see collector note): 2
    // montage:generating heads-ups for the two seeded teams; 3 montage:updated
    // EMITS — 2 READY (A, B) + 1 fail-open FALLBACK for the itemless team C.
    const teamCId = (await repo.listTeams(gameId)).find(
      (t) => t.id !== teamAId && t.id !== teamBId,
    )!.id;
    const generatingTeams = new Set(
      gmEventLog.filter((e) => e.event === "montage:generating").map((e) => e.teamId),
    );
    expect(generatingTeams).toEqual(new Set([teamAId, teamBId]));
    const updated = gmEventLog.filter((e) => e.event === "montage:updated");
    const statusByTeam = new Map<string, string>();
    for (const u of updated) {
      expect(u.teamId).toBeDefined();
      // Every delivery for the same team carries the SAME status (the GM
      // socket's duplicate deliveries come from one emit per team).
      expect(statusByTeam.get(u.teamId!) ?? u.status).toBe(u.status);
      statusByTeam.set(u.teamId!, u.status!);
    }
    expect(new Set(statusByTeam.keys())).toEqual(new Set([teamAId, teamBId, teamCId]));
    expect(statusByTeam.get(teamAId)).toBe("ready");
    expect(statusByTeam.get(teamBId)).toBe("ready");
    expect(statusByTeam.get(teamCId)).toBe("fallback");
    for (const u of updated.filter((e) => e.status === "ready")) {
      expect(u.imageUrl).toMatch(/^\/static\/montages\//);
    }

    // Prompt transparency: every READY montage:updated payload (GM copy AND
    // each player's own) carries a non-empty promptText string — the exact
    // sent image-model prompt. (Team C's FALLBACK payload intentionally has
    // promptText: null — no prompt was ever attempted for the itemless team.)
    for (const u of updated.filter((e) => e.status === "ready")) {
      expect(typeof u.promptText).toBe("string");
      expect(u.promptText!.length).toBeGreaterThan(0);
    }
    for (const p of [alexMontagePayload, samMontagePayload]) {
      expect(typeof p.promptText).toBe("string");
      expect(p.promptText!.length).toBeGreaterThan(0);
    }
    expect(
      updated.find((e) => e.status === "fallback" && e.teamId === teamCId)?.promptText ?? null,
    ).toBeNull();

    const ownCardA = gmCopy.cards.find((c) => c.teamId === teamAId)!.cardId;
    const cardB = gmCopy.cards.find((c) => c.teamId === teamBId)!.cardId;

    // score:submit (ok) → GM receives anonymous scores:update.
    const scoresPromise = waitFor<{ cards: Array<Record<string, unknown>> }>(gm, "scores:update");
    const submit = await emitAck<{ ok: boolean; cardId?: string; score?: number }>(
      alex,
      "score:submit",
      { cardId: cardB, score: 7 },
    );
    expect(submit.ok).toBe(true);
    const scores = await scoresPromise;
    expect(scores.cards).toHaveLength(1);
    expect(scores.cards[0]).toEqual({ cardId: cardB, avg: 7, count: 1 });
    expect(scores.cards[0]).not.toHaveProperty("teamId"); // NEVER leak the mapping

    // Self-vote refused (own_card).
    const selfAck = await emitAck<{ ok: boolean; error?: string; code?: string; reason?: string }>(
      alex,
      "score:submit",
      { cardId: ownCardA, score: 9 },
    );
    expect(selfAck.ok).toBe(false);
    expect(selfAck.reason ?? selfAck.code).toBe("own_card");

    // Re-submission refused (already_rated).
    const again = await emitAck<{ ok: boolean; error?: string; code?: string; reason?: string }>(
      alex,
      "score:submit",
      { cardId: cardB, score: 3 },
    );
    expect(again.ok).toBe(false);
    expect(again.reason ?? again.code).toBe("already_rated");

    // Player resync: sync:full carries the ANONYMOUS scoring shape +
    // cardId-keyed myScores (teamId mapping resolved SERVER-side).
    const resynced = new Promise<SyncFullEvent>((resolve) => alex.once("sync:full", resolve));
    await emitAck(alex, "sync:resync", {});
    const raw = await resynced;
    const scoring = raw.scoring as {
      round: number;
      cards: Array<Record<string, unknown>>;
      yourTeamCardId?: string;
    };
    expect(scoring.round).toBe(1);
    expect(scoring.cards).toHaveLength(3);
    for (const c of scoring.cards) expect(c).not.toHaveProperty("teamId");
    expect(scoring.yourTeamCardId).toBe(alexCopy.yourTeamCardId);
    expect(raw.myScores).toEqual([{ cardId: cardB, value: 7 }]);

    // GM resync: ratedX/ratedY progress + the team mapping.
    const gmResynced = new Promise<SyncFullEvent>((resolve) => gm.once("sync:full", resolve));
    await emitAck(gm, "sync:resync", {});
    const gmRaw = await gmResynced;
    const gmScoring = gmRaw.scoring as {
      round: number;
      cards: Array<{ cardId: string; teamId: string }>;
      ratedX: number;
      ratedY: number;
    };
    expect(gmScoring.ratedX).toBe(1);
    expect(gmScoring.ratedY).toBe(4); // 2 active players × (3 teams − 1)
    expect(new Set(gmScoring.cards.map((c) => c.teamId))).toEqual(
      new Set(gmCopy.cards.map((c) => c.teamId)),
    );

    // The client reducer accepts the new shapes (players see anonymous cards
    // + their own card; the mapping stays server-side).
    const snap = normalizeSyncFull(raw, {}, alexAck.identity.playerId);
    expect(snap.scoring?.cards.every((c) => !("teamId" in c))).toBe(true);
    expect(snap.scoring?.yourTeamCardId).toBe(alexCopy.yourTeamCardId);
    expect(snap.myScores[cardB]).toBe(7);

    // JUDGING: GM picks team A as winner (People's Choice resolves to the
    // only scored team, B). winnerAnnounced carries the public standings.
    const winnerPromise = waitFor<{
      winnerTeamId?: string;
      label?: string | null;
      standings?: Array<{ teamId: string; label: string; cardId: string; avg: number; count: number }>;
      peoplesChoiceTeamId?: string;
    }>(alex, "winnerAnnounced");
    const pick = await emitAck<{ ok: boolean; phase?: string; peoplesChoiceTeamId?: string | null }>(
      gm,
      "judging:winner",
      { teamId: teamAId },
    );
    expect(pick.ok).toBe(true);
    expect(pick.phase).toBe("REVEAL");
    expect(pick.peoplesChoiceTeamId).toBe(teamBId);

    const announced = await winnerPromise;
    expect(announced.winnerTeamId).toBe(teamAId);
    expect(announced.standings).toEqual([
      { teamId: teamBId, label: "B", cardId: cardB, avg: 7, count: 1 },
    ]);
    expect(announced.peoplesChoiceTeamId).toBe(teamBId);

    // REVEAL → RESULTS via reveal:ack (done PROMPTLY: pickWinner armed a real
    // 30s auto-expire timer; srv.close() → hub.shutdown() clears it anyway).
    const reveal = await emitAck<{ ok: boolean; phase?: string }>(gm, "reveal:ack", {});
    expect(reveal.ok).toBe(true);
    expect(reveal.phase).toBe("RESULTS");

    alex.close();
    sam.close();
    gm.close();
  });
});

// ---------------------------------------------------------------------------
// reveal:extend — GM/presenter keep the REVEAL on screen for another 30 s.
// The ack carries { phase, phaseEndsAt } and the reset countdown is visible
// to clients through the next sync:full (sync:resync). Outside REVEAL the
// handler refuses (ok:false) — the state machine is the single gatekeeper.
// ---------------------------------------------------------------------------

describe("reveal:extend (keep the reveal on screen)", () => {
  /** Drive the game LOBBY→…→REVEAL via hub events (pickWinner arms the real
   *  30 s auto-expiry timer — afterEach's srv.close() shuts the hub down). */
  async function createGameInReveal(): Promise<{ id: string; code: string }> {
    const setup = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const teams = await repo.listTeams(setup.game.id);
    const now = Date.now();
    for (const event of [
      { type: "gm:setTheme", theme: "Extend reveal", now },
      { type: "gm:approveGreetings", now },
      { type: "gm:stopBuild", now },
      { type: "gm:stopScoring", now },
      { type: "gm:pickWinner", teamId: teams[0]!.id, now },
    ] as const) {
      const r = await hub.applyEvent(setup.game.id, event);
      if (!r.ok) throw new Error(`${event.type} failed: ${r.reason}`);
    }
    return { id: setup.game.id, code: setup.game.code };
  }

  it("REVEAL: acks ok with phaseEndsAt > before, and resync shows the reset", { timeout: 10_000 }, async () => {
    const { id, code } = await createGameInReveal();
    const before = (await hub.runtimeState(id)).phaseEndsAt ?? 0;

    const gm = connect({ role: "gm", gameCode: code });
    await emitAck(gm, "join", { role: "gm", joinToken: code });

    const extend = await emitAck<{ ok: boolean; phase?: string; phaseEndsAt?: number }>(
      gm,
      "reveal:extend",
      {},
    );
    expect(extend.ok).toBe(true);
    expect(extend.phase).toBe("REVEAL");
    expect(typeof extend.phaseEndsAt).toBe("number");
    // The countdown restarts from the extend time (now + 30 s > old deadline).
    expect(extend.phaseEndsAt!).toBeGreaterThan(before);

    // A client resync sees the SAME reset deadline (the reducer adopts the
    // re-emitted phaseEndsAt; the persisted state carries it too).
    const resynced = new Promise<Record<string, unknown>>((resolve) => gm.once("sync:full", resolve));
    await emitAck(gm, "sync:resync", {});
    const raw = await resynced;
    expect(raw.phase).toBe("REVEAL");
    expect(raw.phaseEndsAt).toBe(extend.phaseEndsAt);

    gm.close();
  });

  it("RESULTS: acks ok:false (extend is REVEAL-only)", { timeout: 10_000 }, async () => {
    const { id, code } = await createGameInReveal();
    const acked = await hub.applyEvent(id, { type: "reveal:ack", now: Date.now() });
    if (!acked.ok) throw new Error(`reveal:ack failed: ${acked.reason}`);
    expect(acked.state.phase).toBe("RESULTS");

    const gm = connect({ role: "gm", gameCode: code });
    await emitAck(gm, "join", { role: "gm", joinToken: code });

    const extend = await emitAck<{ ok: boolean; error?: string; reason?: string }>(
      gm,
      "reveal:extend",
      {},
    );
    expect(extend.ok).toBe(false);

    gm.close();
  });
});
