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
  /** Submitting player (from sync:full rows; live item:pending lacks it). */
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
 */
export interface MyItemEvent {
  promptRaw: string;
  status: ClientItemStatus;
  reason?: string;
  exampleFix?: string;
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
}

export interface GameSnapshot {
  gameId: string;
  phase: string;
  round: number;
  theme: string | null;
  phaseEndsAt: number | null;
  cutoffAt: number | null;
  scoresLocked: boolean;
  serverNow: number;
  teams: ClientTeam[];
  /** Owner-only submission ledger (see MyItemEvent). */
  myItems: Record<string, MyItemEvent>;
}

/** Max entries kept per team's activity feed (newest first). */
export const ACTIVITY_FEED_MAX = 30;

/** Shape of a `sync:full` payload as the UI consumes it. */
export interface SyncFullEvent extends GameSnapshot {
  seq?: number;
  ts?: number;
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
  | { type: "layoutUpdated"; payload: Record<string, unknown> }
  // Placeholder — no server event exists yet (gm:removeItem future work).
  | { type: "itemRemoved"; itemId: string }
  // Submit ack ok: register the new submission in the owner's ledger.
  | { type: "mySubmitted"; itemId: string; promptRaw: string }
  | { type: "reset" };

function patchRound(state: GameSnapshot | null, round: number): GameSnapshot | null {
  // Envelope round guard: drop stale events from a previous round.
  if (state && round !== state.round) return state;
  return state;
}

// ---------------------------------------------------------------------------
// Build-phase helpers: item status mapping + team-scoped updates
// ---------------------------------------------------------------------------

/** Server ItemStatus → client status union (REMOVED/unknown → null). */
function mapItemStatus(status: unknown): ClientItemStatus | null {
  switch (status) {
    case "PENDING":
    case "VALIDATING":
    case "GENERATING":
      return "pending";
    case "READY":
      return "ready";
    case "REJECTED":
      return "rejected";
    case "FAILED":
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

/** Update THIS player's ledger entry (create when absent). */
function patchMyItems(
  state: GameSnapshot,
  itemId: string,
  fn: (prev: MyItemEvent | undefined) => MyItemEvent,
): GameSnapshot {
  return { ...state, myItems: { ...state.myItems, [itemId]: fn(state.myItems[itemId]) } };
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

export function storeReducer(state: GameSnapshot | null, action: StoreAction): GameSnapshot | null {
  switch (action.type) {
    case "sync:full":
      return normalizeSnapshot(action.snapshot, state?.myItems ?? {}, action.myPlayerId ?? null);
    case "phaseChanged": {
      const parsed = phaseChangedSchema.safeParse(action.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const base = patchRound(state, Number((action.payload as { round?: number }).round ?? state?.round ?? 1));
      if (!base) return state;
      return {
        ...base,
        phase: p.phase,
        theme: typeof (action.payload as { theme?: string }).theme === "string"
          ? (action.payload as { theme: string }).theme
          : base.theme,
        phaseEndsAt: p.phaseEndsAt !== undefined ? p.phaseEndsAt : base.phaseEndsAt,
        cutoffAt: p.cutoffAt !== undefined ? p.cutoffAt : base.cutoffAt,
        serverNow: p.serverNow,
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
        teamId?: unknown;
      };
      if (typeof p.itemId !== "string" || typeof p.teamId !== "string") return state;
      const itemId = p.itemId;
      const promptRaw = typeof p.promptRaw === "string" ? p.promptRaw : "";
      const nickname = typeof p.nickname === "string" ? p.nickname : "?";
      const next = withTeam(base, p.teamId, (team) => ({
        ...team,
        items: upsertItem(team.items, {
          id: itemId,
          promptRaw,
          nickname,
          status: "pending",
        }),
        activity: trimActivity([
          { itemId, text: `${nickname} added “${promptRaw}”`, ts: Date.now() },
          ...team.activity.filter((e) => e.itemId !== itemId),
        ]),
      }));
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
      return patchMyItems(next, itemId, (prev) => ({
        promptRaw: prev?.promptRaw ?? "",
        status: "failed",
        reason,
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
      return withTeam(base, p.teamId, (team) => {
        // Version guard: older/equal layouts are stale — ignore them.
        if (team.layout && version <= team.layout.version) return team;
        return { ...team, layout: { version, placements, greetingStyle, source } };
      });
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
): GameSnapshot {
  return normalizeSnapshot(raw, prevMyItems, myPlayerId);
}

function normalizeSnapshot(
  raw: SyncFullEvent,
  prevMyItems: Record<string, MyItemEvent> = {},
  myPlayerId: string | null = null,
): GameSnapshot {
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  const myItems: Record<string, MyItemEvent> = { ...prevMyItems };
  return {
    gameId: String(raw.gameId),
    phase: String(raw.phase),
    round: Number(raw.round ?? 1),
    theme: typeof raw.theme === "string" ? raw.theme : null,
    phaseEndsAt: typeof raw.phaseEndsAt === "number" ? raw.phaseEndsAt : null,
    cutoffAt: typeof raw.cutoffAt === "number" ? raw.cutoffAt : null,
    scoresLocked: Boolean(raw.scoresLocked),
    serverNow: Number(raw.serverNow ?? Date.now()),
    myItems,
    teams: teams.map((t) => {
      // Raw sync:full rows carry server-only fields (failReason, playerId…)
      // beyond the client shape — read them off a loose record type.
      const items: ClientItem[] = (Array.isArray(t.items) ? t.items : []).flatMap((row) => {
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
            ...(item.reason ? { reason: item.reason } : {}),
            ...(prevMyItems[item.id]?.exampleFix
              ? { exampleFix: prevMyItems[item.id]!.exampleFix }
              : {}),
          };
        }
      }
      const layoutRaw = t.layout as
        | {
            version?: unknown;
            placements?: unknown;
            greetingStyle?: unknown;
            source?: unknown;
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
 *  BUILD→"Building the cards", SCORING→"Scoring", JUDGING→"Judging",
 *  REVEAL→"Winner!", RESULTS→"Results". Unknown phases fall back to a
 *  title-cased raw value. */
const PHASE_LABELS: Record<string, string> = {
  LOBBY: "Waiting for players",
  GREETINGS: "Getting card text ready",
  BUILD: "Building the cards",
  SCORING: "Scoring",
  JUDGING: "Judging",
  REVEAL: "Winner!",
  RESULTS: "Results",
};

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return "—";
  return PHASE_LABELS[phase] ?? (phase.charAt(0) + phase.slice(1).toLowerCase());
}