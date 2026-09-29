/**
 * Game engine internal types — pure data, no IO.
 *
 * The state machine consumes GameEvents and produces Effects. Effects are the
 * ONLY way the pure machine asks the outside world to do something (send a
 * socket event, start/clear a timer, ...); the hub (Step 3) interprets them.
 * All timestamps are epoch milliseconds and ALWAYS arrive as event/parameter
 * inputs — the machine never calls Date.now(), so transitions are fully
 * deterministic and trivially testable.
 */

import type { CardConfig, Placement, GreetingStyle, Phase } from "@cardcrafters/shared";

// ---------------------------------------------------------------------------
// Runtime state — plain serializable snapshot of one game
// ---------------------------------------------------------------------------

/** Serializable runtime state of a single game. */
export interface GameRuntimeState {
  gameId: string;
  phase: Phase;
  /** 1-based round counter; increments when a finished round restarts. */
  round: number;
  /** Theme proposed for the current round (absent until the GM sets one). */
  theme?: string;
  config: CardConfig;
  /** Epoch ms when the current phase timer expires (absent = untimed). */
  phaseEndsAt?: number;
  /**
   * Epoch ms beyond which BUILD submissions are refused even if the phase
   * label still reads BUILD (in-flight items keep generating past cutoff).
   */
  cutoffAt?: number;
  /** True from JUDGING entry until the next round starts. */
  scoresLocked: boolean;
  winnerTeamId?: string;
  peoplesChoiceTeamId?: string;
}

/** Convenience constructor for a fresh game's runtime state (LOBBY, round 1). */
export function createInitialRuntimeState(
  gameId: string,
  config: CardConfig,
): GameRuntimeState {
  return {
    gameId,
    phase: "LOBBY",
    round: 1,
    config,
    scoresLocked: false,
  };
}

// ---------------------------------------------------------------------------
// Game events — inputs to the state machine
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: "gm:setTheme"; theme: string; now: number }
  | { type: "gm:approveGreetings"; now: number }
  | { type: "gm:stopBuild"; now: number }
  | { type: "gm:stopScoring"; now: number }
  | { type: "timer:expired"; phase: Phase; now: number }
  | { type: "gm:pickWinner"; teamId: string; peoplesChoiceTeamId?: string; now: number }
  | { type: "reveal:ack"; now: number }
  | { type: "reveal:auto-expired"; now: number }
  | { type: "gm:newRound"; now: number }
  | { type: "player:submitPrompt"; playerId: string; text: string; now: number }
  | { type: "player:join"; playerId: string; isNewPlayer: boolean; now: number };

// ---------------------------------------------------------------------------
// Effects — side-effects the CALLER performs on behalf of the machine
// ---------------------------------------------------------------------------

export type Effect =
  /**
   * Send `event` with `payload` to the listed rooms. Room naming convention:
   * `game:<gameId>` (everyone in the game), `gm:<gameId>`, `team:<teamId>`,
   * `player:<playerId>`. The hub stamps transport-specific fields if needed.
   */
  | { type: "emit"; event: string; payload: Record<string, unknown>; rooms: string[] }
  | { type: "startTimer"; phase: Phase; endsAt: number }
  | { type: "clearTimer" }
  /** Freeze score writes (JUDGING entry). */
  | { type: "lockScores" }
  /** BUILD submissions after `at` are refused; in-flight items keep generating. */
  | { type: "setCutoff"; at: number }
  /** BUILD → SCORING entry — the caller builds the round's anonymous scoring
   *  order (seeded per game+round), persists it on Game.scoringOrder and
   *  emits `scoring:started` (personalized per player, GM copy with the
   *  team mapping). */
  | { type: "beginScoring" }
  /** Round counter advanced — persist and broadcast. */
  | { type: "incrementRound" }
  /** Direct message to a single player. */
  | { type: "notify"; playerId: string; message: string }
  /** Prompt accepted by the phase guard — caller should persist + queue it. */
  | { type: "accept-submission"; playerId: string; text: string }
  /** GM picked the round winner(s) — caller persists WinnerPick rows and
   *  broadcasts `winnerAnnounced` (with a fresh revealToken). */
  | { type: "announceWinner"; teamId: string; peoplesChoiceTeamId?: string };

// ---------------------------------------------------------------------------
// Snapshot — what the hub serializes to clients
// ---------------------------------------------------------------------------

/** Wire-friendly projection of the runtime state. */
export interface GameSnapshot {
  gameId: string;
  phase: Phase;
  round: number;
  theme?: string;
  config: CardConfig;
  phaseEndsAt?: number;
  cutoffAt?: number;
  scoresLocked: boolean;
  winnerTeamId?: string;
  peoplesChoiceTeamId?: string;
  serverNow: number;
}

// ---------------------------------------------------------------------------
// Transition result
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; state: GameRuntimeState; effects: Effect[] }
  | { ok: false; reason: string };