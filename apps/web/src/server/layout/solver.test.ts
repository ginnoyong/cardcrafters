/**
 * Layout solver tests (build-phase step 3) — mulberry32-seeded, deterministic:
 * convergence (1 / 5 / 25 items), constraint satisfaction via checkLayout,
 * seeded-random baseline comparison, LLM-hint focal pulling, text-zone
 * reservation, and seed determinism.
 */

import { describe, expect, it } from "vitest";

import {
  CARD_COORD_SPACE,
  layoutCompositionSchema,
  MIN_ITEM_SIZE_PCT,
  SOLO_ITEM_COVERAGE,
  TOTAL_COVERAGE_TARGET,
  type Placement,
} from "@cardcrafters/shared";

import {
  cardBox,
  checkLayout,
  overlapCapFor,
  overlapRatio,
  placedBox,
  rotatedRectCorners,
  safeMargin,
  scaleWindow,
  textOverlapOk,
  type LayoutItem,
  type Rect,
} from "./constraints";
import { scoreLayout } from "./score";
import { mulberry32, perItemShare, solveLayout } from "./solver";

const card = cardBox({ width: CARD_COORD_SPACE, height: CARD_COORD_SPACE }, 5, 7);
const K = (0.25 * Math.min(card.w, card.h)) / 256; // baseFit(card)
const TEXT_ZONE: Rect = { x: 0.1 * card.w, y: 0.06 * card.h, w: 0.8 * card.w, h: 0.16 * card.h };

function mkItem(id: string, overrides: Partial<LayoutItem> = {}): LayoutItem {
  return { id, imgW: 256, imgH: 256, visualWeight: 0.5, orderIndex: 0, ...overrides };
}

function items(n: number, weightFn?: (i: number) => number): LayoutItem[] {
  return Array.from({ length: n }, (_, i) =>
    mkItem(`i${i}`, {
      orderIndex: i,
      visualWeight: weightFn ? weightFn(i) : 0.5,
      imgW: 200 + (i % 3) * 60,
      imgH: 200 + ((i + 1) % 3) * 60,
    }),
  );
}

function solve(items: LayoutItem[], seed: number, textZone: Rect | null = TEXT_ZONE) {
  return solveLayout(items, {
    cardDims: card,
    k: K,
    textZone,
    rng: mulberry32(seed),
  });
}

/** Mean centroid of all placements (placement.x/y ARE the centroids). */
function centroid(placements: Placement[]): { x: number; y: number } {
  const x = placements.reduce((s, p) => s + p.x, 0) / placements.length;
  const y = placements.reduce((s, p) => s + p.y, 0) / placements.length;
  return { x, y };
}

describe("solveLayout — single item", () => {
  it("places one item, constraints pass, roughly centered (middle third)", () => {
    const item = mkItem("solo");
    const res = solve([item], 7);
    expect(res.placements).toHaveLength(1);
    expect(res.placements[0]!.itemId).toBe("solo");
    expect(
      checkLayout(res.placements, [item], { card, k: K, textZone: TEXT_ZONE }).ok,
    ).toBe(true);
    const c = centroid(res.placements);
    // The focal term (weight 0.35; focal = card center without hints) pulls a
    // solo item toward the middle; the reserved text zone keeps it lower.
    expect(c.x).toBeGreaterThan(card.w / 3);
    expect(c.x).toBeLessThan((2 / 3) * card.w);
    expect(c.y).toBeGreaterThan(card.h / 3);
    expect(c.y).toBeLessThan((2 / 3) * card.h);
  });
});

describe("solveLayout — five items", () => {
  it("places all five, constraints pass, beats a seeded random placement", () => {
    const its = items(5, (i) => 0.9 - i * 0.15);
    const res = solve(its, 123);
    expect(res.placements).toHaveLength(5);
    expect(new Set(res.placements.map((p) => p.itemId))).toEqual(
      new Set(its.map((i) => i.id)),
    );
    expect(
      checkLayout(res.placements, its, { card, k: K, textZone: TEXT_ZONE }).ok,
    ).toBe(true);

    // Seeded random baseline: in-bounds, min-size-ish, but unoptimized.
    const rng = mulberry32(321);
    const m = safeMargin(card);
    const randomPlacements: Placement[] = its.map((item) => {
      const { min } = scaleWindow(item, card, K);
      const scale = min * (1 + rng() * 0.5);
      const half = placedBox({ x: 0, y: 0, scale, rotation: 0 }, item, K);
      const hx = -half.x1;
      const hy = -half.y1;
      const x = m.x + hx + rng() * Math.max(0, card.w - 2 * m.x - 2 * hx);
      const y = m.y + hy + rng() * Math.max(0, card.h - 2 * m.y - 2 * hy);
      return { itemId: item.id, x, y, scale, rotation: 0, zIndex: item.orderIndex };
    });
    const randomScore = scoreLayout(randomPlacements, its, {
      card,
      k: K,
      textZone: null,
    });
    expect(res.score).toBeLessThanOrEqual(randomScore);
  });
});

describe("solveLayout — 25-item stress", () => {
  it("converges (all placed), constraints pass, nothing out of bounds", () => {
    const its = items(25, (i) => ((i * 37) % 100) / 100);
    const res = solve(its, 2024);
    expect(res.placements).toHaveLength(25);
    expect(res.relaxedMinSize).toBeLessThanOrEqual(MIN_ITEM_SIZE_PCT);
    expect(res.warnings.some((w) => w.includes("could not be placed"))).toBe(false);
    const check = checkLayout(res.placements, its, {
      card,
      k: K,
      textZone: TEXT_ZONE,
      minSizePct: res.relaxedMinSize,
    });
    expect(check.ok).toBe(true);
    // Belt and braces: no AABB may escape the card itself (never emitted).
    for (const p of res.placements) {
      const item = its.find((i) => i.id === p.itemId)!;
      const box = placedBox(p, item, K);
      expect(box.x1).toBeGreaterThanOrEqual(0);
      expect(box.y1).toBeGreaterThanOrEqual(0);
      expect(box.x2).toBeLessThanOrEqual(card.w);
      expect(box.y2).toBeLessThanOrEqual(card.h);
    }
  });
});

describe("solveLayout — LLM hints", () => {
  it("a bottom-left focal hint pulls the centroid toward that focal", () => {
    const its = items(6, (i) => 0.5);
    const focal = { x: 160, y: 840 }; // bottom-left of the 5:7 card space
    const hints = layoutCompositionSchema.parse({
      focalPoint: focal,
      groups: [{ itemIds: its.map((i) => i.id), cx: focal.x, cy: focal.y, spread: 160 }],
      textZone: TEXT_ZONE,
      suggestedGreetingStyle: { font: "Inter", color: "#1f2937", align: "center", y: 150 },
    });
    const withHints = solveLayout(its, {
      cardDims: card,
      k: K,
      textZone: TEXT_ZONE,
      hints,
      rng: mulberry32(55),
    });
    const withoutHints = solve(its, 55);
    expect(withHints.placements).toHaveLength(6);
    expect(withoutHints.placements).toHaveLength(6);
    const d = (c: { x: number; y: number }) => Math.hypot(c.x - focal.x, c.y - focal.y);
    expect(d(centroid(withHints.placements))).toBeLessThan(
      d(centroid(withoutHints.placements)),
    );
  });
});

describe("solveLayout — text zone reservation", () => {
  it("no placed AABB intersects the top greeting zone", () => {
    const its = items(5);
    const res = solve(its, 88);
    for (const p of res.placements) {
      const item = its.find((i) => i.id === p.itemId)!;
      expect(textOverlapOk(placedBox(p, item, K), TEXT_ZONE, card)).toBe(true);
    }
  });
});

describe("solveLayout — sizing policy v2 (coverage-proportional targets)", () => {
  /** Unrotated display width of a placement as a fraction of the card width. */
  const widthPct = (p: Placement, item: LayoutItem): number =>
    (item.imgW * p.scale * K) / card.w;

  /** Mean display width across a solved layout. */
  const avgWidth = (res: ReturnType<typeof solveLayout>, its: LayoutItem[]): number =>
    its.reduce(
      (s, it) => s + widthPct(res.placements.find((p) => p.itemId === it.id)!, it),
      0,
    ) / its.length;

  /** Max pairwise TRUE (SAT) overlap ratio across all emitted pairs. */
  const maxSatOverlap = (
    res: ReturnType<typeof solveLayout>,
    its: LayoutItem[],
  ): number => {
    const byId = new Map(its.map((i) => [i.id, i] as const));
    let max = 0;
    for (let i = 0; i < res.placements.length; i++) {
      for (let j = i + 1; j < res.placements.length; j++) {
        const a = byId.get(res.placements[i]!.itemId)!;
        const b = byId.get(res.placements[j]!.itemId)!;
        max = Math.max(
          max,
          overlapRatio(
            rotatedRectCorners(res.placements[i]!, a, K),
            rotatedRectCorners(res.placements[j]!, b, K),
          ),
        );
      }
    }
    return max;
  };

  /** n equal 256×256 square items, same weight (the measured configuration). */
  const squareItems = (n: number): LayoutItem[] =>
    Array.from({ length: n }, (_, i) => mkItem(`i${i}`, { orderIndex: i }));

  it("1 item → display width ≈ 75–85% of the card width", () => {
    const item = mkItem("solo");
    const res = solve([item], 7);
    expect(res.placements).toHaveLength(1);
    const w = widthPct(res.placements[0]!, item);
    expect(w).toBeGreaterThanOrEqual(0.75);
    expect(w).toBeLessThanOrEqual(0.85 + 1e-9); // +eps: the window max is exact
  });

  it("2 items (equal 256×256 squares) → both ≥ 0.50, mean ≥ 0.53, equalized, SAT ≤ 0.10", () => {
    // Measured (seeds 1..5, two equal 256×256 squares, true SAT overlap):
    // widths [0.550,0.553] / [0.537,0.550] / [0.536,0.538] / [0.503,0.551] /
    // [0.532,0.573] — every seed has both stickers ≥ 0.50, the worst
    // equalization ratio is 1.095, and the worst SAT pairwise overlap is
    // 0.100 (exactly at the cap, never above).
    const avgs: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const its = squareItems(2);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(2);
      const ws = its.map(
        (it) => widthPct(res.placements.find((p) => p.itemId === it.id)!, it),
      );
      for (const w of ws) expect(w, `seed ${seed}`).toBeGreaterThanOrEqual(0.50);
      // Size equalization: the pair stays balanced (measured ratio ≤ 1.095).
      const ratio = Math.max(...ws) / Math.min(...ws);
      expect(ratio, `seed ${seed}`).toBeLessThanOrEqual(1.25);
      avgs.push((ws[0]! + ws[1]!) / 2);
      // True rotated-rect overlap via the production SAT measure.
      expect(maxSatOverlap(res, its), `seed ${seed}`).toBeLessThanOrEqual(0.10);
    }
    const mean = avgs.reduce((s, v) => s + v, 0) / avgs.length;
    expect(mean).toBeGreaterThanOrEqual(0.53);
  });

  it("perItemShare curve: solo target, fill plateau, blend to the legacy split", () => {
    expect(perItemShare(1)).toBeCloseTo(SOLO_ITEM_COVERAGE, 9);
    expect(perItemShare(2)).toBeCloseTo(0.35, 9); // FILL_COVERAGE = 0.7
    expect(perItemShare(3)).toBeCloseTo(0.7 / 3, 9);
    expect(perItemShare(5)).toBeCloseTo(0.14, 9);
    // Fully back to the legacy TOTAL_COVERAGE_TARGET/n split from n = 12.
    expect(perItemShare(12)).toBeCloseTo(TOTAL_COVERAGE_TARGET / 12, 9);
    expect(perItemShare(25)).toBeCloseTo(TOTAL_COVERAGE_TARGET / 25, 9);
    // Monotone non-increasing in n and never above the solo target.
    let prev = Infinity;
    for (let n = 1; n <= 25; n++) {
      const s = perItemShare(n);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      expect(s).toBeLessThanOrEqual(SOLO_ITEM_COVERAGE);
      prev = s;
    }
  });

  it("3 items → mean width ≥ 0.45 with SAT overlap ≤ 0.10; 5 items ≥ 0.30", () => {
    // Measured (equal weights, seeds 1..5, true SAT measure): n=3 avg 0.477,
    // n=5 avg 0.356, SAT always ≤ 0.10. (The mixed-aspect PAIR ceiling is
    // ~0.46–0.50 width each — geometric; squares are the case the 0.55
    // target floor applies to.)
    for (const [n, floor] of [
      [3, 0.45],
      [5, 0.30],
    ] as const) {
      const perSeed: number[] = [];
      for (const seed of [1, 2, 3, 4, 5]) {
        const its = items(n);
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        perSeed.push(avgWidth(res, its));
        expect(maxSatOverlap(res, its), `n=${n} seed ${seed}`).toBeLessThanOrEqual(0.10);
      }
      const mean = perSeed.reduce((s, v) => s + v, 0) / perSeed.length;
      expect(mean, `n=${n}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("average display width curve is non-increasing 1→2→3→5→10→25 (0.02 flat tolerance)", () => {
    // Measured (3 seeds per n): 0.760 → 0.536 → 0.528 → 0.378 → 0.278 → 0.175.
    // The curve asserts NON-INCREASING with a 0.02 seed-noise tolerance at
    // every step.
    const avgs: number[] = [];
    for (const n of [1, 2, 3, 5, 10, 25]) {
      const perSeed: number[] = [];
      for (const seed of [1, 2, 3]) {
        const its = items(n, (i) => 0.5 + 0.05 * (i % 4));
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        perSeed.push(avgWidth(res, its));
      }
      avgs.push(perSeed.reduce((s, v) => s + v, 0) / perSeed.length);
    }
    for (let i = 1; i < avgs.length; i++) {
      expect(avgs[i]!).toBeLessThanOrEqual(avgs[i - 1]! + 0.02);
    }
  });

  it("checkLayout passes under the 0.10 overlap cap for every n = 1..25", () => {
    for (let n = 1; n <= 25; n++) {
      const its = items(n, (i) => 0.9 - ((i * 7) % 70) / 100);
      const res = solve(its, 1234 + n);
      expect(res.placements).toHaveLength(n);
      expect(
        checkLayout(res.placements, its, {
          card,
          k: K,
          textZone: TEXT_ZONE,
          overlapCap: overlapCapFor(n),
        }).ok,
      ).toBe(true);
    }
  });

  it("n = 2 lands diagonal/staggered across seeds (polar ring placement)", () => {
    // Polar ring candidates let the two big stickers stagger diagonally
    // instead of only axis-aligned left/right or top/bottom. Measured: 4/5
    // seeds have both |dx| and |dy| over 15% of the card dimension.
    let diagonal = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const its = items(2);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(2);
      const [a, b] = res.placements;
      const dx = Math.abs(a!.x - b!.x) / card.w;
      const dy = Math.abs(a!.y - b!.y) / card.h;
      if (dx > 0.15 && dy > 0.15) diagonal++;
    }
    expect(diagonal).toBeGreaterThanOrEqual(3);
  });
});

describe("solveLayout — determinism", () => {
  it("same seed → byte-identical placements JSON", () => {
    const its = items(7, (i) => 0.2 + 0.1 * i);
    const a = solve(its, 404);
    const b = solve(its, 404);
    expect(JSON.stringify(a.placements)).toBe(JSON.stringify(b.placements));
    expect(a.score).toBe(b.score);
    expect(a.relaxedMinSize).toBe(b.relaxedMinSize);
    // A different seed is (overwhelmingly) a different layout.
    const c = solve(its, 405);
    expect(JSON.stringify(c.placements)).not.toBe(JSON.stringify(a.placements));
  });
});