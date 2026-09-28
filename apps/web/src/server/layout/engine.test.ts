/**
 * Layout engine tests (build-phase step 3) — the IO orchestration end-to-end
 * with the memory repo + mock AI (NO redis, NO real provider): versioned
 * persistence, `layout:updated` emission, AI-failure fallback to solver-only,
 * the mock-hints winning path, and the per-team debouncer (fake timers).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CARD_CONFIG,
  layoutCompositionSchema,
  layoutUpdatedSchema,
  LAYOUT_DEBOUNCE_MS,
  type CardConfig,
  type LayoutComposition,
  type Placement,
} from "@cardcrafters/shared";

import {
  cardBox,
  baseFit,
  COORD_DIMS,
  type LayoutItem,
} from "./constraints";
import { solveLayout, mulberry32, hashString } from "./solver";

import { MockProvider } from "../ai/mock-provider";
import type { AiTaskName, TaskConfig } from "../ai/provider";
import { createAiRouter, type AiRouter } from "../ai/router";
import { GameHub, type RoomEmitter } from "../game/hub";
import { randomUUID } from "node:crypto";
import { MemoryRepo } from "../repo/memory-repo";
import {
  computeAndPersistLayout,
  createLayoutDebouncer,
  defaultTextZone,
  type LayoutEmit,
} from "./engine";
import { scoreLayout } from "./score";

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

/**
 * The Test-1 n=4 fixture: two DIAGONAL groups at strong (feasible) separation
 * — group A upper-left, group B lower-right — with the focal point at the
 * visualWeight-weighted CENTROID of the two group centers (NOT a fixed card
 * spot), tight spreads (20-40), per-item importance matching the visualWeight
 * ranking (rank 0 = focal, importance 1 … last rank = 1/n) and NO tiltToward
 * hints. Built from the REAL engine input (ids + card dims) so it is always
 * schema-valid and id-consistent. See the PATH NOTE in the test for why this
 * feeds the direct-hinted-solve assertion rather than the adopt-if-better
 * comparison.
 */
function twoDiagonalGroupsFixture(inp: {
  cardWidth: number;
  cardHeight: number;
  items: Array<{ id: string; w: number; h: number; visualWeight: number; orderIndex: number; subject: string }>;
}): LayoutComposition {
  const w = inp.cardWidth;
  const h = inp.cardHeight;
  const clampC = (v: number) => Math.min(h - 120, Math.max(120, v));
  const clampX = (v: number) => Math.min(w - 120, Math.max(120, v));
  // Diagonal offsets (probed: robust grouped output, min cross-vs-intra gap
  // ≥ ~100 card units across 25 random seeds).
  const dx = 0.32 * w;
  const dy = 0.16 * h;
  const cA = { x: clampX(0.5 * w - dx), y: clampC(0.65 * h - dy) }; // upper-left
  const cB = { x: clampX(0.5 * w + dx), y: clampC(0.65 * h + dy) }; // lower-right
  const groups = [
    { ids: [inp.items[0]!.id, inp.items[1]!.id], c: cA },
    { ids: [inp.items[2]!.id, inp.items[3]!.id], c: cB },
  ];
  // Focal = visualWeight-weighted centroid of the two group centers.
  const wA = inp.items[0]!.visualWeight + inp.items[1]!.visualWeight;
  const wB = inp.items[2]!.visualWeight + inp.items[3]!.visualWeight;
  const focal = {
    x: (wA * cA.x + wB * cB.x) / (wA + wB),
    y: (wA * cA.y + wB * cB.y) / (wA + wB),
  };
  // Importance matches the visualWeight ranking (desc): rank 0 = focal.
  const rankOrder = [...inp.items.keys()].sort(
    (a, b) =>
      inp.items[b]!.visualWeight - inp.items[a]!.visualWeight ||
      inp.items[a]!.orderIndex - inp.items[b]!.orderIndex,
  );
  const hints = inp.items.map((it, i) => ({
    itemId: it.id,
    role: (rankOrder[0] === i ? "focal" : "support") as "focal" | "support",
    importance: (inp.items.length - rankOrder.indexOf(i)) / inp.items.length,
  }));
  return layoutCompositionSchema.parse({
    focalPoint: focal,
    groups: groups.map((g, gi) => ({
      itemIds: g.ids,
      cx: g.c.x,
      cy: g.c.y,
      spread: 35,
      subject: `pair ${gi === 0 ? "A" : "B"}`,
    })),
    hints,
    textZone: defaultTextZone({ w, h }),
    suggestedGreetingStyle: {
      font: "Inter",
      color: "#1f2937",
      align: "center",
      y: defaultTextZone({ w, h }).y + defaultTextZone({ w, h }).h / 2,
    },
  });
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

  it("forwards each item's subject to the layout_composition input", async () => {
    const s = await setup();
    await readyItem(s.repo, s.teamId, 1, 0); // subject: "sticker 0"
    let captured: Record<string, unknown> | null = null;
    const capturingAi: AiRouter = {
      run: async (task: Parameters<AiRouter["run"]>[0], input: Record<string, unknown>, opts?: { gameId?: string }) => {
        if (task === "layout_composition") {
          captured = input;
          // Fail AFTER capturing so the solver-only fallback still runs.
          throw new Error("captured");
        }
        return s.ai.run(task, input, opts);
      },
    } as unknown as AiRouter;
    await computeAndPersistLayout({ repo: s.repo, ai: capturingAi, emit: s.emit }, s.gameId, s.teamId);
    expect(captured).not.toBeNull();
    const items = (captured as unknown as { items: Array<{ id: string; subject: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.subject).toBe("sticker 0");
  });

  it("mock hint groups flow through: solveLayout with group hints → intra-pair mean < cross-pair mean", async () => {
    // PATH NOTE (orchestrator decision): this test FIRST tried to win the
    // engine's with-vs-without "adopt-if-better" comparison with a crafted
    // n=4 two-group fixture (two DIAGONAL groups, focal = the visualWeight-
    // weighted centroid of the group centers, tight spreads 20-40, importance
    // matching visualWeight desc, no tiltToward). Honest probes (temporary
    // scripts-tmp sweeps over max-feasible-separation corners AND off-center
    // diagonal variants, 20-25 random-UUID seeds each) measured at most ~3/25
    // wins « the 90% bar: the without-hints run scatters items over the whole
    // card so its focal term stays ~0.37 of half-diagonal for ANY fixture
    // focal, while the split-groups hint layout's best-possible focal term is
    // ~0.475 × (group separation) / half-diagonal — separation itself makes
    // the hint run LOSE the focal term, and the card corners add edge
    // penalties. So per the orchestrator decision this test FALLS BACK to the
    // direct-hinted-solve assertion: `solveLayout(items, { hints: fixture })`
    // must produce grouped output (intra-pair mean < cross-pair mean, i.e.
    // the cohesion term is active and effective). The adopt-if-better engine
    // logic itself stays covered by the n=1 mock hint-win tests below.
    const s = await setup();
    const itemIds: string[] = [];
    for (let i = 0; i < 4; i++) itemIds.push(await readyItem(s.repo, s.teamId, 1, i));

    // Engine-level flow: a fake-AI router wrapper whose layout_composition
    // returns the fixture built from the REAL engine input (item ids, card
    // dims) — same wrapper shape the mock provider answers through.
    let fixture: LayoutComposition | null = null;
    const fixtureAi: AiRouter = {
      run: async (task: Parameters<AiRouter["run"]>[0], input: Record<string, unknown>, opts?: { gameId?: string }) => {
        if (task === "layout_composition") {
          const inp = input as {
            cardWidth: number;
            cardHeight: number;
            items: Array<{ id: string; w: number; h: number; visualWeight: number; orderIndex: number; subject: string }>;
          };
          fixture = twoDiagonalGroupsFixture(inp);
          return { data: fixture };
        }
        return s.ai.run(task, input, opts);
      },
    } as unknown as AiRouter;
    const res = await computeAndPersistLayout({ repo: s.repo, ai: fixtureAi, emit: s.emit }, s.gameId, s.teamId);
    expect(res).not.toBeNull();
    expect(res!.placements).toHaveLength(4);
    expect(fixture).not.toBeNull();

    // Direct-hinted-solve assertion (engine-identical card/fit/zone/seed):
    // the group-aware solver must pull each ADJACENT INDEX PAIR — (0,1) and
    // (2,3), the mock's grouping — to near-touching while different groups
    // keep breathing room, so the intra-pair MEAN distance undercuts the
    // cross-pair MEAN distance (probed margin ≥ 100 card units on this
    // fixture across 25 random seeds).
    const card = cardBox(COORD_DIMS, UNTIMED_CONFIG.cardRatioW, UNTIMED_CONFIG.cardRatioH);
    const items: LayoutItem[] = itemIds.map((id, i) => ({
      id,
      imgW: 256,
      imgH: 256,
      visualWeight: 0.3 + 0.1 * i,
      orderIndex: i,
      subject: `sticker ${i}`,
    }));
    const solved = solveLayout(items, {
      cardDims: card,
      k: baseFit(card),
      textZone: defaultTextZone(card),
      hints: fixture!,
      rng: mulberry32(hashString(`${s.teamId}:1`)),
    });
    const byId = new Map(solved.placements.map((p) => [p.itemId, p] as const));
    const d = (a: string, b: string) => {
      const pa = byId.get(a)!;
      const pb = byId.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    const [i0, i1, i2, i3] = itemIds;
    const intraMean = (d(i0!, i1!) + d(i2!, i3!)) / 2;
    const crossMean =
      (d(i0!, i2!) + d(i0!, i3!) + d(i1!, i2!) + d(i1!, i3!)) / 4;
    expect(intraMean).toBeLessThan(crossMean);
  });

  it("mock 30/30 n=1 hint-win preserved: direct solve loop, ≥ 29/30 seeds win the with-vs-without comparison", async () => {
    // Direct-solver loop (NO hub): rebuild the n=1 composition exactly like
    // mockLayoutComposition produces it — the REAL mock provider answers the
    // engine-shaped input with MOCK_AI_DELAY_MS=0 — then run the engine's
    // own with-vs-without comparison across 30 random-UUID seeds. Together
    // with the engine-level "accepted mock hints → source 'llm+solver'" test
    // this keeps the hint-adoption behavior covered.
    const provider = new MockProvider({ env: { MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } });
    const cfg: TaskConfig = {
      name: "layout_composition" as AiTaskName,
      primary: "mock",
      fallbacks: [],
      temperature: 0,
      maxTokens: 100,
      timeoutMs: 1000,
      retries: 0,
      structured: null,
      enabled: true,
    };
    const card = cardBox(COORD_DIMS, UNTIMED_CONFIG.cardRatioW, UNTIMED_CONFIG.cardRatioH);
    const k = baseFit(card);
    const textZone = defaultTextZone(card);

    let wins = 0;
    const SEEDS = 30;
    for (let i = 0; i < SEEDS; i++) {
      const teamId = randomUUID(); // engine seed source: hashString(`${teamId}:${round}`)
      const itemId = randomUUID(); // mock seed source: hashString(JSON.stringify(input))
      const input = {
        cardWidth: card.w,
        cardHeight: card.h,
        textHint: "",
        items: [
          {
            id: itemId,
            w: 256,
            h: 256,
            visualWeight: 0.3 + 0.1 * i,
            orderIndex: 0,
            subject: `sticker ${i}`,
          },
        ],
      };
      const res = await provider.run("layout_composition", input, cfg);
      const hints = layoutCompositionSchema.parse(res.data);
      const items: LayoutItem[] = [
        {
          id: itemId,
          imgW: 256,
          imgH: 256,
          visualWeight: 0.3 + 0.1 * i,
          orderIndex: 0,
          subject: `sticker ${i}`,
        },
      ];
      const seed = hashString(`${teamId}:1`);
      const withHints = solveLayout(items, { cardDims: card, k, textZone, hints, rng: mulberry32(seed) });
      const without = solveLayout(items, { cardDims: card, k, textZone, rng: mulberry32(seed) });
      const sctx = {
        card,
        k,
        textZone,
        focalPoint: hints.focalPoint,
        clustered: hints.groups.length > 1,
      };
      const sw = scoreLayout(withHints.placements, items, sctx);
      const so = scoreLayout(without.placements, items, sctx);
      if (sw <= so) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(SEEDS - 1);
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