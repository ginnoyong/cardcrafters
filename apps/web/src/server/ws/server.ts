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

import {
  MAX_PROMPT_WORDS,
  canSubmit,
  gmApproveGreetingsSchema,
  gmKickSchema,
  gmRegenGreetingSchema,
  gmSetThemeSchema,
  gmUpdateGreetingSchema,
  joinSchema,
  promptSubmitSchema,
} from "@cardcrafters/shared";

import type { AiRouter } from "../ai/router";
import { regenerateGreeting } from "../flows/greetings";

import type { GameHub } from "../game/hub";
import type { PlayerRow, Repository, TeamRow } from "../repo/repository";
import { socketAuthMiddleware, type SocketData } from "./auth";
import { gameRoom, gmRoom, presenterRoom, roomsForIdentity, teamRoom, type WsIdentity } from "./rooms";

/** Standard ack shape for every client→server call. */
export type Ack<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code?: string; reason?: string; count?: number };

function ackOk(ack: unknown, payload: Record<string, unknown> = {}): void {
  if (typeof ack === "function") (ack as (res: Ack) => void)({ ok: true, ...payload });
}

function ackFail(ack: unknown, code: string, error: string): void {
  if (typeof ack === "function") (ack as (res: Ack) => void)({ ok: false, error, code });
}

/** Ack failure with a machine-readable reason (+ optional word count). */
function ackFailReason(
  ack: unknown,
  code: string,
  error: string,
  reason: string,
  count?: number,
): void {
  if (typeof ack === "function") {
    (ack as (res: Ack) => void)({ ok: false, error, code, reason, ...(count !== undefined ? { count } : {}) });
  }
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
    // Repo-backed membership (excludes soft-removed players; survives restarts).
    const members = await hub.listTeamMembers(team.id);
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

/** Broadcast `greeting:updated` {teamId, text, status} to the gm + team rooms
 *  with a hub-stamped envelope (direct socket-layer emit, like sync:full). */
function emitGreetingUpdated(
  io: Server,
  hub: GameHub,
  gameId: string,
  payload: { teamId: string; text: string; status: string },
): void {
  const enveloped = { ...hub.stamp(gameId), ...payload };
  io.to(gmRoom(gameId)).emit("greeting:updated", enveloped);
  io.to(teamRoom(gameId, payload.teamId)).emit("greeting:updated", enveloped);
}

/** Register connection-level handlers + auth middleware on the io server.
 *  `ai` is optional for backward compatibility; when omitted the greeting
 *  handlers (gm:updateGreeting / gm:regenGreeting) ack ai_unavailable. */
export function registerSocketHandlers(io: Server, hub: GameHub, repo: Repository, ai?: AiRouter): void {
  io.use(socketAuthMiddleware(repo));

  // playerId → live sockets (kick evicts ALL of a victim's sockets in the game).
  const playerSockets = new Map<string, Set<Socket>>();

  /** Force-disconnect every live socket of a kicked player. */
  function evictPlayerSockets(playerId: string): void {
    const sockets = playerSockets.get(playerId);
    if (!sockets) return;
    for (const s of sockets) {
      s.disconnect(true); // close the underlying connection immediately
    }
    playerSockets.delete(playerId);
  }

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
          // Track the socket for kick eviction.
          const sockets = playerSockets.get(identity.playerId) ?? new Set<Socket>();
          sockets.add(socket);
          playerSockets.set(identity.playerId, sockets);
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
    socket.on("sync:resync", async (raw?: unknown, maybeAck?: unknown) => {
      // Tolerate both call shapes: emit('sync:resync', ack) or
      // emit('sync:resync', payload, ack).
      const ack = typeof raw === "function" ? raw : maybeAck;
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
      // Cheap zod pre-filter (1..200 chars) passed — now enforce the SHARED
      // word-count rules so client and server can never disagree.
      const check = canSubmit(parsed.data.text);
      if (!check.ok) {
        const reason = check.count === 0 ? "empty_prompt" : "too_many_words";
        ackFailReason(
          ack,
          reason,
          reason === "empty_prompt"
            ? "prompt is empty — describe something visible"
            : `prompt has ${check.count} words (max ${MAX_PROMPT_WORDS})`,
          reason,
          check.count,
        );
        return;
      }
      try {
        // Kicked players must not be able to mutate the game even if their
        // socket survived (or re-connected before eviction).
        if (await hub.isKicked(identity.playerId)) {
          ackFailReason(ack, "kicked", "you were removed from this game", "kicked");
          return;
        }
        const result = await hub.applyEvent(identity.gameId, {
          type: "player:submitPrompt",
          playerId: identity.playerId,
          text: parsed.data.text,
          now: Date.now(),
        });
        if (result.ok) ackOk(ack);
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "submit_failed", err instanceof Error ? err.message : "submit failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:setTheme — GM-only; LOBBY→GREETINGS (or re-propose in GREETINGS).
    // ---------------------------------------------------------------------
    socket.on("gm:setTheme", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmSetThemeSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", `invalid theme payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "gm:setTheme",
          theme: parsed.data.theme,
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "theme_failed", err instanceof Error ? err.message : "setTheme failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:approveGreetings — GM approves greetings → BUILD (arms the BUILD
    // timer when configured). Greeting generation itself lands in Step 6; for
    // now approval simply moves the game to BUILD with no generation yet.
    // ---------------------------------------------------------------------
    socket.on("gm:approveGreetings", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmApproveGreetingsSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid approve payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "gm:approveGreetings",
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "approve_failed", err instanceof Error ? err.message : "approveGreetings failed");
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
        // Authorization: the GM may only kick players of THEIR OWN game.
        const target = await repo.getPlayer(parsed.data.playerId);
        if (!target) {
          ackFail(ack, "kick_failed", "player not found");
          return;
        }
        if (target.gameId !== identity.gameId) {
          ackFailReason(ack, "wrong_game", "player belongs to a different game", "wrong_game");
          return;
        }
        if (target.removedAt !== null) {
          ackOk(ack); // already kicked — idempotent
          return;
        }
        // Hub kick: persists removedAt, clears presence, broadcasts
        // player:left {reason:'kick'}; then evict the victim's live sockets.
        await hub.kickPlayer(target.id);
        evictPlayerSockets(target.id);
        ackOk(ack);
      } catch (err) {
        ackFail(ack, "kick_failed", err instanceof Error ? err.message : "kick failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:updateGreeting — GM hand-edits one team's greeting text. Persists
    // status "edited" and broadcasts greeting:updated to gm + team rooms.
    // ---------------------------------------------------------------------
    socket.on("gm:updateGreeting", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmUpdateGreetingSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", `invalid greeting payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        return;
      }
      try {
        // Own-game-only: resolve the team through THIS game's team list.
        const teams = await repo.listTeams(identity.gameId);
        const team = teams.find((t) => t.id === parsed.data.teamId);
        if (!team) {
          ackFailReason(ack, "team_mismatch", "team belongs to a different game", "wrong_game");
          return;
        }
        const state = await hub.runtimeState(identity.gameId);
        const text = parsed.data.text.trim();
        // Server-side revalidation after trim (schema already trimmed, but
        // belt-and-braces per the plan).
        if (text.length < 1 || text.length > 60) {
          ackFail(ack, "invalid_payload", "greeting text must be 1..60 characters");
          return;
        }
        try {
          await repo.updateGreeting(team.id, state.round, { text, status: "edited" });
        } catch {
          // No row for [teamId, round] yet → create it as edited.
          await repo.createGreeting({ teamId: team.id, round: state.round, text, status: "edited" });
        }
        ackOk(ack, { teamId: team.id, text, status: "edited" });
        emitGreetingUpdated(io, hub, identity.gameId, { teamId: team.id, text, status: "edited" });
      } catch (err) {
        ackFail(ack, "update_greeting_failed", err instanceof Error ? err.message : "update failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:regenGreeting — GM re-rolls one team's greeting (AI round-trip,
    // awaited inline). Broadcasts greeting:updated with the new text.
    // ---------------------------------------------------------------------
    socket.on("gm:regenGreeting", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmRegenGreetingSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", `invalid regen payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        return;
      }
      if (!ai) {
        ackFail(ack, "ai_unavailable", "AI router not wired into this server");
        return;
      }
      try {
        const teams = await repo.listTeams(identity.gameId);
        if (!teams.some((t) => t.id === parsed.data.teamId)) {
          ackFailReason(ack, "team_mismatch", "team belongs to a different game", "wrong_game");
          return;
        }
        // NOTE: regenerate replaces the text even when the current status is
        // "edited" — regeneration is an explicit GM intent (see flows).
        const text = await regenerateGreeting(hub, repo, ai, identity.gameId, parsed.data.teamId);
        ackOk(ack, { teamId: parsed.data.teamId, text, status: "proposed" });
        emitGreetingUpdated(io, hub, identity.gameId, {
          teamId: parsed.data.teamId,
          text,
          status: "proposed",
        });
      } catch (err) {
        ackFail(ack, "regen_failed", err instanceof Error ? err.message : "regen failed");
      }
    });

    // ---------------------------------------------------------------------
    // disconnect — presence + player:left broadcast.
    // ---------------------------------------------------------------------
    socket.on("disconnect", () => {
      const identity = data.identity;
      if (identity?.role === "player") {
        const sockets = playerSockets.get(identity.playerId);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) playerSockets.delete(identity.playerId);
        }
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
