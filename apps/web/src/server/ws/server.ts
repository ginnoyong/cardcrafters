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
  PHASE,
  canSubmit,
  gmApproveGreetingsSchema,
  gmKickSchema,
  gmRegenGreetingSchema,
  gmSetThemeSchema,
  gmStopBuildSchema,
  gmStopScoringSchema,
  gmUpdateGreetingSchema,
  joinSchema,
  judgePickSchema,
  promptSubmitSchema,
  revealAckSchema,
  scoreSubmitSchema,
} from "@cardcrafters/shared";

import type { AiRouter } from "../ai/router";
import { regenerateGreeting } from "../flows/greetings";
import { pickPeoplesChoice, submitScore } from "../flows/scoring";
import { deriveGameStyle } from "../flows/style";
import { createItemImageHandler, type ItemImageEmit } from "../flows/item-image";
import {
  createLayoutDebouncer,
  computeAndPersistLayout,
  type LayoutEmit,
} from "../layout/engine";
import { finalizeMontageAll } from "../flows/montage-accumulator";
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
    /** Montage (poster) state — null until the accumulator first runs.
     *  `promptText` rides along for GM snapshots in every phase and for
     *  presenter/player snapshots from JUDGING onward (the shared
     *  TeamJudgeCard accordion reads it; BUILD/SCORING keep it out). */
    montage?: {
      status: string;
      imageUrl?: string;
      promptText?: string;
    } | null;
  }>;
  myScores?: Array<{ cardId: string; value: number }>;
  /**
   * Per-card anonymous running tallies ({cardId, avg, count}) — EVERY role's
   * snapshot (GM, player, presenter) when a scoring order exists for the
   * current round, so any surface's resync (refresh/reconnect) restores the
   * live tallies (scores:update itself stops once scoring locks at JUDGING).
   * Never carries teamId in the tallies — the card→team mapping stays in
   * `scoring.cards`.
   */
  scores?: Array<{ cardId: string; avg: number; count: number }>;
  /**
   * Scoring-order snapshot for the current round — audience-dependent:
   *  - GM: `cards` carry the card→team mapping plus ratedX (scores cast so
   *    far) and ratedY (total expected = activePlayers × (teams − 1));
   *  - players: team-NAMED cards (teamName, per user decision 2a — but still
   *    no teamId) + their own team's cardId;
   *  - presenter: team-NAMED cards (teamName per decision 2a — team names
   *    are public from scoring onward) but still no teamId during SCORING
   *    (the mapping rides along from JUDGING onward) and no yourTeamCardId.
   * The anonymous `scores` tallies ride along for all three audiences.
   * Absent when no scoring order exists for the current round.
   */
  scoring?: {
    round: number;
    cards: Array<{ cardId: string; label: string; teamName?: string; teamId?: string }>;
    yourTeamCardId?: string;
    ratedX?: number;
    ratedY?: number;
  };
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
    // Critique persistence (D3): the persisted verdict rides with the layout
    // so the GM judging view renders the definitive "Layout N/100" from
    // storage (surviving reloads). The payload is per-audience — players and
    // the presenter never receive the critique detail.
    const layoutForIdentity =
      layout && identity?.role !== "gm" ? { ...layout, critique: undefined } : layout;
    // Montage (poster) state — persists with the snapshot so a reload restores
    // READY (poster image URL), FALLBACK, or an in-flight GENERATING status.
    const montage = await repo.getMontageState(team.id, round);
    teamSnapshots.push({
      id: team.id,
      name: team.name,
      label: team.label,
      memberCount: members.length,
      members: members.map((p) => ({ id: p.id, nickname: p.nickname, connected: p.connected })),
      itemCount: items.length,
      items,
      layout: layoutForIdentity,
      greeting: { text: greeting?.text ?? "", status: greeting?.status ?? null },
      montage: montage
        ? {
            status: montage.status.toLowerCase(),
            ...(montage.status === "READY" && montage.imageUrl
              ? { imageUrl: montage.imageUrl }
              : {}),
            // promptText (the EXACT image-model prompt, persisted by the
            // accumulator) is INTERNAL craft detail in BUILD/SCORING — no
            // role's snapshot carries it there. From JUDGING onward it is
            // PUBLIC: the judging stage is team-named (user decision 2a, no
            // anonymity stakes), and the GM console, presenter big screen AND
            // every player's join screen render the shared TeamJudgeCard with
            // the "View prompt" transparency accordion, so all three
            // identities' refresh-surviving snapshots must carry promptText
            // (a player who refreshed mid-JUDGING would otherwise lose it —
            // live montage:updated events only reach sockets connected since
            // BUILD).
            ...((identity?.role === "gm" ||
              ((identity?.role === "presenter" || identity?.role === "player") &&
                [PHASE.JUDGING, PHASE.REVEAL, PHASE.RESULTS].includes(
                  state.phase as (typeof PHASE)[keyof typeof PHASE],
                ))) &&
            montage.promptText
              ? { promptText: montage.promptText }
              : {}),
            // lastError (why the poster fell back) is GM-facing diagnosis,
            // STAYS GM-ONLY in every phase (unlike promptText).
            ...(identity?.role === "gm" && montage.lastError
              ? { lastError: montage.lastError }
              : {}),
          }
        : null,
    });
  }

  let myScores: Array<{ cardId: string; value: number }> | undefined;
  let tallies: Array<{ cardId: string; avg: number; count: number }> | undefined;
  let scoring: SyncFullPayload["scoring"];

  // Scoring section — present only when a scoring order exists for the
  // CURRENT round (stale orders from previous rounds are ignored).
  const gameRow = await repo.getGame(gameId);
  const order = gameRow?.scoringOrder;
  if (order && order.round === round) {
    // Anonymous per-card tallies ({cardId, avg, count}) — computed ONCE for
    // every role (GM, player, presenter): a resync (reconnect / phase
    // change) must restore the live tallies on all surfaces, not just the
    // GM console (the client's normalizeSnapshot would otherwise blank its
    // scores map until the next scores:update). Keyed by cardId ONLY via
    // the scoring order's team→card map — a teamId never rides along, so
    // the player/presenter copies stay as anonymous as the GM's.
    const cardByTeam = new Map(order.cards.map((c) => [c.teamId, c.cardId]));
    const aggregates = await repo.aggregateScores(gameId, round);
    tallies = aggregates.flatMap((a) => {
      const cardId = cardByTeam.get(a.targetTeamId);
      return cardId ? [{ cardId, avg: Math.round(a.avg * 100) / 100, count: a.count }] : [];
    });
    if (identity?.role === "gm") {
      // GM: the full card→team mapping plus progress (ratedX / ratedY) and
      // the anonymous per-card tallies (the judging console must survive a
      // refresh — scores:update stops once scoring locks at JUDGING).
      const scores = await repo.listScores(gameId, round);
      const activePlayers = teamSnapshots.reduce((n, t) => n + t.memberCount, 0);
      scoring = {
        round,
        cards: order.cards.map((c) => ({ cardId: c.cardId, label: c.label, teamId: c.teamId })),
        ratedX: scores.length,
        ratedY: activePlayers * Math.max(0, teams.length - 1),
      };
    } else if (identity?.role === "player") {
      // Players: team-named cards (teamName mirrors beginScoring's player
      // copy — anonymity dropped per user decision 2a; teamId still never
      // leaves the server) + which card is THEIR OWN team's. The anonymous
      // tallies ride along (computed above) so a player's resync restores
      // the live scoreboard too.
      scoring = {
        round,
        cards: order.cards.map((c) => ({
          cardId: c.cardId,
          label: c.label,
          teamName: c.teamName,
        })),
        yourTeamCardId: order.cards.find((c) => c.teamId === identity.teamId)?.cardId,
      };
      // myScores are cardId-keyed for the client — the targetTeamId→cardId
      // mapping happens HERE, server-side, so the raw team id never reaches
      // the player's snapshot.
      const scores = await repo.listScores(gameId, round);
      myScores = scores
        .filter((s) => s.voterPlayerId === identity.playerId)
        .flatMap((s) => {
          const cardId = cardByTeam.get(s.targetTeamId);
          return cardId ? [{ cardId, value: s.value }] : [];
        });
    } else {
      // Presenter (and any unknown identity): team-NAMED cards (teamName
      // per user decision 2a — team names are public from scoring onward,
      // the big screen shows them during the rating stage) + the same
      // anonymous tallies (computed above) — the presenter scoreboard must
      // survive a resync exactly like the GM's and the players'.
      // From JUDGING onward the cards also carry teamId: the judging stage
      // is team-named (the judge card needs teamId to light up its live
      // tally), so the card->team mapping is already public here. During
      // SCORING the teamId mapping stays stripped (only the NAME is public
      // — the tally board stays cardId-keyed).
      const revealMapping = state.phase !== PHASE.SCORING;
      scoring = {
        round,
        cards: order.cards.map((c) => ({
          cardId: c.cardId,
          label: c.label,
          teamName: c.teamName,
          ...(revealMapping ? { teamId: c.teamId } : {}),
        })),
      };
    }
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
    ...(tallies ? { scores: tallies } : {}),
    scoring,
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
  // NOTE: the vision layout-critique scheduler (layout/critique.ts) is no
  // longer wired here — the deterministic solver owns packing quality, and
  // `layout:critique` events are no longer emitted. The module stays as a
  // dormant library (its tests keep passing).
  // Montage (poster) accumulator routing: `montage:generating` is a GM +
  // presenter heads-up (players don't need the in-flight marker — their card
  // just gains the poster later); `montage:updated` goes to EVERYONE — the
  // team that owns the card, the presenter, and the GM (hub-stamped
  // envelope, teamId added for GM/presenter routing like layoutEmit).
  const montageEmit: LayoutEmit = (event, payload, ctx) => {
    const enveloped = { ...hub.stamp(ctx.gameId), teamId: ctx.teamId, ...payload };
    if (event === "montage:generating") {
      for (const room of [presenterRoom(ctx.gameId), gmRoom(ctx.gameId)]) {
        io.to(room).emit(event, enveloped);
      }
      return;
    }
    for (const room of [
      teamRoom(ctx.gameId, ctx.teamId),
      presenterRoom(ctx.gameId),
      gmRoom(ctx.gameId),
    ]) {
      io.to(room).emit(event, enveloped);
    }
  };
  // Post-definition threading: pipelineDeps is created (inside the AI branch)
  // BEFORE montageEmit exists, so the montage accumulator deps are attached
  // here — the prompt pipeline stages every ACCEPTED submission into the
  // team's montage row (stageMontageInput → maybeStart, fire-and-forget) so
  // the poster is already generating (or generated) before scoring entry.
  if (ai && pipelineDeps) {
    pipelineDeps.montageDeps = {
      repo,
      ai,
      mockMode: ai.isMock(),
      emit: montageEmit,
    };
  }
  const layoutDebouncer = createLayoutDebouncer(async (ctx) => {
    const computed = await computeAndPersistLayout(
      { repo, ai: ai ?? null, emit: layoutEmit },
      ctx.gameId,
      ctx.teamId,
    );
    return computed;
  });

  // Final montage pass (final-polish step): runs inside the hub's preScoring
  // hook — after the GM-only `montage:started` heads-up, BEFORE scoring starts.
  // The hook's `round` param is unused: runMontagePass reads the game's current
  // round from the repo itself.
  hub.setPreScoring(async (gameId) => {
    // Fire-and-forget: the montage chain (debounced layout flushes → montage
    // re-layout) must NOT block `scoring:started` — the GM sees the montage
    // heads-up (`montage:started`, already emitted by the hub before this
    // hook) and players get the scoring screen immediately.
    void (async () => {
      await layoutDebouncer.flushAll();
      // NOTE: runMontagePass (the $0.108/call vision strategy pass) is retired
      // from the flow — with the AI poster primary and the deterministic
      // solver owning sticker packing, an AI layout re-arrange of the rarely-
      // seen composed fallback card is spend without payoff. The module stays
      // available (layout/montage.ts) if the fallback polish is ever wanted
      // behind an explicit flag.
      // Poster accumulator: produces the full-bleed poster
      // IMAGE per team (montage_prompt → montage_image → persisted PNG) and
      // emits montage:generating / montage:updated. Unlike the layout-level
      // pass it ALSO runs in mock mode (deterministic + $0), so demo games
      // still get a poster. finalizeMontageAll guarantees ONE last pass over
      // the staged-at-that-moment inputs for teams with a pass still in
      // flight, gens idle teams with un-posted staging, and skips teams that
      // are already current. Fail-open: never breaks scoring.
      await finalizeMontageAll(
        {
          repo,
          ai: ai ?? null,
          mockMode: ai ? ai.isMock() : true,
          emit: montageEmit,
        },
        gameId,
      );
    })().catch((err) => console.warn("montage pass failed", err));
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
            code: result.game.code,
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
      // Greeting lock: edits are only meaningful before the card content is
      // frozen — SCORING+ has baked greetings into posters and locked layouts.
      const greetingPhase = (await hub.runtimeState(identity.gameId)).phase;
      if (greetingPhase !== PHASE.LOBBY && greetingPhase !== PHASE.GREETINGS && greetingPhase !== PHASE.BUILD) {
        ackFailReason(ack, "locked", `greetings are locked in ${greetingPhase}`, "locked");
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
      // Same greeting lock as gm:updateGreeting (edits frozen post-BUILD).
      const regenPhase = (await hub.runtimeState(identity.gameId)).phase;
      if (regenPhase !== PHASE.LOBBY && regenPhase !== PHASE.GREETINGS && regenPhase !== PHASE.BUILD) {
        ackFailReason(ack, "locked", `greetings are locked in ${regenPhase}`, "locked");
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
    // gm:stopBuild — GM ends BUILD early → SCORING (cutoff + scoring order +
    // scoring:started broadcast happen inside the hub's beginScoring effect).
    // ---------------------------------------------------------------------
    socket.on("gm:stopBuild", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmStopBuildSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid stopBuild payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "gm:stopBuild",
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "stop_build_failed", err instanceof Error ? err.message : "stopBuild failed");
      }
    });

    // ---------------------------------------------------------------------
    // gm:stopScoring — GM ends SCORING early → JUDGING (scores lock at
    // entry; the round's Score rows become read-only).
    // ---------------------------------------------------------------------
    socket.on("gm:stopScoring", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "gm") {
        ackFail(ack, "forbidden", "GM only");
        return;
      }
      const parsed = gmStopScoringSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid stopScoring payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "gm:stopScoring",
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "stop_scoring_failed", err instanceof Error ? err.message : "stopScoring failed");
      }
    });

    // ---------------------------------------------------------------------
    // score:submit — player rates ONE anonymous card. The flow (flows/scoring
    // .ts) owns ALL guards (phase → kicked → card resolution → own-card →
    // duplicate → lock); the ack carries the machine-readable stage as both
    // `code` and `reason` so clients can show the right message.
    // ---------------------------------------------------------------------
    socket.on("score:submit", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role !== "player") {
        ackFail(ack, "not_joined", "join as a player first");
        return;
      }
      const parsed = scoreSubmitSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid score payload");
        return;
      }
      // Kicked players must not be able to mutate the game even if their
      // socket survived (or re-connected before eviction) — the flow re-checks
      // this too, but the cheap check here keeps the ack uniform.
      if (await hub.isKicked(identity.playerId)) {
        ackFailReason(ack, "kicked", "you were removed from this game", "kicked");
        return;
      }
      try {
        const result = await submitScore(
          { hub, repo },
          {
            gameId: identity.gameId,
            playerId: identity.playerId,
            cardId: parsed.data.cardId,
            score: parsed.data.score,
          },
        );
        if (result.ok) {
          ackOk(ack, { cardId: parsed.data.cardId, score: parsed.data.score });
        } else {
          ackFailReason(ack, result.stage, result.error, result.stage);
        }
      } catch (err) {
        ackFail(ack, "score_failed", err instanceof Error ? err.message : "score submit failed");
      }
    });

    // ---------------------------------------------------------------------
    // judging:winner — GM picks the winning team. The People's Choice is
    // computed SERVER-SIDE from the round's aggregates (avg desc → count
    // desc → label asc) so the client cannot spoof it. Both picks are
    // persisted + broadcast by the hub's announceWinner effect.
    // ---------------------------------------------------------------------
    socket.on("judging:winner", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      // GM or presenter: the presenter's judging stage carries a Pick winner
      // button (the big screen can crown the winner) — same trust level as
      // reveal:ack. Players are forbidden.
      if (!identity || identity.role === "player") {
        ackFail(ack, "forbidden", "GM or presenter only");
        return;
      }
      const parsed = judgePickSchema.safeParse(raw);
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid winner pick payload");
        return;
      }
      try {
        // Own-game-only: the picked team must belong to THIS game.
        const teams = await repo.listTeams(identity.gameId);
        if (!teams.some((t) => t.id === parsed.data.teamId)) {
          ackFailReason(ack, "team_mismatch", "team belongs to a different game", "wrong_game");
          return;
        }
        const state = await hub.runtimeState(identity.gameId);
        // JUDGING convenience: picking a winner straight from SCORING is
        // valid — the machine requires JUDGING for gm:pickWinner, so the
        // handler bridges by ending SCORING first (scores lock at JUDGING
        // entry; players get the phaseChanged broadcast). From JUDGING this
        // is a no-op.
        if (state.phase === PHASE.SCORING) {
          const stop = await hub.applyEvent(identity.gameId, {
            type: "gm:stopScoring",
            now: Date.now(),
          });
          if (!stop.ok) {
            ackFailReason(ack, "rejected", stop.reason, stop.reason);
            return;
          }
        }
        const peoplesChoice = pickPeoplesChoice(
          await repo.aggregateScores(identity.gameId, state.round),
          teams,
        );
        const result = await hub.applyEvent(identity.gameId, {
          type: "gm:pickWinner",
          teamId: parsed.data.teamId,
          ...(peoplesChoice ? { peoplesChoiceTeamId: peoplesChoice.id } : {}),
          now: Date.now(),
        });
        if (result.ok) {
          ackOk(ack, { phase: result.state.phase, peoplesChoiceTeamId: peoplesChoice?.id ?? null });
        } else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "pick_winner_failed", err instanceof Error ? err.message : "pickWinner failed");
      }
    });

    // ---------------------------------------------------------------------
    // reveal:ack — GM OR presenter acknowledges the reveal → RESULTS (also
    // clears the hub's 30s REVEAL auto-expiry timer).
    // ---------------------------------------------------------------------
    socket.on("reveal:ack", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role === "player") {
        ackFail(ack, "forbidden", "GM or presenter only");
        return;
      }
      const parsed = revealAckSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid reveal ack payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "reveal:ack",
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "reveal_ack_failed", err instanceof Error ? err.message : "reveal ack failed");
      }
    });

    // ---------------------------------------------------------------------
    // reveal:extend — GM OR presenter keeps the reveal on screen for another
    // 30 s (resets the hub's REVEAL auto-expiry timer + re-broadcasts the
    // phase with a fresh phaseEndsAt so every client's countdown resyncs).
    // Empty payload (same shape as reveal:ack — no options).
    // ---------------------------------------------------------------------
    socket.on("reveal:extend", async (raw: unknown, ack?: unknown) => {
      const identity = data.identity;
      if (!identity || identity.role === "player") {
        ackFail(ack, "forbidden", "GM or presenter only");
        return;
      }
      const parsed = revealAckSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        ackFail(ack, "invalid_payload", "invalid reveal extend payload");
        return;
      }
      try {
        const result = await hub.applyEvent(identity.gameId, {
          type: "reveal:extend",
          now: Date.now(),
        });
        if (result.ok) ackOk(ack, { phase: result.state.phase, phaseEndsAt: result.state.phaseEndsAt ?? null });
        else ackFailReason(ack, "rejected", result.reason, result.reason);
      } catch (err) {
        ackFail(ack, "reveal_extend_failed", err instanceof Error ? err.message : "reveal extend failed");
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
