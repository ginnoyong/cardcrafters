/**
 * Critique-scheduler tests — the trailing 5s buffer collapses layout bursts
 * into ONE critique, the 45s rate limit is a fire-time safety net, the mock
 * provider short-circuits (no render, no AI call), the real path parses the
 * vision verdict through layoutCritiqueSchema, and dispose() drops pending
 * timers (shutdown semantics).
 *
 * All timers are fake — nothing here waits real milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CARD_CONFIG, type CardConfig } from "@cardcrafters/shared";

import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import {
  MOCK_CRITIQUE_VERDICT,
  createCritiqueScheduler,
  type CritiqueAi,
  type CritiqueEmit,
  type CritiqueLayoutEmit,
  type CritiqueScheduler,
} from "./critique";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

const BUFFER_MS = 5_000;
const MIN_INTERVAL_MS = 45_000;

interface Ctx {
  gameId: string;
  teamId: string;
}

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
  ctx: Ctx;
}

interface Setup {
  repo: MemoryRepo;
  gameId: string;
  teamId: string;
  /** The READY item created in setup (MemoryRepo ids are UUIDs). */
  itemId: string;
  ctx: Ctx;
  verdicts: Recorded[];
  layouts: Recorded[];
  render: ReturnType<typeof vi.fn>;
}

async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const io: RoomEmitter = { to: () => ({ emit() {} }) };
  const hub = new GameHub(repo, io);
  const { game } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 1 });
  const team = (await repo.listTeams(game.id))[0]!;

  // Real card state for the non-mock path: one READY item, a committed
  // layout, and a greeting — exactly what fire() gathers from the repo.
  const item = await repo.createItem({
    teamId: team.id,
    playerId: "player-1",
    round: 1,
    promptRaw: "red balloon",
    subject: "red balloon",
    status: "READY",
  });
  await repo.updateItem(item.id, {
    width: 256,
    height: 256,
    imageUrl: "/static/items/item-1.png",
  });
  await repo.upsertLayoutState(team.id, 1, {
    version: 1,
    placements: [{ itemId: item.id, x: 357, y: 550, scale: 1.85, rotation: 0, zIndex: 0 }],
    source: "solver",
  });
  await repo.createGreeting({ teamId: team.id, round: 1, text: "Happy Birthday, Sam!" });

  const verdicts: Recorded[] = [];
  const layouts: Recorded[] = [];
  const emitCritique: CritiqueEmit = (event, payload, ctx) => verdicts.push({ event, payload, ctx });
  const emitLayout: CritiqueLayoutEmit = (event, payload, ctx) => layouts.push({ event, payload, ctx });
  // A render that throws if the mock short-circuit path ever calls it; the
  // non-mock tests need a non-empty "PNG" so imageBase64 is non-trivial.
  const render = vi.fn(async () => Buffer.alloc(64, 0x89));

  return {
    repo,
    gameId: game.id,
    teamId: team.id,
    itemId: item.id,
    ctx: { gameId: game.id, teamId: team.id },
    verdicts,
    layouts,
    render,
  };
}

/** Flush the pending microtasks after a fake-timer advance. */
const tick = () => new Promise<void>((r) => setImmediate(r));

const fakeAi: CritiqueAi = {
  run: async () => ({ data: { score: 90, issues: ["hero slightly low"], focalOk: true } }),
};

beforeEach(() => {
  // setImmediate must stay REAL: `tick()` (and vitest's internal async
  // flushing) rely on it, and the default fake-timer config fakes it too —
  // which deadlocks advanceTimersByTimeAsync. Only the scheduler's timers
  // (setTimeout/clearTimeout + Date for the fire-time rate-limit clock) are
  // virtualized.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCritiqueScheduler", () => {
  it("mock mode: 3 rapid schedules → exactly ONE critique after the 5s buffer (burst collapse, no render, no AI)", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: fakeAi,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render, // would throw — proves the short-circuit never renders
    });
    // Burst: three layouts land back-to-back — they must collapse.
    scheduler.schedule(s.ctx);
    scheduler.schedule(s.ctx);
    scheduler.schedule(s.ctx);
    // All three collapse into the SAME trailing timer for this one team.
    expect(scheduler.pending()).toEqual([s.teamId]);

    await vi.advanceTimersByTimeAsync(BUFFER_MS - 1);
    await tick();
    expect(s.verdicts).toHaveLength(0); // still inside the buffer

    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.event).toBe("layout:critique");
    expect(s.verdicts[0]!.ctx).toEqual(s.ctx);
    expect(s.verdicts[0]!.payload).toMatchObject({
      teamId: s.teamId,
      score: MOCK_CRITIQUE_VERDICT.score,
      issues: MOCK_CRITIQUE_VERDICT.issues,
      focalOk: MOCK_CRITIQUE_VERDICT.focalOk,
    });
    // No second timer left behind.
    expect(scheduler.pending()).toEqual([]);

    // And NOTHING further, however long we wait.
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    expect(s.verdicts).toHaveLength(1);
    expect(s.render).not.toHaveBeenCalled();
  });

  it("rate limit: a re-armed critique inside 45s NEVER fires; the first fire after 45s does", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: null,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
    });

    // First critique fires at the buffer edge.
    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    expect(s.verdicts).toHaveLength(1);

    // Re-arm immediately: the 5s buffer alone would fire, but the 45s
    // rate-limit safety net blocks it.
    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    expect(s.verdicts).toHaveLength(1);

    // Realistic burst: layouts keep landing ~5s apart, re-arming the buffer —
    // every fire attempt inside the 45s window is silently dropped. 7 more
    // buffer edges land at t=15s…45s — the last is 40s after fire #1, still
    // inside the window.
    for (let i = 0; i < 7; i++) {
      scheduler.schedule(s.ctx);
      await vi.advanceTimersByTimeAsync(BUFFER_MS);
      await tick();
      expect(s.verdicts).toHaveLength(1);
    }

    // The 45s window has now elapsed: the next buffer edge fires.
    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    expect(s.verdicts).toHaveLength(2);
  });

  it("non-mock AI: renders the card, calls the vision model, emits the PARSED verdict", async () => {
    const s = await setup();
    const aiRun = vi.fn(
      async () => ({ data: { score: 90, issues: ["hero slightly low"], focalOk: true } }),
    );
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: aiRun },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();

    expect(s.render).toHaveBeenCalledTimes(1);
    const [items, layout, greeting] = s.render.mock.calls[0] as unknown as [
      Array<{ itemId: string; width: number; height: number }>,
      { placements: Array<{ itemId: string }> },
      string,
    ];
    expect(items.map((i) => i.itemId)).toEqual([s.itemId]);
    expect(items[0]).toMatchObject({ width: 256, height: 256 });
    expect(layout.placements).toHaveLength(1);
    expect(greeting).toBe("Happy Birthday, Sam!");

    expect(aiRun).toHaveBeenCalledTimes(1);
    const [task, input] = aiRun.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(task).toBe("layout_critique");
    expect(input.imageMime).toBe("image/png");
    expect(String(input.imageBase64).length).toBeGreaterThan(0);
    expect(typeof input.layoutSummary).toBe("string");

    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.event).toBe("layout:critique");
    // Parsed through layoutCritiqueSchema — only the schema fields survive.
    expect(s.verdicts[0]!.payload).toEqual({
      teamId: s.teamId,
      score: 90,
      issues: ["hero slightly low"],
      focalOk: true,
    });
    // High score + focalOk → no flagged re-emit.
    expect(s.layouts).toHaveLength(0);
  });

  it("low-score verdict → layout:updated re-emit with source 'critique:flagged' + the critique attached", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: async () => ({ data: { score: 40, issues: ["no focal point"], focalOk: false } }) },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      emitLayout: (event, payload, ctx) => s.layouts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();

    expect(s.verdicts).toHaveLength(1);
    expect(s.layouts).toHaveLength(1);
    expect(s.layouts[0]!.event).toBe("layout:updated");
    expect(s.layouts[0]!.payload).toMatchObject({
      version: 1,
      source: "critique:flagged",
      critique: { score: 40, focalOk: false },
    });
    expect(s.layouts[0]!.ctx).toEqual(s.ctx);
  });

  it("AI failure → swallowed (logged), no critique, no crash", async () => {
    const s = await setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler: CritiqueScheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: async () => { throw new Error("vision provider down"); } },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    // The buffer edge does not produce a verdict (fire failed before emit).
    expect(s.verdicts).toHaveLength(0);
    expect(scheduler.pending()).toEqual([]); // timer consumed either way
    errSpy.mockRestore();
  });

  it("dispose() clears pending timers — nothing fires after the advance", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: null,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
    });

    scheduler.schedule(s.ctx);
    expect(scheduler.pending()).toEqual([s.teamId]);
    scheduler.dispose();
    expect(scheduler.pending()).toEqual([]);

    await vi.advanceTimersByTimeAsync(BUFFER_MS + 1_000);
    await tick();
    expect(s.verdicts).toHaveLength(0);
  });
});
