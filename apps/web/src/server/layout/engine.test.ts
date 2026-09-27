/**
 * Layout engine tests (build-phase step 3) — the IO orchestration end-to-end
 * with the memory repo + mock AI (NO redis, NO real provider): versioned
 * persistence, `layout:updated` emission, AI-failure fallback to solver-only,
 * the mock-hints winning path, and the per-team debouncer (fake timers).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CARD_CONFIG,
  layoutUpdatedSchema,
  LAYOUT_DEBOUNCE_MS,
  type CardConfig,
  type Placement,
} from "@cardcrafters/shared";

import { createAiRouter, type AiRouter } from "../ai/router";
import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import {
  computeAndPersistLayout,
  createLayoutDebouncer,
  type LayoutEmit,
} from "./engine";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

interface RecordedEmit {
  event: "layout:updated";
  payload: Record<string, unknown>;
  ctx: { gameId: string; teamId: string };
}

interface Setup {
  repo: MemoryRepo;
  ai: AiRouter;
  gameId: string;
  teamId: string;
  events: RecordedEmit[];
  emit: LayoutEmit;
}

async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const io: RoomEmitter = { to: () => ({ emit() {} }) };
  const hub = new GameHub(repo, io);
  const { game } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 1 });
  const team = (await repo.listTeams(game.id))[0]!;

  const ai = await createAiRouter({
    repo,
    env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
  });

  const events: RecordedEmit[] = [];
  const emit: LayoutEmit = (event, payload, ctx) => events.push({ event, payload, ctx });
  return { repo, ai, gameId: game.id, teamId: team.id, events, emit };
}

/** Persist a READY item with real dimensions straight through the repo. */
async function readyItem(
  repo: MemoryRepo,
  teamId: string,
  round: number,
  i: number,
): Promise<string> {
  const item = await repo.createItem({
    teamId,
    playerId: `player-${i}`,
    round,
    promptRaw: `layout-test prompt ${i}`,
    subject: `sticker ${i}`,
    status: "READY",
  });
  await repo.updateItem(item.id, {
    width: 256,
    height: 256,
    visualWeight: 0.3 + 0.1 * i,
  });
  return item.id;
}

describe("computeAndPersistLayout (memory repo + mock AI)", () => {
  it("one READY item → layout version 1, item placed, layout:updated emitted", async () => {
    const s = await setup();
    const itemId = await readyItem(s.repo, s.teamId, 1, 0);

    const res = await computeAndPersistLayout({ repo: s.repo, ai: s.ai, emit: s.emit }, s.gameId, s.teamId);
    expect(res).not.toBeNull();
    expect(res!.version).toBe(1);
    expect(res!.placements.map((p) => p.itemId)).toContain(itemId);

    const stored = await s.repo.getLayoutState(s.teamId, 1);
    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(1);
    expect(stored!.placements.map((p) => p.itemId)).toContain(itemId);

    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.event).toBe("layout:updated");
    expect(s.events[0]!.ctx).toEqual({ gameId: s.gameId, teamId: s.teamId });
    const payload = s.events[0]!.payload as { version: number; placements: Placement[] };
    expect(payload.version).toBe(1);
    expect(payload.placements.map((p) => p.itemId)).toContain(itemId);
    expect(layoutUpdatedSchema.parse(s.events[0]!.payload)).toBeTruthy();
  });

  it("a second READY item → version 2 with BOTH items placed", async () => {
    const s = await setup();
    const first = await readyItem(s.repo, s.teamId, 1, 0);
    await computeAndPersistLayout({ repo: s.repo, ai: s.ai, emit: s.emit }, s.gameId, s.teamId);

    const second = await readyItem(s.repo, s.teamId, 1, 1);
    const res = await computeAndPersistLayout({ repo: s.repo, ai: s.ai, emit: s.emit }, s.gameId, s.teamId);
    expect(res!.version).toBe(2);
    const ids = res!.placements.map((p) => p.itemId);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids).toHaveLength(2);

    const stored = await s.repo.getLayoutState(s.teamId, 1);
    expect(stored!.version).toBe(2);
    expect(s.events.map((e) => (e.payload as { version: number }).version)).toEqual([1, 2]);
  });

  it("AI hints failure (layout_composition throws) → still succeeds, source 'solver'", async () => {
    const s = await setup();
    const itemId = await readyItem(s.repo, s.teamId, 1, 0);
    const flakyAi: AiRouter = {
      run: async (
        task: string,
        input: Record<string, unknown>,
        opts?: { gameId?: string },
      ) => {
        if (task === "layout_composition") {
          throw new Error("all layout models failed");
        }
        return s.ai.run(task, input, opts);
      },
    } as unknown as AiRouter;

    const res = await computeAndPersistLayout({ repo: s.repo, ai: flakyAi, emit: s.emit }, s.gameId, s.teamId);
    expect(res).not.toBeNull();
    expect(res!.source).toBe("solver");
    expect(res!.placements.map((p) => p.itemId)).toContain(itemId);
    expect(s.events).toHaveLength(1);
  });

  it("accepted mock hints → source 'llm+solver'", async () => {
    const s = await setup();
    await readyItem(s.repo, s.teamId, 1, 0);
    // Verified against the seeded mock provider: for these inputs its golden-
    // ratio composition wins the engine's with-vs-without score comparison,
    // so the hints path (not the fallback) is exercised deterministically.
    const res = await computeAndPersistLayout({ repo: s.repo, ai: s.ai, emit: s.emit }, s.gameId, s.teamId);
    expect(res).not.toBeNull();
    expect(res!.source).toBe("llm+solver");
  });
});

describe("createLayoutDebouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("3 rapid schedules for one team collapse into ONE run after 1.5s", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deb = createLayoutDebouncer(run);

    const ctx = { gameId: "g1", teamId: "t1" };
    deb.schedule(ctx);
    deb.schedule(ctx);
    deb.schedule(ctx);
    expect(deb.pending()).toEqual(["t1"]);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LAYOUT_DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(ctx);
    expect(deb.pending()).toEqual([]);
  });

  it("a different teamId schedules independently (own timer, own ctx)", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deb = createLayoutDebouncer(run);

    deb.schedule({ gameId: "g1", teamId: "t1" });
    await vi.advanceTimersByTimeAsync(LAYOUT_DEBOUNCE_MS / 2);
    deb.schedule({ gameId: "g1", teamId: "t2" });
    expect(deb.pending()).toEqual(["t1", "t2"]);

    // t1 fires on its original schedule; t2 still pending.
    await vi.advanceTimersByTimeAsync(LAYOUT_DEBOUNCE_MS / 2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ gameId: "g1", teamId: "t1" });
    expect(deb.pending()).toEqual(["t2"]);

    await vi.advanceTimersByTimeAsync(LAYOUT_DEBOUNCE_MS / 2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({ gameId: "g1", teamId: "t2" });
  });

  it("flushAll() runs pending computes immediately and clears timers", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deb = createLayoutDebouncer(run);

    deb.schedule({ gameId: "g1", teamId: "t1" });
    deb.schedule({ gameId: "g1", teamId: "t2" });
    expect(deb.pending()).toEqual(["t1", "t2"]);

    await deb.flushAll();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith({ gameId: "g1", teamId: "t1" });
    expect(run).toHaveBeenCalledWith({ gameId: "g1", teamId: "t2" });
    expect(deb.pending()).toEqual([]);

    // The flushed timers must NOT fire later.
    await vi.advanceTimersByTimeAsync(LAYOUT_DEBOUNCE_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});