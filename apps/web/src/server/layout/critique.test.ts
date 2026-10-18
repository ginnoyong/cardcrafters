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

  it("settleAll: pending timer cleared → critique fires IMMEDIATELY, no buffer wait", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: null,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
    });

    // A critique is pending inside the 5s buffer — settleAll must not wait it out.
    scheduler.schedule(s.ctx);
    expect(scheduler.pending()).toEqual([s.teamId]);
    await scheduler.settleAll(s.gameId);
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.payload).toMatchObject({ teamId: s.teamId, score: MOCK_CRITIQUE_VERDICT.score });
    expect(scheduler.pending()).toEqual([]); // timer consumed, nothing left

    // And nothing further: the buffer-edge fire that WOULD have happened is gone.
    await vi.advanceTimersByTimeAsync(BUFFER_MS + 1_000);
    await tick();
    expect(s.verdicts).toHaveLength(1);
  });

  it("settleAll bypasses the 45s rate limit — a team critiqued <45s ago still gets a verdict", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: null,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
    });

    // First critique through the normal path → lastCritiqueAt = t≈5s.
    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    expect(s.verdicts).toHaveLength(1);

    // Re-arm well inside the 45s window: the buffered fire would be silently
    // dropped by the rate limit… but settleAll forces past it.
    scheduler.schedule(s.ctx);
    await scheduler.settleAll(s.gameId);
    expect(s.verdicts).toHaveLength(2);
    expect(s.verdicts[1]!.payload).toMatchObject({ teamId: s.teamId });

    // …and the forced fire still updates lastCritiqueAt: a subsequent
    // rate-limited (non-forced) buffer fire inside the new 45s window is dropped.
    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();
    expect(s.verdicts).toHaveLength(2);
  });

  it("settleAll (mock mode) emits the fixed MOCK_CRITIQUE_VERDICT with no render / no AI", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: fakeAi,
      mockMode: true,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render, // would throw — proves the short-circuit never renders
    });

    scheduler.schedule(s.ctx);
    await scheduler.settleAll(s.gameId);
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.event).toBe("layout:critique");
    expect(s.verdicts[0]!.ctx).toEqual(s.ctx);
    expect(s.verdicts[0]!.payload).toMatchObject({
      teamId: s.teamId,
      score: MOCK_CRITIQUE_VERDICT.score,
      issues: MOCK_CRITIQUE_VERDICT.issues,
      focalOk: MOCK_CRITIQUE_VERDICT.focalOk,
    });
    expect(s.render).not.toHaveBeenCalled();
  });

  it("settleAll never rejects — a failing AI/render for one team does not stop the others' fires", async () => {
    const s = await setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Second team in the same game (setup created exactly one) with FULL card
    // state — item + layout — so its fire() reaches the AI call.
    const team2 = await s.repo.createTeam({
      gameId: s.gameId,
      name: "Team B",
      label: "B",
      joinToken: "tok-B",
    });
    const item2 = await s.repo.createItem({
      teamId: team2.id,
      playerId: "player-2",
      round: 1,
      promptRaw: "blue balloon",
      subject: "blue balloon",
      status: "READY",
    });
    await s.repo.updateItem(item2.id, {
      width: 200,
      height: 200,
      imageUrl: "/static/items/item-2.png",
    });
    await s.repo.upsertLayoutState(team2.id, 1, {
      version: 1,
      placements: [{ itemId: item2.id, x: 400, y: 400, scale: 1.5, rotation: 0, zIndex: 0 }],
      source: "solver",
    });

    // Team 1's AI call explodes; team 2 succeeds. Identified robustly by the
    // itemId inside layoutSummary (ai.run only receives gameId, not teamId —
    // and with allSettled the two fires may interleave in any order).
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: {
        run: async (_task, input) => {
          if (String(input.layoutSummary).includes(s.itemId)) {
            throw new Error("vision provider down");
          }
          return { data: { score: 90, issues: [], focalOk: true } };
        },
      },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    scheduler.schedule({ gameId: s.gameId, teamId: team2.id });
    expect(scheduler.pending()).toHaveLength(2);

    // settleAll resolves (never rejects) even though team 1's fire throws.
    await expect(scheduler.settleAll(s.gameId)).resolves.toBeUndefined();
    // The successful team still got its parsed verdict; the failed team got none.
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.ctx).toEqual({ gameId: s.gameId, teamId: team2.id });
    expect(scheduler.pending()).toEqual([]);
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

// ---------------------------------------------------------------------------
// Critique persistence (D3) — the verdict rides with the LAYOUT STATE so the
// GM judging view survives reloads (sync:full reads it from storage). The
// write uses the SAME version fire() just read (no bump), re-sending the
// placements/source it read so nothing else in the row changes, and it is
// BEST-EFFORT: a persistence failure must never break the emit contract
// (verdict + low-score flagged re-emit are already fulfilled by then).
// ---------------------------------------------------------------------------

describe("critique persistence (D3)", () => {
  it("fire() persists the parsed verdict via upsertLayoutState at the SAME version (no bump)", async () => {
    const s = await setup();
    // Spy AFTER the fixture seeded layout v1 — only fire()'s write is recorded.
    const upsert = vi.spyOn(s.repo, "upsertLayoutState");
    // Non-mock AI whose verdict fields mirror MOCK_CRITIQUE_VERDICT (parsed
    // through layoutCritiqueSchema before emit/persist).
    const verdict = {
      score: MOCK_CRITIQUE_VERDICT.score,
      issues: ["hero slightly low"],
      focalOk: MOCK_CRITIQUE_VERDICT.focalOk,
    };
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: async () => ({ data: verdict }) },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();

    expect(s.verdicts).toHaveLength(1);
    // Exactly ONE layout write after the spy was installed, carrying the
    // parsed verdict — and the SAME version the fire path read (no bump).
    expect(upsert).toHaveBeenCalledTimes(1);
    const [teamId, round, patch] = upsert.mock.calls[0]!;
    expect(teamId).toBe(s.teamId);
    expect(round).toBe(1);
    expect(patch.version).toBe(1);
    expect(patch.critique).toEqual(verdict);
    expect(patch.placements).toHaveLength(1);
    expect(patch.source).toBe("solver");
    // The persisted state agrees (GM judging view reads this on reload).
    expect((await s.repo.getLayoutState(s.teamId, 1))!.critique).toEqual(verdict);
  });

  it("persist failure is swallowed — verdict + flagged re-emit still delivered, fire never throws", async () => {
    const s = await setup();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(s.repo, "upsertLayoutState").mockRejectedValue(new Error("db down"));
    // Low-score verdict → fire() re-emits the flagged layout BEFORE attempting
    // the persist — the failure must not undo that emit contract.
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: async () => ({ data: { score: 40, issues: ["no focal point"], focalOk: false } }) },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      emitLayout: (event, payload, ctx) => s.layouts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    // Does not reject: the persist attempt is wrapped inside fire().
    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    await tick();

    // The verdict was still emitted…
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]!.payload).toMatchObject({ teamId: s.teamId, score: 40, focalOk: false });
    // …the low-score re-emit behavior is unchanged…
    expect(s.layouts).toHaveLength(1);
    expect(s.layouts[0]!.event).toBe("layout:updated");
    expect(s.layouts[0]!.payload).toMatchObject({
      version: 1,
      source: "critique:flagged",
      critique: { score: 40, focalOk: false },
    });
    // …and the persistence failure was logged + swallowed (best-effort only).
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("settleAll persists the verdict — one forced fire lands the critique in storage", async () => {
    const s = await setup();
    const scheduler = createCritiqueScheduler({
      repo: s.repo,
      ai: { run: async () => ({ data: { score: 88, issues: ["a bit crowded"], focalOk: true } }) },
      mockMode: false,
      emitCritique: (event, payload, ctx) => s.verdicts.push({ event, payload, ctx }),
      render: s.render,
    });

    scheduler.schedule(s.ctx);
    await scheduler.settleAll(s.gameId);
    expect(s.verdicts).toHaveLength(1);

    // The forced fire ends with the critique persisted (no version bump —
    // the Phase-A settle must not corrupt the layout the engine committed).
    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(1);
    expect(row!.source).toBe("solver");
    expect(row!.placements).toHaveLength(1);
    expect(row!.critique).toEqual({ score: 88, issues: ["a bit crowded"], focalOk: true });
  });
});
