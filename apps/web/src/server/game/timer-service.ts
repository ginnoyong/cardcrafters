/**
 * TimerService — arms/clears the one active phase timer per game.
 *
 * Timed phases: BUILD and SCORING (see state-machine.isTimedPhase). The state
 * machine emits a `startTimer` Effect with the absolute `endsAt` (epoch ms);
 * the hub forwards it here. On expiry the service calls the hub back with a
 * `timer:expired` GameEvent, which flows through the normal transition path.
 *
 * Boot reconciliation (`hydrateTimers`) recovers after a server restart:
 *   - phaseEndsAt in the future  → re-arm
 *   - phaseEndsAt already past   → fire timer:expired immediately (exactly once)
 *
 * The clock is injectable so tests can drive expiry deterministically; by
 * default the global setTimeout/Date.now are used (and vitest fake timers
 * intercept both).
 */

import type { Phase } from "@cardcrafters/shared";

import type { GameRow, Repository } from "../repo/repository";
import type { GameEvent } from "./types";

/** What a TimerService needs from the hub to fire an expiry. */
export interface TimerHost {
  applyEvent(gameId: string, event: GameEvent): Promise<unknown>;
}

export interface TimerServiceOptions {
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer primitives (tests can override; defaults are globals). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

interface ArmedTimer {
  gameId: string;
  phase: Phase;
  endsAt: number;
  handle: ReturnType<typeof setTimeout>;
}

export class TimerService {
  private armed = new Map<string, ArmedTimer>();

  constructor(
    /** Called on expiry: the host should run `timer:expired` through the hub. */
    private fire: (gameId: string, phase: Phase, now: number) => void,
    private opts: TimerServiceOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Arm the timer for `gameId`, expiring at `endsAt` (epoch ms). Replaces any
   * previously armed timer for the game. A non-positive delay fires on the
   * next tick (still exactly once).
   */
  arm(gameId: string, phase: Phase, endsAt: number): void {
    this.clear(gameId);
    const delay = Math.max(0, endsAt - this.now());
    const setTimeoutFn = this.opts.setTimeoutFn ?? setTimeout;
    const handle = setTimeoutFn(() => {
      this.armed.delete(gameId);
      this.fire(gameId, phase, this.now());
    }, delay);
    // A pending phase timer must never keep the process alive on shutdown.
    (handle as { unref?: () => void }).unref?.();
    this.armed.set(gameId, { gameId, phase, endsAt, handle });
  }

  /** Cancel the timer for one game (no-op when none is armed). */
  clear(gameId: string): void {
    const armed = this.armed.get(gameId);
    if (!armed) return;
    (this.opts.clearTimeoutFn ?? clearTimeout)(armed.handle);
    this.armed.delete(gameId);
  }

  /** Cancel every armed timer (graceful shutdown / test teardown). */
  clearAll(): void {
    for (const gameId of [...this.armed.keys()]) this.clear(gameId);
  }

  /** Test/ops introspection: is a timer armed for this game? */
  isArmed(gameId: string): boolean {
    return this.armed.has(gameId);
  }

  armedFor(gameId: string): ArmedTimer | undefined {
    return this.armed.get(gameId);
  }
}

/**
 * Boot reconciliation: for every game in the repo with a phaseEndsAt in the
 * future → arm; already expired → fire `timer:expired` immediately so the
 * state machine catches up (illegal for the current phase → rejected
 * harmlessly by the machine).
 *
 * `now` is injectable for tests; defaults to the real clock.
 */
export async function hydrateTimers(
  timers: TimerService,
  hub: { applyEvent(gameId: string, event: GameEvent): Promise<unknown> },
  repo: Repository,
  now: number = Date.now(),
): Promise<void> {
  const games: GameRow[] = await repo.listGames();
  for (const game of games) {
    if (game.phaseEndsAt === null) continue;
    if (game.phaseEndsAt > now) {
      timers.arm(game.id, game.phase, game.phaseEndsAt);
    } else {
      await hub.applyEvent(game.id, { type: "timer:expired", phase: game.phase, now });
    }
  }
}
