"use client";

/**
 * Client game store — a small React context (no redux) holding the latest
 * `sync:full` snapshot plus incremental live updates (`phase:changed`,
 * `player:joined`, `player:left`, build-phase item/layout events). Every
 * surface (GM console, player waiting screen, presenter) renders from this
 * one shape.
 */

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import { phaseChangedSchema } from "@cardcrafters/shared";

// ---------------------------------------------------------------------------
// Snapshot types (subset of server SyncFullPayload the UI actually renders)
// ---------------------------------------------------------------------------

export interface ClientTeamMember {
  id: string;
  nickname: string;
  connected: boolean;
}

/** Client-side lifecycle of one card item (see shared ItemStatus). */
export type ClientItemStatus = "pending" | "ready" | "rejected" | "failed";

export interface ClientItem {
  id: string;
  promptRaw: string;
  nickname: string;
  /** Submitting player (sync:full rows + the item:pending echo). */
  playerId?: string;
  status: ClientItemStatus;
  imageUrl?: string;
  width?: number;
  height?: number;
  /** REJECTED reason (+ optional AI example fix) / FAILED detail. */
  reason?: string;
  exampleFix?: string;
}

export interface ClientPlacement {
  itemId: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
}

export interface ClientGreetingStyle {
  font?: string;
  color?: string;
  align?: "left" | "center" | "right";
  y?: number;
}

export interface ClientLayout {
  version: number;
  placements: ClientPlacement[];
  greetingStyle?: ClientGreetingStyle;
  source: string;
}

/** One activity-feed entry (newest first, trimmed to ACTIVITY_FEED_MAX). */
export interface ClientActivityEntry {
  itemId: string;
  text: string;
  ts: number;
}

/**
 * THIS player's own submission ledger (owner-only events `item:rejected` /
 * `item:failed` are only ever delivered to the owner, plus the submit ack's
 * itemId). Keyed by itemId; survives sync:full (the full snapshot rows don't
 * carry the exampleFix that owner-only events deliver).
 *
 * ROUND SCOPING: every entry is tagged with the snapshot round it was made
 * in (`round`) — the card is rebuilt fresh each round, so a previous round's
 * rows must never reappear (normalizeSyncFull/selectMyItems prune entries
 * whose round ≠ the snapshot's round).
 */
export interface MyItemEvent {
  promptRaw: string;
  status: ClientItemStatus;
  reason?: string;
  exampleFix?: string;
  /** Snapshot round this entry belongs to (event time / rebuild time). */
  round?: number;
}

export interface ClientTeam {
  id: string;
  name: string;
  label: string;
  memberCount: number;
  members: ClientTeamMember[];
  itemCount: number;
  /** Current-round greeting (""/null until generated or edited). */
  greeting: { text: string; status: string | null };
  /** Build-phase items (any status the client knows about). */
  items: ClientItem[];
  /** Latest committed layout for this team (null until the first READY). */
  layout: ClientLayout | null;
  /** Recent team activity (newest first, max ACTIVITY_FEED_MAX entries). */
  activity: ClientActivityEntry[];
  /** Latest vision layout critique. Prefer the persisted verdict from
   *  sync:full (survives reloads); the live `layout:critique` event updates
   *  it in between snapshots. */
  critique: ClientCritique | null;
  /** Montage (poster) generation state for this team's current round.
   *  null = no montage attempted yet; "generating" = poster in flight;
   *  "ready" = poster image available (montageImageUrl);
   *  "fallback" = generation failed, keep the composed card. */
  montageStatus?: "generating" | "ready" | "fallback" | null;
  /** Poster image URL when montageStatus is "ready". */
  montageImageUrl?: string | null;
  /** Raw sync:full montage section (read off during normalization). */
  montage?: { status: string; imageUrl?: string } | null;
}

/** One vision critique verdict (see shared layoutCritiqueSchema). */
export interface ClientCritique {
  score: number;
  issues: string[];
  focalOk: boolean;
}

/** Safe-unwrap a raw critique blob (from sync:full's persisted layout or a
 *  live event payload) into a typed ClientCritique, or null when the shape
 *  doesn't match. */
export function parseCritique(raw: unknown): ClientCritique | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.score !== "number" ||
    !Number.isFinite(r.score) ||
    !Array.isArray(r.issues) ||
    typeof r.focalOk !== "boolean"
  ) {
    return null;
  }
  return {
    score: r.score,
    issues: r.issues.filter((i): i is string => typeof i === "string"),
    focalOk: r.focalOk,
  };
}

/** One ANONYMOUS card in the round's scoring order ("Card A"…).
 *  `teamId` is present ONLY on GM snapshots (the card↔team mapping is
 *  server/GM-side — player and presenter payloads carry cardId+label only). */
export interface ClientScoringCard {
  cardId: string;
  label: string;
  teamId?: string;
}

/** The SCORING phase slice: the round's anonymous card order. */
export interface ClientScoring {
  round: number;
  cards: ClientScoringCard[];
  /** THIS player's own team's card (players only; null/absent for GM). */
  yourTeamCardId?: string | null;
  /** Server-reported readiness progress (GM snapshots only). */
  ratedX?: number;
  ratedY?: number;
}

/** One card's live anonymous running average (scores:update). */
export interface ClientScoreTally {
  avg: number;
  count: number;
}

/** One public standings row (winnerAnnounced): avg desc → count desc → label asc. */
export interface ClientStanding {
  teamId: string;
  label: string;
  cardId: string;
  avg: number;
  count: number;
}

export interface GameSnapshot {
  gameId: string;
  phase: string;
  round: number;
  theme: string | null;
  /** Configured BUILD timer in seconds (from CardConfig; null = not sent).
   *  0 means untimed — the GM ends the phase manually. */
  buildTimerSeconds?: number | null;
  /** Configured SCORING timer in seconds (0 = untimed). */
  scoringTimerSeconds?: number | null;
  phaseEndsAt: number | null;
  cutoffAt: number | null;
  scoresLocked: boolean;
  serverNow: number;
  teams: ClientTeam[];
  /** SCORING: the round's anonymous card order (+ GM team mapping when the
   *  snapshot is the GM's). Null before scoring starts / after a new round. */
  scoring: ClientScoring | null;
  /** Live anonymous running averages (scores:update), keyed by cardId. */
  scores: Record<string, ClientScoreTally>;
  /** THIS player's submitted ratings (cardId → 1..10). GM/presenter: empty. */
  myScores: Record<string, number>;
  /** RESULTS: the GM's winning pick + the crowd's People's Choice. */
  winnerTeamId: string | null;
  peoplesChoiceTeamId: string | null;
  /** Public standings rows from winnerAnnounced (already server-sorted). */
  standings: ClientStanding[];
  /** Owner-only submission ledger (see MyItemEvent). */
  myItems: Record<string, MyItemEvent>;
  /** THIS client's player id (client-only; null for GM/presenter sockets). */
  myPlayerId: string | null;
  /** Monotonic render-version used to cache-bust the scoring-card PNG URL
   *  (bumped on layout/scoring phase changes → `&v=N` forces a re-fetch). */
  cardVersion: number;
}

/** Max entries kept per team's activity feed (newest first). */
export const ACTIVITY_FEED_MAX = 30;

/**
 * Shape of a `sync:full` payload AS IT ARRIVES OVER THE WIRE (raw, untrusted
 * JSON — the scoring section is audience-dependent and myScores is an array,
 * not yet the client Record). normalizeSnapshot parses every field below;
 * the validated client shape is GameSnapshot.
 */
export interface SyncFullEvent
  extends Omit<
    GameSnapshot,
    | "scoring"
    | "scores"
    | "myScores"
    | "winnerTeamId"
    | "peoplesChoiceTeamId"
    | "standings"
    | "cardVersion"
  > {
  seq?: number;
  ts?: number;
  /** Raw scoring section (GM: teamId mapping + ratedX/ratedY; players:
   *  anonymous cards + yourTeamCardId; presenter: anonymous cards only). */
  scoring?: unknown;
  /** Raw per-card tallies broadcast on scores:update. */
  scores?: unknown;
  /** Raw cardId-keyed ratings array ({cardId, value}) — players only. */
  myScores?: unknown;
  /** Raw winner / People's Choice team ids (RESULTS). */
  winnerTeamId?: unknown;
  peoplesChoiceTeamId?: unknown;
  /** Raw public standings rows (already server-sorted). */
  standings?: unknown;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type StoreAction =
  // sync:full carries the player's id (when known) so the owner ledger can
  // be rebuilt from snapshot rows after a reconnect/resync.
  | { type: "sync:full"; snapshot: SyncFullEvent; myPlayerId?: string }
  | { type: "phaseChanged"; payload: Record<string, unknown> }
  | { type: "playerJoined"; playerId: string; nickname: string; teamId: string }
  | { type: "playerLeft"; playerId: string; kicked: boolean }
  | { type: "greetingUpdated"; teamId: string; text: string; status: string | null; round?: number }
  // Build-phase item/layout events. Each carries the enveloped payload
  // (gameId/round/ts/seq + event fields); reducers guard on round.
  | { type: "itemPending"; payload: Record<string, unknown> }
  | { type: "itemReady"; payload: Record<string, unknown> }
  | { type: "itemRejected"; payload: Record<string, unknown> }
  | { type: "itemFailed"; payload: Record<string, unknown> }
  // Team broadcast when an item goes REJECTED/FAILED: teammates drop the
  // pending placeholder (the owner's private item:rejected/item:failed —
  // which carries the reason — is always delivered BEFORE this broadcast,
  // and the owner's terminal row/ledger must survive it).
  | { type: "itemWithdrawn"; payload: Record<string, unknown> }
  | { type: "layoutUpdated"; payload: Record<string, unknown> }
  // GM-only vision verdict (layout:critique, emitted straight to the GM room):
  // {gameId, round, ts, seq, teamId, score, issues, focalOk}. Stores the
  // LATEST verdict per team (ClientTeam.critique).
  | { type: "critiqueReceived"; payload: Record<string, unknown> }
  // Montage (poster) lifecycle — see montage-accumulator.ts on the server.
  // `montage:generating` → montageStatus "generating" (composed card +
  // "Generating poster…" indicator);
  // `montage:updated` → status ready (render montageImageUrl) or fallback
  // (keep the composed card). Payload is a hub-stamped envelope:
  // {gameId, round, ts, seq, teamId, status, imageUrl?}.
  | { type: "montageGenerating"; payload: Record<string, unknown> }
  | { type: "montageUpdated"; payload: Record<string, unknown> }
  // Placeholder — no server event exists yet (gm:removeItem future work).
  | { type: "itemRemoved"; itemId: string }
  // Submit ack ok: register the new submission in the owner's ledger.
  | { type: "mySubmitted"; itemId: string; promptRaw: string }
  // ---------------------------------------------------------------------
  // Scoring-phase events. scoring:started / scores:update /
  // winnerAnnounced are hub-stamped envelopes; reducers round-guard.
  // ---------------------------------------------------------------------
  | { type: "scoringStarted"; payload: Record<string, unknown> }
  | { type: "scoresUpdated"; payload: Record<string, unknown> }
  | { type: "winnerAnnounced"; payload: Record<string, unknown> }
  // A successful score:submit ack — register THIS player's rating so the
  // JUDGING summary survives re-renders (sync:full rebuilds it on refresh).
  | { type: "myScoreSubmitted"; cardId: string; value: number }
  | { type: "reset" };

// ---------------------------------------------------------------------------
// Build-phase helpers: item status mapping + team-scoped updates
// ---------------------------------------------------------------------------

/** Server ItemStatus → client status union (REMOVED/unknown → null). */
function mapItemStatus(status: unknown): ClientItemStatus | null {
  switch (status) {
    case "PENDING":
    case "VALIDATING":
    case "GENERATING":
    case "pending":
      return "pending";
    case "READY":
    case "ready":
      return "ready";
    case "REJECTED":
    case "rejected":
      return "rejected";
    case "FAILED":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** Apply `fn` to one team; other teams pass through unchanged. */
function withTeam(
  state: GameSnapshot,
  teamId: string,
  fn: (team: ClientTeam) => ClientTeam,
): GameSnapshot {
  return { ...state, teams: state.teams.map((t) => (t.id === teamId ? fn(t) : t)) };
}

/** Upsert one item in a team's list; existing fields the event lacks survive. */
function upsertItem(items: ClientItem[], item: ClientItem): ClientItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) return [...items, item];
  const next = [...items];
  next[idx] = { ...next[idx], ...item };
  return next;
}

/** Envelope round guard for build-phase events; null → drop the event. */
function roundGuard(state: GameSnapshot | null, payload: Record<string, unknown>): GameSnapshot | null {
  const round = Number(payload.round);
  if (state && Number.isFinite(round) && round !== state.round) return null;
  return state;
}

/** Newest-first, capped at ACTIVITY_FEED_MAX. */
function trimActivity(entries: ClientActivityEntry[]): ClientActivityEntry[] {
  return entries.slice(0, ACTIVITY_FEED_MAX);
}

// ---------------------------------------------------------------------------
// Scoring-phase helpers: defensive parsers for the raw event payloads (see
// SyncFullEvent — everything over the wire is untrusted JSON).
// ---------------------------------------------------------------------------

/**
 * Parse a scoring:started / sync:full `cards` array into ClientScoringCard[]
 * (null when the payload is malformed so callers keep their previous state).
 * `teamId` is kept ONLY when present (GM copies) — player/presenter payloads
 * never carry it and the parsed shape mirrors that exactly.
 */
export function parseScoringCards(raw: unknown): ClientScoringCard[] | null {
  if (!Array.isArray(raw)) return null;
  const cards: ClientScoringCard[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.cardId !== "string" || typeof e.label !== "string") return null;
    cards.push({
      cardId: e.cardId,
      label: e.label,
      ...(typeof e.teamId === "string" ? { teamId: e.teamId } : {}),
    });
  }
  return cards;
}

/**
 * Parse a scores:update `cards` array ({cardId, avg, count}) into the client
 * tallies Record keyed by cardId (null when malformed → caller keeps old).
 */
export function parseScoreTallies(raw: unknown): Record<string, ClientScoreTally> | null {
  if (!Array.isArray(raw)) return null;
  const tallies: Record<string, ClientScoreTally> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const avg = Number(e.avg);
    const count = Number(e.count);
    if (typeof e.cardId !== "string" || !Number.isFinite(avg) || !Number.isFinite(count)) {
      return null;
    }
    tallies[e.cardId] = { avg, count };
  }
  return tallies;
}

/**
 * Parse the winnerAnnounced public standings rows (avg desc → count desc →
 * label asc, already server-sorted) — null when malformed → caller keeps old.
 */
export function parseStandings(raw: unknown): ClientStanding[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ClientStanding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const avg = Number(e.avg);
    const count = Number(e.count);
    if (
      typeof e.teamId !== "string" ||
      typeof e.label !== "string" ||
      typeof e.cardId !== "string" ||
      !Number.isFinite(avg) ||
      !Number.isFinite(count)
    ) {
      return null;
    }
    rows.push({ teamId: e.teamId, label: e.label, cardId: e.cardId, avg, count });
  }
  return rows;
}

/** Update THIS player's ledger entry (create when absent). Every entry is
 *  stamped with the CURRENT snapshot round (see MyItemEvent — round scoping
 *  keeps previous rounds' rows from reappearing on the next card). */
function patchMyItems(
  state: GameSnapshot,
  itemId: string,
  fn: (prev: MyItemEvent | undefined) => MyItemEvent,
): GameSnapshot {
  const entry = { ...fn(state.myItems[itemId]), round: state.round };
  return { ...state, myItems: { ...state.myItems, [itemId]: entry } };
}

/** Patch an item in EVERY team that already has it (owner-only events carry
 *  no teamId; there is exactly one such team in practice). */
function patchItemEverywhere(
  state: GameSnapshot,
  itemId: string,
  patch: Partial<ClientItem>,
): GameSnapshot {
  return {
    ...state,
    teams: state.teams.map((team) => ({
      ...team,
      items: team.items.some((i) => i.id === itemId)
        ? team.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i))
        : team.items,
    })),
  };
}

/** Does THIS client own the item? Ownership signals, in order: the event
 *  payload's playerId (item:pending carries the submitter's id), an existing
 *  ledger entry, or a row attributed to me. GM/presenter (myPlayerId null)
 *  own nothing — their ledger must stay empty. Keeping team-wide echoes out
 *  of myItems is what makes "ledger presence" reliable ownership evidence
 *  for selectMyItems ("Your stickers" shows ONLY my prompts). */
function ownsItem(base: GameSnapshot, itemId: string, payloadPlayerId?: unknown): boolean {
  if (base.myPlayerId == null) return false;
  if (payloadPlayerId === base.myPlayerId) return true;
  if (base.myItems[itemId]) return true;
  return base.teams.some((t) =>
    t.items.some((i) => i.id === itemId && i.playerId === base.myPlayerId),
  );
}

export function storeReducer(state: GameSnapshot | null, action: StoreAction): GameSnapshot | null {
  switch (action.type) {
    case "sync:full":
      return normalizeSnapshot(
        action.snapshot,
        state?.myItems ?? {},
        action.myPlayerId ?? null,
        state, // prev snapshot for field-omission preservation (same round only)
      );
    case "phaseChanged": {
      const parsed = phaseChangedSchema.safeParse(action.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const base = state;
      if (!base) return state;
      // `round` is read off the RAW payload (same precedent as `theme`): the
      // parsed schema used to strip it, which froze snapshot.round at 1 so
      // roundGuard dropped EVERY round-2 build event (stuck “drawing…” chips,
      // canvases appearing to clear when a stale round-2 layout finally got
      // accepted). When the payload carries a finite round, adopt it.
      const rawRound = (action.payload as { round?: unknown }).round;
      const nextRound = Number(rawRound);
      const roundChanged = Number.isFinite(nextRound) && nextRound !== base.round;
      // Round BUMP (gm:newRound → a later round): the card is rebuilt FRESH
      // per round — clear all round-scoped state client-side. The teams[]
      // STRUCTURE persists (members, greeting, names); items/layout/activity
      // are per-round and must never carry over. The owner ledger keeps only
      // entries whose round == the new round (see MyItemEvent round scoping).
      const bump = roundChanged && nextRound > base.round;
      if (!roundChanged) {
        return {
          ...base,
          phase: p.phase,
          theme: typeof (action.payload as { theme?: string }).theme === "string"
            ? (action.payload as { theme: string }).theme
            : base.theme,
          phaseEndsAt: p.phaseEndsAt !== undefined ? p.phaseEndsAt : base.phaseEndsAt,
          cutoffAt: p.cutoffAt !== undefined ? p.cutoffAt : base.cutoffAt,
          serverNow: p.serverNow,
          // BUILD→SCORING is where the montage pass re-renders every card —
          // bump so the scoring-card PNG URL cache-busts.
          ...(p.phase === "SCORING" ? { cardVersion: base.cardVersion + 1 } : {}),
        };
      }
      const myItems = bump
        ? Object.fromEntries(
            Object.entries(base.myItems).filter(([, e]) => e.round === nextRound),
          )
        : base.myItems;
      return {
        ...base,
        round: nextRound,
        phase: p.phase,
        theme: typeof (action.payload as { theme?: string }).theme === "string"
          ? (action.payload as { theme: string }).theme
          : base.theme,
        phaseEndsAt: p.phaseEndsAt !== undefined ? p.phaseEndsAt : base.phaseEndsAt,
        cutoffAt: p.cutoffAt !== undefined ? p.cutoffAt : base.cutoffAt,
        serverNow: p.serverNow,
        myItems,
        teams: bump
          ? base.teams.map((team) => ({
              ...team,
              items: [],
              layout: null,
              activity: [],
              critique: null,
              // The montage (poster) is per-round: a fresh round means the
              // previous round's poster state/image must never leak in.
              montageStatus: null,
              montageImageUrl: null,
            }))
          : base.teams,
        // Round-scoped scoring state is cleared on a round BUMP exactly like
        // items/layout — a new round means a new anonymous card order, fresh
        // tallies, and no winner yet (prev rounds' results never leak in).
        ...(bump
          ? {
              scoring: null,
              scores: {},
              myScores: {},
              standings: [],
              winnerTeamId: null,
              peoplesChoiceTeamId: null,
            }
          : {}),
      };
    }
    case "playerJoined": {
      const base = state;
      if (!base) return state;
      return {
        ...base,
        teams: base.teams.map((team) => {
          if (team.id !== action.teamId) return team;
          const exists = team.members.some((m) => m.id === action.playerId);
          return {
            ...team,
            memberCount: exists ? team.memberCount : team.memberCount + 1,
            members: exists
              ? team.members.map((m) =>
                  m.id === action.playerId
                    ? { ...m, nickname: action.nickname, connected: true }
                    : m,
                )
              : [...team.members, { id: action.playerId, nickname: action.nickname, connected: true }],
          };
        }),
      };
    }
    case "playerLeft": {
      const base = state;
      if (!base) return state;
      return {
        ...base,
        teams: base.teams.map((team) => ({
          ...team,
          // Kicks remove the member outright; plain disconnects only dim them.
          members: action.kicked
            ? team.members.filter((m) => m.id !== action.playerId)
            : team.members.map((m) => (m.id === action.playerId ? { ...m, connected: false } : m)),
          memberCount: action.kicked
            ? team.members.filter((m) => m.id !== action.playerId).length
            : team.memberCount,
        })),
      };
    }
    case "greetingUpdated": {
      const base = state;
      if (!base) return state;
      // Round guard: drop stale events from a previous round.
      if (typeof action.round === "number" && action.round !== base.round) return state;
      return {
        ...base,
        teams: base.teams.map((team) =>
          team.id === action.teamId
            ? { ...team, greeting: { text: action.text, status: action.status } }
            : team,
        ),
      };
    }
    // ---------------------------------------------------------------------
    // Build-phase events. All payloads are hub-stamped envelopes
    // ({gameId, round, ts, seq, ...event}); `teamId` is carried on team-room
    // events (and added by the ws layer for layout/ready routed to GMs).
    // ---------------------------------------------------------------------
    case "itemPending": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as {
        itemId?: unknown;
        promptRaw?: unknown;
        nickname?: unknown;
        playerId?: unknown;
        teamId?: unknown;
      };
      if (typeof p.itemId !== "string" || typeof p.teamId !== "string") return state;
      const itemId = p.itemId;
      const promptRaw = typeof p.promptRaw === "string" ? p.promptRaw : "";
      const nickname = typeof p.nickname === "string" ? p.nickname : "?";
      const playerId = typeof p.playerId === "string" ? p.playerId : undefined;
      const next = withTeam(base, p.teamId, (team) => ({
        ...team,
        items: upsertItem(team.items, {
          id: itemId,
          promptRaw,
          nickname,
          ...(playerId ? { playerId } : {}),
          status: "pending",
        }),
        activity: trimActivity([
          { itemId, text: `${nickname} added “${promptRaw}”`, ts: Date.now() },
          ...team.activity.filter((e) => e.itemId !== itemId),
        ]),
      }));
      // Ledger is OWNER-scoped: the team-wide pending echo registers only
      // the submitter's entry (see ownsItem) — teammates must not grow
      // "Your stickers" rows for other people's prompts.
      if (!ownsItem(base, itemId, playerId)) return next;
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? promptRaw,
        status: "pending",
      }));
    }
    case "itemReady": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as {
        itemId?: unknown;
        imageUrl?: unknown;
        width?: unknown;
        height?: unknown;
        teamId?: unknown;
      };
      if (typeof p.itemId !== "string" || typeof p.teamId !== "string") return state;
      const itemId = p.itemId;
      const next = withTeam(base, p.teamId, (team) => {
        const known = team.items.find((i) => i.id === itemId);
        const nickname = known?.nickname ?? "?";
        const promptRaw = known?.promptRaw ?? "";
        return {
          ...team,
          items: upsertItem(team.items, {
            id: itemId,
            promptRaw,
            nickname,
            status: "ready",
            ...(typeof p.imageUrl === "string" ? { imageUrl: p.imageUrl } : {}),
            ...(typeof p.width === "number" && p.width > 0 ? { width: p.width } : {}),
            ...(typeof p.height === "number" && p.height > 0 ? { height: p.height } : {}),
          }),
          activity: trimActivity([
            {
              itemId,
              text: promptRaw
                ? `${nickname}’s “${promptRaw}” is on the card`
                : `A new sticker joined the card`,
              ts: Date.now(),
            },
            ...team.activity.filter((e) => e.itemId !== itemId),
          ]),
        };
      });
      // Ledger is OWNER-scoped (see ownsItem): the owner is identified by
      // their existing ledger entry / an attributed row (item:ready carries
      // no playerId) — teammates' ledgers stay untouched.
      if (!ownsItem(base, itemId)) return next;
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? "",
        status: "ready",
      }));
    }
    // item:rejected / item:failed are OWNER-ONLY events (delivered only to
    // the submitting player's sockets), so any socket that sees them owns the
    // item. The team may be unknown from the event alone → patch every team
    // that has the item (there is exactly one in practice).
    case "itemRejected": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as { itemId?: unknown; reason?: unknown; exampleFix?: unknown };
      if (typeof p.itemId !== "string") return state;
      const itemId = p.itemId;
      const reason = typeof p.reason === "string" ? p.reason : "";
      const exampleFix = typeof p.exampleFix === "string" ? p.exampleFix : undefined;
      const next = patchItemEverywhere(base, itemId, { status: "rejected", reason, exampleFix });
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? "",
        status: "rejected",
        reason,
        exampleFix,
      }));
    }
    case "itemFailed": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as { itemId?: unknown; reason?: unknown };
      if (typeof p.itemId !== "string") return state;
      const itemId = p.itemId;
      const reason = typeof p.reason === "string" ? p.reason : "";
      const next = patchItemEverywhere(base, itemId, { status: "failed", reason });
      if (!ownsItem(base, itemId)) return next;
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? "",
        status: "failed",
        reason,
      }));
    }
    // item:withdrawn — team broadcast when an item goes REJECTED/FAILED (the
    // pipeline/queue emit it right AFTER the owner-only item:rejected /
    // item:failed, so the owner's ledger is already terminal here). Removes
    // the pending placeholder + activity entry for everyone EXCEPT the owner:
    // their ledger keeps the terminal rejected/failed state (with reason /
    // exampleFix) and their row must survive. The ledger itself is NEVER
    // touched — a pending entry (owner-side, rejected detail still in flight)
    // keeps its promptRaw for the owner-only event to overwrite.
    case "itemWithdrawn": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as { itemId?: unknown; teamId?: unknown };
      if (typeof p.itemId !== "string" || typeof p.teamId !== "string") return state;
      const itemId = p.itemId;
      const teamId = p.teamId;
      // Owner-keep rule: the owner-only event already marked the ledger
      // terminal — never delete the owner's row/ledger via the broadcast.
      const mine = base.myItems[itemId];
      if (mine?.status === "rejected" || mine?.status === "failed") return base;
      return withTeam(base, teamId, (team) => ({
        ...team,
        items: team.items.filter((i) => i.id !== itemId),
        activity: team.activity.filter((e) => e.itemId !== itemId),
      }));
    }
    case "layoutUpdated": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as {
        version?: unknown;
        placements?: unknown;
        greetingStyle?: unknown;
        source?: unknown;
        teamId?: unknown;
      };
      const version = Number(p.version);
      if (typeof p.teamId !== "string" || !Number.isFinite(version)) return state;
      const placements = Array.isArray(p.placements)
        ? p.placements.filter(
            (pl): pl is ClientPlacement =>
              pl !== null &&
              typeof pl === "object" &&
              typeof (pl as ClientPlacement).itemId === "string" &&
              Number.isFinite(Number((pl as ClientPlacement).x)) &&
              Number.isFinite(Number((pl as ClientPlacement).y)),
          )
        : [];
      const greetingStyle =
        p.greetingStyle && typeof p.greetingStyle === "object"
          ? (p.greetingStyle as ClientGreetingStyle)
          : undefined;
      const source = typeof p.source === "string" ? p.source : "solver";
      // Cache-bust: the montage pass runs at BUILD→SCORING, so late layout
      // updates can change the final card render — bump so the scoring-card
      // PNG URL re-fetches.
      base.cardVersion += 1;
      return withTeam(base, p.teamId, (team) => {
        // Version guard: older/equal layouts are stale — ignore them.
        if (team.layout && version <= team.layout.version) return team;
        return { ...team, layout: { version, placements, greetingStyle, source } };
      });
    }
    // layout:critique — GM-room-only vision verdict. Payload is a hub-stamped
    // envelope + {teamId, score, issues, focalOk}. Stores the LATEST verdict
    // per team; round-guarded like every build-phase event.
    case "critiqueReceived": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as {
        teamId?: unknown;
        score?: unknown;
        issues?: unknown;
        focalOk?: unknown;
      };
      if (typeof p.teamId !== "string" || !Number.isFinite(Number(p.score))) return state;
      const critique: ClientCritique = {
        score: Number(p.score),
        issues: Array.isArray(p.issues)
          ? p.issues.filter((i): i is string => typeof i === "string")
          : [],
        focalOk: p.focalOk === true,
      };
      return withTeam(base, p.teamId, (team) => ({ ...team, critique }));
    }
    // montage:generating — the montage accumulator started a poster render
    // for this team. Payload is a hub-stamped envelope + {teamId, round}.
    // Sets montageStatus "generating" (renders as the composed card + a
    // small "Generating poster…" indicator); any imageUrl from a previous
    // round-attempt is cleared.
    case "montageGenerating": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as { teamId?: unknown };
      if (typeof p.teamId !== "string") return state;
      return withTeam(base, p.teamId, (team) => ({
        ...team,
        montageStatus: "generating",
        montageImageUrl: null,
      }));
    }
    // montage:updated — the accumulator finished (READY with imageUrl) or
    // fell back (FALLBACK / GENERATING-without-image). Payload is a
    // hub-stamped envelope + {teamId, status, imageUrl?}.
    //   "ready"    → store the poster URL (render replaces the composed card);
    //   "fallback" → clear any stale poster state, keep the composed card.
    case "montageUpdated": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const p = action.payload as { teamId?: unknown; status?: unknown; imageUrl?: unknown };
      if (typeof p.teamId !== "string") return state;
      if (p.status === "ready") {
        if (typeof p.imageUrl !== "string" || p.imageUrl === "") return state;
        return withTeam(base, p.teamId, (team) => ({
          ...team,
          montageStatus: "ready",
          montageImageUrl: p.imageUrl as string,
        }));
      }
      if (p.status === "fallback") {
        return withTeam(base, p.teamId, (team) => ({
          ...team,
          montageStatus: "fallback",
          montageImageUrl: null,
        }));
      }
      return state;
    }
    // Placeholder — no server event (gm:removeItem) exists yet. Removes the
    // item AND its placement so the card re-flows on the next layout.
    case "itemRemoved": {
      const base = state;
      if (!base) return state;
      const itemId = action.itemId;
      // Patch the item FIRST, then derive the layout filter from the patched
      // teams — spreading over base.teams would discard the status patch.
      const patched = patchItemEverywhere(base, itemId, {
        status: "rejected" as const,
        reason: "removed",
      });
      const next = {
        ...patched,
        teams: patched.teams.map((team) => ({
          ...team,
          layout: team.layout
            ? {
                ...team.layout,
                placements: team.layout.placements.filter((pl) => pl.itemId !== itemId),
              }
            : null,
        })),
      };
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? "",
        status: "rejected",
        reason: "removed by the host",
      }));
    }
    case "mySubmitted": {
      const base = state;
      if (!base) return state;
      return patchMyItems(base, action.itemId, (prev) => ({
        promptRaw: action.promptRaw,
        status: prev?.status ?? "pending",
      }));
    }
    // ---------------------------------------------------------------------
    // Scoring-phase events (see StoreAction). scoring:started / scores:update
    // / winnerAnnounced are hub-stamped envelopes; every case round-guards so
    // stale events from a previous round can never mutate this one. myScores
    // / scores / winner state are ROUND-SCOPED: the phaseChanged round-bump
    // branch clears them (like items/layout), so no per-event round stamping
    // is needed beyond the guard.
    // ---------------------------------------------------------------------
    case "scoringStarted": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const cards = parseScoringCards(action.payload.cards);
      if (cards === null) return state; // malformed → keep the old section
      const yourTeamCardId = action.payload.yourTeamCardId;
      // Cache-bust: a fresh scoring order means the montage card render just
      // changed → force the scoring-card PNG to re-fetch.
      base.cardVersion += 1;
      return {
        ...base,
        scoring: {
          round: base.round,
          cards,
          // GM/presenter copies carry no yourTeamCardId (own-card protection
          // only makes sense for a player).
          ...(typeof yourTeamCardId === "string" ? { yourTeamCardId } : {}),
        },
        // A fresh scoring order means a fresh tally — never keep scores from
        // a stale/aborted attempt in the same round.
        scores: {},
      };
    }
    case "scoresUpdated": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const tallies = parseScoreTallies(action.payload.cards);
      if (tallies === null) return state;
      return { ...base, scores: tallies };
    }
    case "winnerAnnounced": {
      const base = roundGuard(state, action.payload);
      if (!base) return state;
      const winnerTeamId = action.payload.winnerTeamId;
      const peoplesChoiceTeamId = action.payload.peoplesChoiceTeamId;
      const standings = parseStandings(action.payload.standings);
      if (typeof winnerTeamId !== "string" || standings === null) return state;
      return {
        ...base,
        winnerTeamId,
        peoplesChoiceTeamId: typeof peoplesChoiceTeamId === "string" ? peoplesChoiceTeamId : null,
        standings,
      };
    }
    case "myScoreSubmitted": {
      const base = state;
      if (!base) return state;
      // The submit ack is always for the CURRENT round (scoring is locked at
      // JUDGING; scores/myScores are cleared on the round bump), so no round
      // stamping is needed — keying by cardId is round-safe.
      return { ...base, myScores: { ...base.myScores, [action.cardId]: action.value } };
    }
    case "reset":
      return null;
    default:
      return state;
  }
}

/**
 * Coerce a raw sync:full payload (unknown JSON) into the client snapshot.
 * `prevMyItems` / `myPlayerId`: when a player id is known, the owner ledger is
 * rebuilt from snapshot rows (which carry playerId) while preserving any
 * event-only detail (exampleFix) from the previous ledger.
 */
export function normalizeSyncFull(
  raw: SyncFullEvent,
  prevMyItems: Record<string, MyItemEvent> = {},
  myPlayerId: string | null = null,
  prev: GameSnapshot | null = null,
): GameSnapshot {
  return normalizeSnapshot(raw, prevMyItems, myPlayerId, prev);
}

function normalizeSnapshot(
  raw: SyncFullEvent,
  prevMyItems: Record<string, MyItemEvent> = {},
  myPlayerId: string | null = null,
  prev: GameSnapshot | null = null,
): GameSnapshot {
  // Prev-preservation: the server may omit fields it didn't need to send
  // (payload size / audience-dependent sync:full variants). When a field is
  // omitted, keep the previous state's value instead of blanking it.
  //  - raw.teams omitted entirely → reuse prev.teams (same round only).
  //  - Per team: t.layout omitted → keep prev team's layout (+ critique).
  //  - Per team: t.items omitted → keep prev team's items.
  // Same-round-only guard: after a round bump the server MUST send the
  // fresh (blank) teams — stale prev data would show last round's cards.
  const prevUsable = prev !== null && prev.round === Number(raw.round ?? 1);
  const prevTeamsById = new Map(
    prevUsable ? prev.teams.map((t) => [t.id, t] as const) : [],
  );
  // raw.teams omitted entirely → the mapped rows below ARE the prev client
  // teams (already normalized); they must be reused verbatim so prev-only
  // fields (critique, …) survive the round-trip.
  const teamsOmitted = !Array.isArray(raw.teams);
  const teams = Array.isArray(raw.teams)
    ? raw.teams
    : prevUsable
      ? prev.teams
      : [];
  const round = Number(raw.round ?? 1);
  // Round-scoped ledger: drop entries from ANY other round (the card is
  // rebuilt fresh each round — stale rows must never reappear). Entries
  // below are re-added when their row is present in this snapshot.
  const myItems: Record<string, MyItemEvent> = {};
  for (const [itemId, entry] of Object.entries(prevMyItems)) {
    if (entry.round === round) myItems[itemId] = entry;
  }
  // Timers ride along inside the server's CardConfig (sync:full always
  // carries `config`); read them off a loose record since SyncFullEvent is
  // the client-facing subset type.
  const config = (raw as unknown as { config?: Record<string, unknown> }).config;
  const timerSecs = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  // ---- Scoring slice (all defensively parsed; the wire shape is
  // ---- audience-dependent, see SyncFullEvent docs).
  const rawScoring = (raw.scoring ?? null) as
    | {
        round?: unknown;
        cards?: unknown;
        yourTeamCardId?: unknown;
        ratedX?: unknown;
        ratedY?: unknown;
      }
    | null;
  const parsedCards = rawScoring ? parseScoringCards(rawScoring.cards) : null;
  let scoring: ClientScoring | null = null;
  if (rawScoring && parsedCards && parsedCards.length > 0) {
    // Scoring-order round: the payload's own round when finite, else the
    // snapshot round (scoring orders are per-round; they always agree).
    const scoringRound = Number.isFinite(Number(rawScoring.round))
      ? Number(rawScoring.round)
      : round;
    scoring = {
      round: scoringRound,
      cards: parsedCards,
      // Players carry their own team's cardId; GM/presenter never do.
      ...(typeof rawScoring.yourTeamCardId === "string"
        ? { yourTeamCardId: rawScoring.yourTeamCardId }
        : {}),
      ...(Number.isFinite(Number(rawScoring.ratedX))
        ? { ratedX: Number(rawScoring.ratedX) }
        : {}),
      ...(Number.isFinite(Number(rawScoring.ratedY))
        ? { ratedY: Number(rawScoring.ratedY) }
        : {}),
    };
  }
  // Live tallies from a scores:update ride along on resync snapshots? No —
  // sync:full never carries `scores`; the map starts empty and rebuilds from
  // the next broadcast (kept defensive anyway).
  const scores = parseScoreTallies(raw.scores) ?? {};
  // THIS player's ratings: the wire carries an array of {cardId, value}
  // (server-side team→card resolution); the client stores a Record.
  const myScores: Record<string, number> = {};
  if (Array.isArray(raw.myScores)) {
    for (const entry of raw.myScores) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const value = Number(e.value);
      if (typeof e.cardId === "string" && Number.isFinite(value)) {
        myScores[e.cardId] = value;
      }
    }
  }
  const winnerTeamId = typeof raw.winnerTeamId === "string" ? raw.winnerTeamId : null;
  const peoplesChoiceTeamId =
    typeof raw.peoplesChoiceTeamId === "string" ? raw.peoplesChoiceTeamId : null;
  const standings = parseStandings(raw.standings) ?? [];
  return {
    gameId: String(raw.gameId),
    phase: String(raw.phase),
    round,
    theme: typeof raw.theme === "string" ? raw.theme : null,
    buildTimerSeconds: timerSecs(config?.buildTimerSeconds),
    scoringTimerSeconds: timerSecs(config?.scoringTimerSeconds),
    phaseEndsAt: typeof raw.phaseEndsAt === "number" ? raw.phaseEndsAt : null,
    cutoffAt: typeof raw.cutoffAt === "number" ? raw.cutoffAt : null,
    scoresLocked: Boolean(raw.scoresLocked),
    serverNow: Number(raw.serverNow ?? Date.now()),
    scoring,
    scores,
    myScores,
    winnerTeamId,
    peoplesChoiceTeamId,
    standings,
    myItems,
    myPlayerId,
    // Cache-bust version: carry the previous snapshot's counter forward (a
    // sync:full itself doesn't re-render the scoring card; the bumps happen
    // on the layout/scoring events below).
    cardVersion: prev?.cardVersion ?? 0,
    teams: teams.map((t) => {
      // Per-team prev-preservation (see prevUsable above): when the server
      // omits a team's layout or items, keep the previous snapshot's values
      // (same round only) instead of blanking them.
      const prevTeam = prevTeamsById.get(String(t.id));
      // raw.teams omitted entirely → the row IS the prev client team (already
      // normalized); reuse it verbatim (see teamsOmitted above).
      if (teamsOmitted && prevTeam) return prevTeam;
      // Raw sync:full rows carry server-only fields (failReason, playerId…)
      // beyond the client shape — read them off a loose record type.
      const items: ClientItem[] = (Array.isArray(t.items) ? t.items : prevTeam?.items ?? []).flatMap((row) => {
        const r = row as unknown as Record<string, unknown>;
        const status = mapItemStatus(r?.status);
        if (!status) return []; // REMOVED and unknown statuses are dropped
        return [
          {
            id: String(r.id ?? ""),
            promptRaw: String(r.promptRaw ?? ""),
            nickname: String(r.nickname ?? "?"),
            ...(typeof r.playerId === "string" ? { playerId: r.playerId } : {}),
            status,
            ...(typeof r.imageUrl === "string" ? { imageUrl: r.imageUrl } : {}),
            ...(typeof r.width === "number" && r.width > 0 ? { width: r.width } : {}),
            ...(typeof r.height === "number" && r.height > 0 ? { height: r.height } : {}),
            ...(typeof r.failReason === "string" && r.failReason
              ? { reason: r.failReason }
              : {}),
          },
        ];
      });
      // Rebuild the owner ledger from rows attributed to me (resync/reconnect
      // path), keeping event-only details (exampleFix) from the old ledger.
      if (myPlayerId) {
        for (const item of items) {
          if (item.playerId !== myPlayerId) continue;
          myItems[item.id] = {
            promptRaw: item.promptRaw,
            status: item.status,
            round, // rebuild is always for the snapshot's round
            ...(item.reason ? { reason: item.reason } : {}),
            ...(prevMyItems[item.id]?.exampleFix
              ? { exampleFix: prevMyItems[item.id]!.exampleFix }
              : {}),
          };
        }
      }
      const layoutRaw = (t.layout === undefined ? prevTeam?.layout : t.layout) as
        | {
            version?: unknown;
            placements?: unknown;
            greetingStyle?: unknown;
            source?: unknown;
            critique?: unknown;
          }
        | null
        | undefined;
      const layout: ClientLayout | null =
        layoutRaw && Number.isFinite(Number(layoutRaw.version)) && Array.isArray(layoutRaw.placements)
          ? {
              version: Number(layoutRaw.version),
              placements: layoutRaw.placements.flatMap((pl) => {
                if (!pl || typeof pl.itemId !== "string") return [];
                return [
                  {
                    itemId: String(pl.itemId),
                    x: Number(pl.x),
                    y: Number(pl.y),
                    scale: Number(pl.scale),
                    rotation: Number(pl.rotation),
                    zIndex: Number(pl.zIndex ?? 0),
                  },
                ];
              }),
              greetingStyle:
                layoutRaw.greetingStyle && typeof layoutRaw.greetingStyle === "object"
                  ? (layoutRaw.greetingStyle as ClientGreetingStyle)
                  : undefined,
              source: typeof layoutRaw.source === "string" ? layoutRaw.source : "solver",
            }
          : null;
      const montageRaw = t.montage ?? prevTeam?.montage;

      let montageStatus: "generating" | "ready" | "fallback" | null = null;
      let montageImageUrl: string | null = null;

      if (typeof montageRaw === "object" && montageRaw !== null) {
        const raw = montageRaw as Record<string, unknown>;
        if (
          raw.status === "generating" ||
          raw.status === "ready" ||
          raw.status === "fallback"
        ) {
          montageStatus = raw.status as "generating" | "ready" | "fallback";
        }
        if (raw.status === "ready" && typeof raw.imageUrl === "string") {
          montageImageUrl = raw.imageUrl as string;
        }
      }
      return {
        id: String(t.id),
        name: String(t.name),
        label: String(t.label),
        memberCount: Number(t.memberCount ?? 0),
        members: (Array.isArray(t.members) ? t.members : []).map((m) => ({
          id: String(m.id),
          nickname: String(m.nickname),
          connected: Boolean(m.connected),
        })),
        itemCount: Number(t.itemCount ?? 0),
        greeting: {
          text: typeof t.greeting?.text === "string" ? t.greeting.text : "",
          status: typeof t.greeting?.status === "string" ? t.greeting.status : null,
        },
        items,
        layout,
        // sync:full is authoritative but activity is event-only → start empty;
        // the live feed rebuilds as events arrive.
        activity: [],
        // Critique persistence (D3): the persisted verdict from the snapshot
        // wins when present; otherwise the field stays null until the next
        // live `layout:critique` event arrives. When layout was omitted (and
        // prev-preserved above), the prev verdict rides along with it.
        critique:
          t.layout === undefined
            ? prevTeam?.critique ?? null
            : parseCritique(layoutRaw?.critique),
        montageStatus,
        montageImageUrl,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface GameStoreValue {
  snapshot: GameSnapshot | null;
  dispatch: React.Dispatch<StoreAction>;
  /** The signed-in player's own id (waiting screen highlights "you"). */
  myPlayerId: string | null;
  setMyPlayerId: (id: string | null) => void;
}

const GameStoreContext = createContext<GameStoreValue | null>(null);

/** Provider: wraps a surface (GM / join / presenter) with the shared store. */
export function GameStoreProvider({
  children,
  myPlayerId: initialMyPlayerId = null,
}: {
  children: ReactNode;
  myPlayerId?: string | null;
}) {
  const [snapshot, dispatch] = useReducer(storeReducer, null);
  const [myPlayerId, setMyPlayerId] = useReducer(
    (_: string | null, next: string | null) => next,
    initialMyPlayerId,
  );
  const value = useMemo<GameStoreValue>(
    () => ({ snapshot, dispatch, myPlayerId, setMyPlayerId }),
    [snapshot, myPlayerId],
  );
  return <GameStoreContext.Provider value={value}>{children}</GameStoreContext.Provider>;
}

/** Access the shared snapshot + dispatch helpers. */
export function useGameStore(): GameStoreValue {
  const ctx = useContext(GameStoreContext);
  if (!ctx) throw new Error("useGameStore must be used inside <GameStoreProvider>");
  return ctx;
}

/** Convenience hook: plain-language phase label (never internal jargon).
 *  LOBBY→"Waiting for players", GREETINGS→"Getting card text ready",
 *  BUILD→"Building the cards", SCORING→"Rate the cards",
 *  JUDGING→"Picking the winner", REVEAL→"The winner is…",
 *  RESULTS→"Results". Unknown phases fall back to a title-cased raw value. */
const PHASE_LABELS: Record<string, string> = {
  LOBBY: "Waiting for players",
  GREETINGS: "Getting card text ready",
  BUILD: "Building the cards",
  SCORING: "Rate the cards",
  JUDGING: "Picking the winner",
  REVEAL: "The winner is…",
  RESULTS: "Results",
};

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return "—";
  return PHASE_LABELS[phase] ?? (phase.charAt(0) + phase.slice(1).toLowerCase());
}