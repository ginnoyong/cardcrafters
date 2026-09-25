/**
 * Game state machine — PURE, no IO, no Date.now().
 *
 * `transition` consumes one GameEvent against the current GameRuntimeState and
 * returns either the next state + the Effects the caller must perform, or a
 * rejection reason. Every timestamp (now, timers) enters as event data, so
 * tests pin `now` explicitly and transitions are deterministic.
 *
 * Legal phase flow (per round):
 *   LOBBY → GREETINGS → BUILD → SCORING → JUDGING → REVEAL → RESULTS → GREETINGS (round+1)
 */

import { PHASE, type CardConfig, type Phase } from "@cardcrafters/shared";

import type { Effect, GameEvent, GameRuntimeState, TransitionResult } from "./types";

export type { Effect, GameEvent, GameRuntimeState, TransitionResult };

/** Phase order for UI hints (steppers, disabled states). */
export const PHASE_ORDER: readonly Phase[] = [
  PHASE.LOBBY,
  PHASE.GREETINGS,
  PHASE.BUILD,
  PHASE.SCORING,
  PHASE.JUDGING,
  PHASE.REVEAL,
  PHASE.RESULTS,
];

/** Emit helper — always scoped to the game's broadcast room. */
function phaseChangedEmit(
  gameId: string,
  payload: {
    phase: Phase;
    round?: number;
    theme?: string;
    phaseEndsAt?: number;
    cutoffAt?: number;
    serverNow: number;
  },
): Effect {
  return { type: "emit", event: "phaseChanged", payload: { ...payload }, rooms: [`game:${gameId}`] };
}

/** End-of-phase timestamp for a configurable timer, in epoch ms (undefined = untimed). */
function timerEndsAt(seconds: number | undefined, now: number): number | undefined {
  return seconds && seconds > 0 ? now + seconds * 1000 : undefined;
}

/** BUILD → SCORING. `stoppedByGm` controls whether a cutoff is set. */
function endBuild(
  state: GameRuntimeState,
  now: number,
  stoppedByGm: boolean,
): TransitionResult {
  const cutoffAt = stoppedByGm ? now : undefined;
  const phaseEndsAt = timerEndsAt(state.config.scoringTimerSeconds, now);
  const next = nextState(state, { phase: PHASE.SCORING, phaseEndsAt, cutoffAt });
  const effects: Effect[] = [];
  if (cutoffAt !== undefined) effects.push({ type: "setCutoff", at: cutoffAt });
  effects.push(
    phaseChangedEmit(state.gameId, {
      phase: PHASE.SCORING,
      round: state.round,
      phaseEndsAt,
      cutoffAt,
      serverNow: now,
    }),
  );
  if (phaseEndsAt !== undefined) {
    effects.push({ type: "startTimer", phase: PHASE.SCORING, endsAt: phaseEndsAt });
  }
  return { ok: true, state: next, effects };
}

/** SCORING → JUDGING; scores lock at entry. */
function endScoring(state: GameRuntimeState, now: number): TransitionResult {
  const next = nextState(state, {
    phase: PHASE.JUDGING,
    phaseEndsAt: undefined,
    scoresLocked: true,
  });
  return {
    ok: true,
    state: next,
    effects: [
      { type: "lockScores" },
      phaseChangedEmit(state.gameId, { phase: PHASE.JUDGING, round: state.round, serverNow: now }),
      { type: "clearTimer" },
    ],
  };
}

/** Build the next state without mutating the input. */
function nextState(
  state: GameRuntimeState,
  patch: Partial<GameRuntimeState>,
): GameRuntimeState {
  return { ...state, ...patch };
}

/**
 * Attempt a transition. Returns `{ ok: true, state, effects }` on success or
 * `{ ok: false, reason }` when the event is illegal for the current phase.
 */
export function transition(
  state: GameRuntimeState,
  event: GameEvent,
): TransitionResult {
  switch (event.type) {
    // ---------------------------------------------------------------------
    // Greetings: GM proposes a theme. Legal in LOBBY (first proposal starts
    // the round) and in GREETINGS (re-propose before approval).
    // ---------------------------------------------------------------------
    case "gm:setTheme": {
      if (state.phase !== PHASE.LOBBY && state.phase !== PHASE.GREETINGS) {
        return { ok: false, reason: `gm:setTheme is only valid in LOBBY or GREETINGS (current: ${state.phase})` };
      }
      const next = nextState(state, { theme: event.theme, phase: PHASE.GREETINGS });
      return {
        ok: true,
        state: next,
        effects: [
          phaseChangedEmit(state.gameId, {
            phase: PHASE.GREETINGS,
            round: state.round,
            theme: event.theme,
            serverNow: event.now,
          }),
        ],
      };
    }

    // ---------------------------------------------------------------------
    // Greetings approved → BUILD.
    // ---------------------------------------------------------------------
    case "gm:approveGreetings": {
      if (state.phase !== PHASE.GREETINGS) {
        return { ok: false, reason: `gm:approveGreetings is only valid in GREETINGS (current: ${state.phase})` };
      }
      const phaseEndsAt = timerEndsAt(state.config.buildTimerSeconds, event.now);
      const next = nextState(state, { phase: PHASE.BUILD, phaseEndsAt });
      const effects: Effect[] = [
        phaseChangedEmit(state.gameId, {
          phase: PHASE.BUILD,
          round: state.round,
          phaseEndsAt,
          serverNow: event.now,
        }),
      ];
      if (phaseEndsAt !== undefined) {
        effects.push({ type: "startTimer", phase: PHASE.BUILD, endsAt: phaseEndsAt });
      }
      return { ok: true, state: next, effects };
    }

    // ---------------------------------------------------------------------
    // BUILD → SCORING (GM early-stop or natural timer expiry).
    // setCutoff only on the GM early-stop path: it tells the pipeline that
    // in-flight items keep generating past the cutoff.
    // ---------------------------------------------------------------------
    case "gm:stopBuild": {
      if (state.phase !== PHASE.BUILD) {
        return { ok: false, reason: `cannot end BUILD from phase ${state.phase}` };
      }
      return endBuild(state, event.now, true);
    }

    case "timer:expired": {
      if (state.phase === PHASE.BUILD) {
        if (event.phase !== state.phase) {
          return { ok: false, reason: "timer:expired for a phase other than the current one" };
        }
        return endBuild(state, event.now, false);
      }
      if (state.phase === PHASE.SCORING) {
        if (event.phase !== state.phase) {
          return { ok: false, reason: "timer:expired for a phase other than the current one" };
        }
        return endScoring(state, event.now);
      }
      return { ok: false, reason: `timer:expired is only valid in BUILD or SCORING (current: ${state.phase})` };
    }

    // ---------------------------------------------------------------------
    // SCORING → JUDGING. Scores lock at JUDGING entry.
    // ---------------------------------------------------------------------
    case "gm:stopScoring": {
      if (state.phase !== PHASE.SCORING) {
        return { ok: false, reason: `cannot end SCORING from phase ${state.phase}` };
      }
      return endScoring(state, event.now);
    }

    // ---------------------------------------------------------------------
    // JUDGING → REVEAL with the GM's picks. The winnerAnnounced socket emit
    // is the hub's job; the machine only advances the phase.
    // ---------------------------------------------------------------------
    case "gm:pickWinner": {
      if (state.phase !== PHASE.JUDGING) {
        return { ok: false, reason: `gm:pickWinner is only valid in JUDGING (current: ${state.phase})` };
      }
      const next = nextState(state, {
        phase: PHASE.REVEAL,
        phaseEndsAt: undefined,
        winnerTeamId: event.teamId,
        peoplesChoiceTeamId: event.peoplesChoiceTeamId,
      });
      const winnerEffect: Effect = {
        type: "announceWinner",
        teamId: event.teamId,
        ...(event.peoplesChoiceTeamId !== undefined
          ? { peoplesChoiceTeamId: event.peoplesChoiceTeamId }
          : {}),
      };
      return {
        ok: true,
        state: next,
        effects: [
          winnerEffect,
          phaseChangedEmit(state.gameId, { phase: PHASE.REVEAL, round: state.round, serverNow: event.now }),
        ],
      };
    }

    // ---------------------------------------------------------------------
    // REVEAL → RESULTS (presenter ack or 30s auto-expiry driven by the hub).
    // ---------------------------------------------------------------------
    case "reveal:ack":
    case "reveal:auto-expired": {
      if (state.phase !== PHASE.REVEAL) {
        return { ok: false, reason: `reveal acknowledgement is only valid in REVEAL (current: ${state.phase})` };
      }
      const next = nextState(state, { phase: PHASE.RESULTS, phaseEndsAt: undefined });
      return {
        ok: true,
        state: next,
        effects: [
          phaseChangedEmit(state.gameId, { phase: PHASE.RESULTS, round: state.round, serverNow: event.now }),
        ],
      };
    }

    // ---------------------------------------------------------------------
    // RESULTS → GREETINGS for the next round. Clears all round-scoped
    // runtime state; the theme is cleared too (new round, new proposal).
    // ---------------------------------------------------------------------
    case "gm:newRound": {
      if (state.phase !== PHASE.RESULTS) {
        return { ok: false, reason: `gm:newRound is only valid in RESULTS (current: ${state.phase})` };
      }
      const round = state.round + 1;
      const next = nextState(state, {
        phase: PHASE.GREETINGS,
        round,
        theme: undefined,
        phaseEndsAt: undefined,
        cutoffAt: undefined,
        scoresLocked: false,
        winnerTeamId: undefined,
        peoplesChoiceTeamId: undefined,
      });
      return {
        ok: true,
        state: next,
        effects: [
          { type: "incrementRound" },
          phaseChangedEmit(state.gameId, { phase: PHASE.GREETINGS, round, serverNow: event.now }),
        ],
      };
    }

    // ---------------------------------------------------------------------
    // player:submitPrompt — guarded self-transition. Only meaningful during
    // BUILD; past the cutoff (or once the phase has moved on) it is refused.
    // ---------------------------------------------------------------------
    case "player:submitPrompt": {
      if (state.phase === PHASE.LOBBY || state.phase === PHASE.GREETINGS) {
        return { ok: false, reason: "before_theme" };
      }
      if (state.phase !== PHASE.BUILD) {
        return { ok: false, reason: "phase_ended" };
      }
      if (state.cutoffAt !== undefined && event.now >= state.cutoffAt) {
        return { ok: false, reason: "phase_ended" };
      }
      return {
        ok: true,
        state,
        effects: [{ type: "accept-submission", playerId: event.playerId, text: event.text }],
      };
    }

    // ---------------------------------------------------------------------
    // player:join — rejoining is allowed in ANY phase; brand-new players may
    // only enter during LOBBY.
    // ---------------------------------------------------------------------
    case "player:join": {
      if (event.isNewPlayer && state.phase !== PHASE.LOBBY) {
        return { ok: false, reason: "game_in_progress" };
      }
      return { ok: true, state, effects: [] };
    }

    default: {
      // Exhaustiveness guard: if a new event type is added to the union, this
      // cast starts failing the build until the switch above handles it.
      const exhaustive: never = event;
      void exhaustive;
      return { ok: false, reason: "unknown event" };
    }
  }
}

/** Pure predicate version of `transition` for UI/guard use. */
export function canTransition(state: GameRuntimeState, event: GameEvent): boolean {
  return transition(state, event).ok;
}

/**
 * Advance a timer-driven phase check: is `timer:expired` meaningful right now?
 * Pure helper for the hub's timer bookkeeping.
 */
export function isTimedPhase(phase: Phase): boolean {
  return phase === PHASE.BUILD || phase === PHASE.SCORING;
}