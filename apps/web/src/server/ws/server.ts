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

import type { StyleDerivation } from "@cardcrafters/shared";
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
import { deriveGameStyle } from "../flows/style";
import { createItemImageHandler, type ItemImageEmit } from "../flows/item-image";
import {
  createLayoutDebouncer,
  computeAndPersistLayout,
  type LayoutEmit,
} from "../layout/engine";
import { createCritiqueScheduler, type CritiqueEmit } from "../layout/critique";
import {
  createPromptPipelineDeps,
  submitPrompt,
  type PromptEmit,
  type PromptSubmitResult,
} from "../flows/prompt-pipeline";
import { createImageQueue } from "../queue/create-image-queue";
import type { ImageQueue } from "../queue/queue";

import type { GameHub } from "../game/hub";
import type { ItemRow, PlayerRow, Repository, TeamRow } from "../repo/repository";
import { socketAuthMiddleware, type SocketData } from "./auth";
import { gameRoom, gmRoom, presenterRoom, roomsForIdentity, teamRoom, type WsIdentity } from "./rooms";

/** Standard ack shape for every client→server call. */
export type Ack<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | {
      ok: false;
      error: string;
      code?: string;
      reason?: string;
      count?: number;
      exampleFix?: string;
      remainingMs?: number;
      /** Actual configured limits (card_full / too_many_inflight acks). */
      maxItems?: number;
      maxInflight?: number;
    };

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

/** Map a typed PromptSubmitResult onto the player:submitPrompt ack.
 *  Codes: phase_ended/before_theme/kicked, cooldown (+remainingMs),
 *  card_full, too_many_inflight, validation (+reason/exampleFix),
 *  moderation, ai_unavailable. */
function mapSubmitAck(ack: unknown, result: PromptSubmitResult): void {
  if (result.ok) {
    ackOk(ack, { itemId: result.itemId });
    return;
  }
  if (typeof ack !== "function") return;
  const reply = ack as (res: Ack) => void;
  switch (result.stage) {
    case "phase":
      reply({ ok: false, error: result.error, code: result.code, reason: result.code });
      return;
    case "cooldown":
      reply({
        ok: false,
        error: `Slow down — try again in ${Math.max(1, Math.ceil(result.remainingMs / 1000))}s`,
        code: "cooldown",
        reason: "cooldown",
        remainingMs: result.remainingMs,
      });
      return;
    case "card_full":
      reply({
        ok: false,
        error: "This card is full — no room for more stickers",
        code: "card_full",
        reason: "card_full",
        maxItems: result.maxItems,
      });
      return;
    case "too_many_inflight":
      reply({
        ok: false,
        error: "You have too many stickers in progress — wait for one to finish",
        code: "too_many_inflight",
        reason: "too_many_inflight",
        maxInflight: result.maxInflight,
      });
      return;
    case "validation":
      reply({
        ok: false,
        error: result.reason,
        code: "validation",
        reason: result.reason,
        ...(result.exampleFix ? { exampleFix: result.exampleFix } : {}),
      });
      return;
    case "moderation":
      reply({ ok: false, error: result.reason, code: "moderation", reason: result.reason });
      return;
    case "ai_unavailable":
      reply({ ok: false, error: result.reason, code: "ai_unavailable", reason: "ai_unavailable" });
      return;
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
    /** Current-round greeting (empty text + null status until generated). */
    greeting: { text: string; status: string | null };
  }>;
  myScores?: Array<{ targetTeamId: string; value: number }>;
}

/**
 * Snapshot privacy filter (buildSyncFull): REJECTED/FAILED/REMOVED rows and
 * their failReasons are OWNER-ONLY intel (the pipeline emits item:rejected /
 * item:failed to the owner's sockets alone), so the full snapshot must not
 * leak them to teammates, the presenter, or other players' future syncs.
 *   - GM (role 'gm') sees ALL rows — moderation duty per the spec (the GM
 *     removes inappropriate items and needs the failure reasons).
 *   - A player sees private rows only when the row is THEIR OWN.
 *   - Presenter (and any unknown identity) sees only non-private rows, like
 *     players.
 * Exported for unit tests so the privacy rule can never drift from the
 * pipeline's owner-only emission promise.
 */
export function filterItemsForIdentity(rows: ItemRow[], identity?: WsIdentity): ItemRow[] {
  if (identity?.role === "gm") return rows;
  const isOwner =
    identity?.role === "player" ? (row: ItemRow) => row.playerId === identity.playerId : () => false;
  return rows.filter(
    (row) =>
      !PRIVATE_ITEM_STATUSES.has(row.status) || isOwner(row),
  );
}

/** Item statuses whose rows/failReasons are private to the owning player. */
const PRIVATE_ITEM_STATUSES = new Set(["REJECTED", "FAILED", "REMOVED"]);

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

  // Per-team greeting for the current round (UI: GM console cards + player
  // waiting screen). Missing row → empty text + null status.
  const greetings = new Map(
    (await repo.listGreetings(gameId, round)).map((g) => [g.teamId, g]),
  );

  const teamSnapshots = [];
  for (const team of teams) {
    // Repo-backed membership (excludes soft-removed players; survives restarts).
    const members = await hub.listTeamMembers(team.id);
    const allItems = await repo.listItems(team.id, round);
    // Privacy: strip other players' REJECTED/FAILED/REMOVED rows (GM sees all).
    // The visible count doubles as the card-capacity usage — the pipeline
    // excludes these same statuses when checking maxItemsPerCard.
    const items = filterItemsForIdentity(allItems, identity);
    const layout = await repo.getLayoutState(team.id, round);
    const greeting = greetings.get(team.id);
    teamSnapshots.push({
      id: team.id,
      name: team.name,
      label: team.label,
      memberCount: members.length,
      members: members.map((p) => ({ id: p.id, nickname: p.nickname, connected: p.connected })),
      itemCount: items.length,
      items,
      layout,
      greeting: { text: greeting?.text ?? "", status: greeting?.status ?? null },
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
export function registerSocketHandlers(
  io: Server,
  hub: GameHub,
  repo: Repository,
  ai?: AiRouter,
  opts: { queue?: ImageQueue } = {},
): { close(): Promise<void> } {
  io.use(socketAuthMiddleware(repo));

  // Per-game style-pack memo: derived ONCE at BUILD start, reused by the
  // image worker for every sticker (theme-consistent look).
  const styleMemo = new Map<string, Promise<StyleDerivation | null>>();
  const getStyle = async (gameId: string): Promise<StyleDerivation | null> => {
    let p = styleMemo.get(gameId);
    if (!p) {
      p = repo
        .getGame(gameId)
        .then((g) => (g?.style as StyleDerivation | null) ?? null)
        .catch(() => null);
      styleMemo.set(gameId, p);
    }
    return p;
  };

  // Prompt pipeline deps — built ONCE per server: the cooldown map and the
  // image queue are process-wide state. Cooldowns are in-memory only, so a
  // server restart resets them (documented in prompt-pipeline.ts). Per-call
  // code spreads `{ ...pipelineDeps, emit }` to attach the socket emitter.
  //
  // QUEUE FLAVOR (step 2): createImageQueue(REDIS_URL) → BullMQ when Redis is
  // configured (docker compose), else the concurrency-limited memory queue
  // (tests, zero-infra). The handler is the real item-image worker; its emit
  // callback is late-bound (queueEmit below) because item:failed must reach
  // the owner's PRIVATE playerSockets map, which is only known after the map
  // exists — the cleanest way to expose it is this closure, NOT a module-
  // level socket registry (two servers can coexist in one test process).
  // Tests may inject their own queue via opts.queue.
  let queueEmit: ItemImageEmit = () => {};
  let ownedQueue: { close(): Promise<void> } | null = null;
  let pipelineDeps: ReturnType<typeof createPromptPipelineDeps> | null = null;
  if (ai) {
    const handler = createItemImageHandler({
      getStyle,
      repo,
      ai,
      emit: (event, payload, ctx) => queueEmit(event, payload, ctx),
    });
    let queue: ImageQueue;
    if (opts.queue) {
      queue = opts.queue; // test-injected — the caller owns its lifecycle
    } else {
      const created = createImageQueue(process.env.REDIS_URL, handler);
      ownedQueue = created; // only close what we created
      queue = created;
    }
    pipelineDeps = createPromptPipelineDeps({ hub, repo, ai, queue });
  }

  // playerId → live sockets (kick evicts ALL of a victim's sockets in the game).
  const playerSockets = new Map<string, Set<Socket>>();

  // Layout engine wiring (build-phase step 3): every item:ready schedules a
  // debounced (1.5s trailing edge) re-layout for the team; the computed layout
  // is emitted `layout:updated` to the team + presenter + GM rooms with a
  // hub-stamped envelope. When `ai` is absent the engine runs solver-only
  // (hints are best-effort and never fail the layout).
  // TODO(layout wiring): GM item removal (gm:removeItem) does not exist yet in
  // this codebase — when it lands it must call layoutDebouncer.schedule here
  // too so the card re-flows after an item leaves.
  const layoutEmit: LayoutEmit = (event, payload, ctx) => {
    // teamId is added for GM/presenter routing (the payload itself is team-
    // agnostic; passthrough schema keeps the extra field on players' sockets).
    const enveloped = { ...hub.stamp(ctx.gameId), teamId: ctx.teamId, ...payload };
    for (const room of [
      teamRoom(ctx.gameId, ctx.teamId),
      presenterRoom(ctx.gameId),
      gmRoom(ctx.gameId),
    ]) {
      io.to(room).emit(event, enveloped);
    }
  };
  // Vision layout critique: after every committed layout:updated emit the
  // critique scheduler arms a trailing 5s buffer per team (bursts re-arm the
  // SAME timer); on fire it renders the card to a PNG, asks the vision model
  // for a verdict and emits `layout:critique` to the GM room ONLY (hub-stamped
  // envelope). Mock mode (no real provider) short-circuits to a fixed passing
  // verdict without rendering or calling the AI. Failures are swallowed —
  // critique problems never break the build flow.
  const critiqueEmit: CritiqueEmit = (event, payload, ctx) => {
    io.to(gmRoom(ctx.gameId)).emit(event, { ...hub.stamp(ctx.gameId), teamId: ctx.teamId, ...payload });
  };
  const critique = createCritiqueScheduler({
    repo,
    ai: ai ?? null,
    mockMode: ai ? ai.isMock() : true,
    emitCritique: critiqueEmit,
    emitLayout: layoutEmit,
  });
  const layoutDebouncer = createLayoutDebouncer(async (ctx) => {
    const computed = await computeAndPersistLayout(
      { repo, ai: ai ?? null, emit: layoutEmit },
      ctx.gameId,
      ctx.teamId,
    );
    // The critique trails the layout commit (never runs on a layout that
    // didn't land).
    if (computed) critique.schedule(ctx);
    return computed;
  });

  // Queue-level emitter: item:ready → hub-stamped broadcast to the TEAM room;
  // item:failed → hub-stamped direct emit to ALL of the owner's live sockets
  // (owner offline → skipped; the state is visible on the next sync:full)
  // PLUS an `item:withdrawn` team broadcast so teammates' "drawing…"
  // placeholder vanishes without leaking the failure detail.
  queueEmit = (event, payload, ctx) => {
    // teamId is added for GM/presenter routing (see layoutEmit above).
    const enveloped = { ...hub.stamp(ctx.gameId), teamId: ctx.teamId, ...payload };
    if (event === "item:failed") {
      const sockets = playerSockets.get(ctx.playerId);
      if (sockets) {
        for (const s of sockets) s.emit(event, enveloped);
      }
      // Owner-only item:failed FIRST (the owner's ledger goes terminal), then
      // the team broadcast that removes the pending placeholder.
      io.to(teamRoom(ctx.gameId, ctx.teamId)).emit("item:withdrawn", {
        ...hub.stamp(ctx.gameId),
        itemId: payload.itemId,
        teamId: ctx.teamId,
      });
      return;
    }
    io.to(teamRoom(ctx.gameId, ctx.teamId)).emit(event, enveloped);
    // The team's card changed → schedule the debounced re-layout.
    layoutDebouncer.schedule({ gameId: ctx.gameId, teamId: ctx.teamId });
  };

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
            // Prefer the payload token (join link page sends BOTH it and the
            // URL's joinToken so the server can arbitrate which wins);
            // fall back to the handshake auth/cookie session token.
            sessionToken: payload.sessionToken ?? data.sessionToken ?? undefined,
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
        // GM/presenter also join every team room so per-team events
        // (item:pending / item:ready) reach the console/board previews.
        // layout:updated already targets the gm/presenter rooms explicitly.
        const teamIds = (await repo.listTeams(game.id)).map((t) => t.id);
        const rooms = roomsForIdentity(identity, teamIds);
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
    // player:submitPrompt — cheap zod + word-count pre-filter here, then the
    // prompt pipeline runs EVERYTHING else (phase/cutoff via the hub guard,
    // cooldown, card capacity, in-flight cap, AI validation + moderation).
    // The pipeline is the ONE owner of Item rows + item events; this handler
    // only wires its emit callback to Socket.IO and maps the typed result
    // onto the ack.
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
      if (!pipelineDeps) {
        ackFail(ack, "ai_unavailable", "AI router not wired into this server");
        return;
      }
      // Kicked players must not be able to mutate the game even if their
      // socket survived (or re-connected before eviction).
      if (await hub.isKicked(identity.playerId)) {
        ackFailReason(ack, "kicked", "you were removed from this game", "kicked");
        return;
      }
      // Emit callback: item:pending / item:withdrawn go to the TEAM room
      // (hub-stamped envelope); owner-only events (item:rejected /
      // item:failed) go direct to ALL of the owning player's live sockets —
      // never the team room.
      const emit: PromptEmit = (event, payload, opts) => {
        const enveloped = { ...hub.stamp(identity.gameId), ...payload };
        if (opts?.toPlayerOnly) {
          const sockets = playerSockets.get(opts.toPlayerOnly);
          if (sockets && sockets.size > 0) {
            for (const s of sockets) s.emit(event, enveloped);
          } else {
            socket.emit(event, enveloped);
          }
          return;
        }
        io.to(teamRoom(identity.gameId, identity.teamId)).emit(event, enveloped);
      };
      try {
        const result = await submitPrompt(
          { ...pipelineDeps, emit },
          { gameId: identity.gameId, playerId: identity.playerId },
          parsed.data.text,
        );
        mapSubmitAck(ack, result);
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
        if (result.ok) {
          ackOk(ack, { phase: result.state.phase });
          // Theme-consistent sticker style: derive ONCE per game at BUILD
          // start (fire-and-forget, non-fatal on failure).
          void deriveGameStyle(hub, repo, ai!, identity.gameId).catch((err: unknown) =>
            console.error(
              "[style] derivation failed:",
              err instanceof Error ? err.message : err,
            ),
          );
        } else ackFailReason(ack, "rejected", result.reason, result.reason);
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

  // Server-shutdown disposer: flush any pending layout computes (they would
  // otherwise be lost) and close the BullMQ worker/queue when the ws layer
  // owns it (memory queues close as a no-op; injected test queues are the
  // caller's to dispose).
  return {
    async close() {
      await layoutDebouncer.flushAll();
      // Critiques are ephemeral GM intel — pending ones are DROPPED on
      // shutdown (dispose clears the timers; it does not flush).
      critique.dispose();
      if (ownedQueue) await ownedQueue.close();
    },
  };
}

/**
 * Wire GM/presenter room names — exported for reuse/tests so room naming
 * never drifts between the ws layer and the hub's Effect execution.
 */
export { gameRoom, gmRoom, presenterRoom, teamRoom };
export type { PlayerRow, TeamRow };
