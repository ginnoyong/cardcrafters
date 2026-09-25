/**
 * TimerService tests — fake timers drive the injectable clock.
 *
 * vitest's useFakeTimers() fakes Date.now() as well as setTimeout, so the
 * default clock configuration behaves identically to production while being
 * fully deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHASE } from "@cardcrafters/shared";

import { MemoryRepo } from "../repo/memory-repo";
import { hydrateTimers, TimerService } from "./timer-service";

const GAME = "game-timer-1";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeTimers() {
  const fired: Array<{ gameId: string; phase: string; now: number }> = [];
  const timers = new TimerService((gameId, phase, now) => {
    fired.push({ gameId, phase, now });
  });
  return { timers, fired };
}

describe("TimerService", () => {
  it("fires exactly once at endsAt", () => {
    const { timers, fired } = makeTimers();
    const start = Date.now();
    timers.arm(GAME, PHASE.BUILD, start + 1_000);

    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ gameId: GAME, phase: PHASE.BUILD, now: start + 1_000 }]);
    expect(timers.isArmed(GAME)).toBe(false);
  });

  it("clear cancels the armed timer", () => {
    const { timers, fired } = makeTimers();
    timers.arm(GAME, PHASE.SCORING, Date.now() + 1_000);
    timers.clear(GAME);

    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it("re-arming replaces the previous timer (no double fire)", () => {
    const { timers, fired } = makeTimers();
    timers.arm(GAME, PHASE.BUILD, Date.now() + 500);
    timers.arm(GAME, PHASE.BUILD, Date.now() + 1_000);

    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([expect.objectContaining({ now: Date.now() - 0 })]);
    expect(fired).toHaveLength(1);
  });

  it("clearAll cancels every game's timer", () => {
    const { timers, fired } = makeTimers();
    timers.arm("g1", PHASE.BUILD, Date.now() + 100);
    timers.arm("game-2", PHASE.SCORING, Date.now() + 200);
    timers.clearAll();

    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it("arms timers for phases other than BUILD too (whatever the hub sends)", () => {
    const { timers, fired } = makeTimers();
    timers.arm(GAME, PHASE.SCORING, Date.now() + 250);
    vi.advanceTimersByTime(250);
    expect(fired).toEqual([expect.objectContaining({ phase: PHASE.SCORING })]);
  });
});

describe("hydrateTimers (boot reconciliation)", () => {
  it("re-arms future phases and fires already-expired phases exactly once", async () => {
    const repo = new MemoryRepo();
    const { timers, fired } = makeTimers();

    const now = Date.now();
    const future = await repo.createGame({ config: { ...{ buildTimerSeconds: 0, scoringTimerSeconds: 0 } } as never });
    await repo.updateGame(future.id, { phase: PHASE.BUILD, phaseEndsAt: now + 5_000 });

    const expired = await repo.createGame({ config: { ...{ buildTimerSeconds: 0, scoringTimerSeconds: 0 } } as never });
    await repo.updateGame(expired.id, { phase: PHASE.BUILD, phaseEndsAt: now - 5_000 });

    const noTimer = await repo.createGame({ config: { ...{} } as never });

    const hubCalls: Array<{ gameId: string; event: unknown }> = [];
    const hub = {
      applyEvent: async (gameId: string, event: unknown) => {
        hubCalls.push({ gameId, event });
      },
    };

    await hydrateTimers(timers, hub, repo, now);

    // Expired phase → fired immediately through the hub, exactly once.
    expect(hubCalls).toEqual([
      { gameId: expired.id, event: { type: "timer:expired", phase: PHASE.BUILD, now } },
    ]);

    // Future phase → armed; expires at the right moment through the service.
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual([{ gameId: future.id, phase: PHASE.BUILD, now: now + 5_000 }]);

    // Untimed game untouched.
    expect(fired.some((f) => f.gameId === noTimer.id)).toBe(false);
  });
});
