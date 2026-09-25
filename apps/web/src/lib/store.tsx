"use client";

/**
 * Client game store — a small React context (no redux) holding the latest
 * `sync:full` snapshot plus incremental live updates (`phase:changed`,
 * `player:joined`, `player:left`). Every surface (GM console, player waiting
 * screen, presenter) renders from this one shape, and later canvas steps can
 * reuse it unchanged.
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

export interface ClientTeam {
  id: string;
  name: string;
  label: string;
  memberCount: number;
  members: ClientTeamMember[];
  itemCount: number;
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
}

/** Shape of a `sync:full` payload as the UI consumes it. */
export interface SyncFullEvent extends GameSnapshot {
  seq?: number;
  ts?: number;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type StoreAction =
  | { type: "sync:full"; snapshot: SyncFullEvent }
  | { type: "phaseChanged"; payload: Record<string, unknown> }
  | { type: "playerJoined"; playerId: string; nickname: string; teamId: string }
  | { type: "playerLeft"; playerId: string; kicked: boolean }
  | { type: "reset" };

function patchRound(state: GameSnapshot | null, round: number): GameSnapshot | null {
  // Envelope round guard: drop stale events from a previous round.
  if (state && round !== state.round) return state;
  return state;
}

export function storeReducer(state: GameSnapshot | null, action: StoreAction): GameSnapshot | null {
  switch (action.type) {
    case "sync:full":
      return normalizeSnapshot(action.snapshot);
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
    case "reset":
      return null;
    default:
      return state;
  }
}

/** Coerce a raw sync:full payload (unknown JSON) into the client snapshot. */
export function normalizeSyncFull(raw: SyncFullEvent): GameSnapshot {
  return normalizeSnapshot(raw);
}

function normalizeSnapshot(raw: SyncFullEvent): GameSnapshot {
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  return {
    gameId: String(raw.gameId),
    phase: String(raw.phase),
    round: Number(raw.round ?? 1),
    theme: typeof raw.theme === "string" ? raw.theme : null,
    phaseEndsAt: typeof raw.phaseEndsAt === "number" ? raw.phaseEndsAt : null,
    cutoffAt: typeof raw.cutoffAt === "number" ? raw.cutoffAt : null,
    scoresLocked: Boolean(raw.scoresLocked),
    serverNow: Number(raw.serverNow ?? Date.now()),
    teams: teams.map((t) => ({
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
    })),
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

/** Convenience hook: phase badge label (e.g. "BUILD"). */
export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return "—";
  return phase.charAt(0) + phase.slice(1).toLowerCase();
}