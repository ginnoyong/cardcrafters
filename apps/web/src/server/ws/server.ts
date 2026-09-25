/**
 * Socket.IO connection handler — the ONLY place client sockets meet the hub.
 *
 * Contract:
 *  - every client→server payload is validated with a shared zod schema; a bad
 *    payload is acked `{ ok: false, error }` and nothing else happens;
 *  - every server→client event carries the standard envelope
 *    `{ gameId, round, ts, seq }` (per-game monotonic seq, resets on hydrate —
 *    documented in hub.ts);
 *  - `join` assigns the identity, joins rooms and acks `{ ok, identity, rooms }`,
 *    then emits `sync:full` to the joining socket only;
 *  - `sync:resync` re-emits the same full snapshot;
 *  - `disconnect` marks the player disconnected and broadcasts `player:left`.
 */

import type { Server, Socket } from "socket.io";

import { joinSchema, promptSubmitSchema, gmKickSchema } from "@cardcrafters/shared";

import type { GameHub } from "../game/hub";
import type { PlayerRow, Repository, TeamRow } from "../repo/repository";
import { socketAuthMiddleware, type SocketData } from "./auth";
import { gameRoom, gmRoom, presenterRoom, roomsForIdentity, teamRoom, type WsIdentity } from "./rooms";

/** Standard ack shape for every client→server call. */
export type Ack<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code?: string };

function ackOk(ack: unknown, payload: Record<string, unknown> = {}): void {
  if (typeof ack === "function") (ack as (res: Ack) => void)({ ok: true, ...payload });
}

function ackFail(ack: unknown, code: string, error: string): void {
  if (typeof ack === "function") (ack as (res: Ack) => void)({ ok: false, error, code });
}

/** Full-state snapshot assembled from the hub + repo (sync:full payload body). */
export interface SyncFullPayload extends Record<string, unknown> {
  gameId: string;
  phase: string;
  round: number;
  theme: string | null;
  config: unknown;
  phaseEndsAt: number | null;
  cutoffAt: number | null;
  scoresLocked: boolean;
  winnerTeamId?: string;
  peoplesChoiceTeamId?: string;
  serverNow: number;
  teams: Array<{
    id: string;
    name: string;
    label: string;
    memberCount: number;
    members: Array<{ id: string; nickname: string; connected: boolean }>;
    itemCount: number;
    items: unknown[];
    layout: unknown;
  }>;
  myScores?: Array<{ targetTeamId: string; value: number }>;
}

/** Build the sync:full body from the hub + repository. */
export async function buildSyncFull(
  hub: GameHub,
  repo: Repository,
  gameId: string,
  identity?: WsIdentity,
): Promise<SyncFullPayload> {
  const state = await hub.getOrCreateHubGame(gameId);
  const round = state.round;
  const teams = await repo.listTeams(gameId);

  const teamSnapshots = [];
  for (const team of teams) {
    const members = hub.listTeamMembers(team.id);
    const items = await repo.listItems(team.id, round);
    const layout = await repo.getLayoutState(team.id, round);
    teamSnapshots.push({
      id: team.id,
      name: team.name,
      label: team.label,
      memberCount: members.length,
      members: members.map((p) => ({ id: p.id, nickname: p.nickname, connected: p.connected })),
      itemCount: items.length,
      items,
      layout,
    });
  }

  let myScores: Array<{ targetTeamId: string; value: number }> | undefined;
  if (identity?.role === "player") {
    const scores = await repo.listScores(gameId, round);
    myScores = scores
      .filter((s) => s.voterPlayerId === identity.playerId)
      .map((s) => ({ targetTeamId: s.targetTeamId, value: s.value }));
  }

  return {
    gameId,
    phase: state.phase,
    round: state.round,
    theme: state.theme ?? null,
    config: state.config,
    phaseEndsAt: state.phaseEndsAt ?? null,
    cutoffAt: state.cutoffAt ?? null,
    scoresLocked: state.scoresLocked,
    winnerTeamId: state.winnerTeamId,
    peoplesChoiceTeamId: state.peoplesChoiceTeamId,
    serverNow: Date.now(),
    teams: teamSnapshots,
    myScores,
  };
}

/** Register connection-level handlers + auth middleware on the io server. */
export function registerSocketHandlers(io: Server, hub: GameHub, repo: Repository): void {
  io.use(socketAuthMiddleware(repo));

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;

    // ---------------------------------------------------------------------
    // join — the one event that grants room membership + an identity.
    // ---------------------------------------------------------------------
    socket.on("join", async (raw: unknown, ack?: unknown) => {
      const parsed = joinSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_join", `invalid join payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        return;
      }
      const payload = parsed.data;
      try {
        if (payload.role === "player") {
          const result = await hub.joinPlayer({
            joinToken: payload.joinToken,
            nickname: payload.nickname,
            sessionToken: data.sessionToken ?? undefined,
          });
          const identity: WsIdentity = {
            role: "player",
            gameId: result.game.id,
            playerId: result.player.id,
            teamId: result.team.id,
            nickname: result.player.nickname,
            sessionToken: result.player.sessionToken,
          };
          data.identity = identity;
          const rooms = roomsForIdentity(identity);
          for (const room of rooms) void socket.join(room);
          ackOk(ack, { identity, rooms });
          const sync = await buildSyncFull(hub, repo, identity.gameId, identity);
          socket.emit("sync:full", { ...sync, ...hub.stamp(identity.gameId) });
          return;
        }

        // GM / presenter: trusted with a valid game code (see auth.ts note).
        const code = payload.joinToken ?? data.gameCode;
        if (!code) {
          ackFail(ack, "game_code_required", "GM/presenter must supply a game code (joinToken or auth.gameCode)");
          return;
        }
        const game = await hub.gameByCode(code);
        if (!game) {
          ackFail(ack, "unknown_code", `no game with code ${code}`);
          return;
        }
        const identity: WsIdentity = { role: payload.role, gameId: game.id, code: game.code };
        data.identity = identity;
        const rooms = roomsForIdentity(identity);
        for (const room of rooms) void socket.join(room);
        ackOk(ack, { identity, rooms });
        const sync = await buildSyncFull(hub, repo, game.id, identity);
        socket.emit("sync:full", { ...sync, ...hub.stamp(game.id) });
      } catch (err) {
        ackFail(ack, "join_failed", err instanceof Error ? err.message : "join failed");
      }
    });

    // ---------------------------------------------------------------------
    // sync:resync — client asks for a fresh full snapshot.
    // ---------------------------------------------------------------------
    socket.on("sync:resync", async (ack?: unknown) => {
      const identity = data.identity;
      if (!identity) {
        ackFail(ack, "not_joined", "join first");
        return;
      }
      try {
        const sync = await buildSyncFull(hub, repo, identity.gameId, identity);
        socket.emit("sync:full", { ...sync, ...hub.stamp(identity.gameId) });
        ackOk(ack);
      } catch (err) {
        ackFail(ack, "sync_failed", err instanceof Error ? err.message : "sync failed");
      }
    });

    // ---------------------------------------------------------------------
    // player:submitPrompt — validated, then run through the hub's guarded
    // transition (phase guard + cutoff live in the state machine).
    // ---------------------------------------------------------------------
    socket.on("player:submitPrompt", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "player") {
        ackFail(ack, "not_joined", "join as a player first");
        return;
      }
      const parsed = promptSubmitSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid prompt payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "player:submitPrompt",
          playerId: identity.playerId,
          text: parsed.data.text,
          now: Date.now(),
        });
        if (result.ok) ackOk(ack);
        else ackFail(ack, "rejected", result.reason);
      } catch (err) {
        ackFail(ack, "submit_failed", err instanceof Error ? err.message : "submit failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:kick — soft-kick a player (repo row kept, player:left broadcast).
    // ---------------------------------------------------------------------
    socket.on("gm:kick", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmKickSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid kick payload");
        return;
      }
      try {
        const kicked = await repo.kickPlayer(parsed.data.playerId, Date.now());
        await hub.markPlayerDisconnected(kicked.id);
        ackOk(ack);
      } catch (err) {
        ackFail(ack, "kick_failed", err instanceof Error ? err.message : "kick failed");
      }
    });

    // ---------------------------------------------------------------------
    // disconnect — presence + player:left broadcast.
    // ---------------------------------------------------------------------
    socket.on("disconnect", () => {
      const identity = data.identity;
      if (identity?.role === "player") {
        void hub.markPlayerDisconnected(identity.playerId).catch((err) =>
          console.error(`[ws] failed to mark ${identity.playerId} disconnected:`, err),
        );
      }
    });
  });
}

/**
 * Wire GM/presenter room names — exported for reuse/tests so room naming
 * never drifts between the ws layer and the hub's Effect execution.
 */
export { gameRoom, gmRoom, presenterRoom, teamRoom };
export type { PlayerRow, TeamRow };
