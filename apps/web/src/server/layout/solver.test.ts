/**
 * Layout solver tests (build-phase step 3) — mulberry32-seeded, deterministic:
 * convergence (1 / 5 / 25 items), constraint satisfaction via checkLayout,
 * seeded-random baseline comparison, LLM-hint focal pulling, text-zone
 * reservation, seed determinism, and the hero-montage policy (dominant hero
 * + orbiting supports, 0.5×hero support floor, hero tuck-overlap cap).
 */

import { describe, expect, it } from "vitest";

import {
  CARD_COORD_SPACE,
  layoutCompositionSchema,
  MIN_ITEM_SIZE_PCT,
  SOLO_ITEM_COVERAGE,
  TOTAL_COVERAGE_TARGET,
  type LayoutComposition,
  type Placement,
} from "@cardcrafters/shared";

import {
  cardBox,
  checkLayout,
  HERO_TUCK_CAP,
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
import { heroItemIdOf, mulberry32, perItemShare, solveLayout } from "./solver";

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

/**
 * Hero-aware ConstraintCtx for checkLayout (hero-montage policy): pairs
 * involving the HERO measure against the HERO_TUCK_CAP (0.25) tuck tolerance;
 * support–support pairs keep overlapCapFor(n) (0.10). `hints` (optional) is
 * forwarded to heroItemIdOf so focal-hint designation is honored.
 */
function heroAwareCheck(
  res: ReturnType<typeof solveLayout>,
  its: LayoutItem[],
  hints?: LayoutComposition | null,
  minSizePct?: number,
): ReturnType<typeof checkLayout> {
  return checkLayout(res.placements, its, {
    card,
    k: K,
    textZone: TEXT_ZONE,
    ...(minSizePct !== undefined ? { minSizePct } : {}),
    overlapCap: overlapCapFor(its.length),
    heroItemId: heroItemIdOf(its, hints ?? null) ?? undefined,
    heroOverlapCap: HERO_TUCK_CAP,
  });
}

/**
 * Max pairwise TRUE (SAT) overlap ratio, split by pair kind (hero-montage):
 * `heroPairs` = pairs involving the hero (cap HERO_TUCK_CAP = 0.25),
 * `otherPairs` = support–support pairs (cap 0.10).
 */
function maxSatByPairKind(
  res: ReturnType<typeof solveLayout>,
  its: LayoutItem[],
  hints?: LayoutComposition | null,
): { heroPairs: number; otherPairs: number } {
  const byId = new Map(its.map((i) => [i.id, i] as const));
  const heroId = heroItemIdOf(its, hints ?? null);
  let heroPairs = 0;
  let otherPairs = 0;
  for (let i = 0; i < res.placements.length; i++) {
    for (let j = i + 1; j < res.placements.length; j++) {
      const a = res.placements[i]!;
      const b = res.placements[j]!;
      const r = overlapRatio(
        rotatedRectCorners(a, byId.get(a.itemId)!, K),
        rotatedRectCorners(b, byId.get(b.itemId)!, K),
      );
      if (heroId !== null && (a.itemId === heroId || b.itemId === heroId)) {
        heroPairs = Math.max(heroPairs, r);
      } else {
        otherPairs = Math.max(otherPairs, r);
      }
    }
  }
  return { heroPairs, otherPairs };
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
    // CHANGED (hero-montage policy): the ctx is hero-aware — pairs involving
    // the hero measure against the HERO_TUCK_CAP (0.25) tuck tolerance, not
    // the plain 0.10 cap (the solver legitimately tucks supports up to 25%
    // behind the dominant hero).
    expect(heroAwareCheck(res, its).ok).toBe(true);

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
    const check = heroAwareCheck(res, its, null, res.relaxedMinSize);
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
    // CHANGED (hero-montage policy): supports now ORBIT THE HERO (hero-centered
    // polar rings), so the MEAN centroid is no longer the right signal for
    // "the hint pulled the composition" — the hero IS the composition anchor.
    // The assertion is now: the HERO lands closer to the hinted focal with the
    // hint than without it. Measured (seed 55, hero = i0): hero→focal 128.4px
    // with hints vs 338.5px without (seeds 1/2/3: 75.2/165.4/135.8 vs
    // 282.5/392.7/396.3).
    const heroId = heroItemIdOf(its, null)!;
    const dHero = (res: ReturnType<typeof solveLayout>) => {
      const hp = res.placements.find((p) => p.itemId === heroId)!;
      return Math.hypot(hp.x - focal.x, hp.y - focal.y);
    };
    expect(dHero(withHints)).toBeLessThan(dHero(withoutHints));
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

  it("2 items (equal 256×256 squares) → hero-policy: hero 0.60–0.70, supports ≥ 0.45, hero–support SAT ≤ 0.25, support–support ≤ 0.10", () => {
    // CHANGED (hero-montage policy — replaces the old equalized-pair block
    // [both ≥ 0.50, mean ≥ 0.53, ratio ≤ 1.25, SAT ≤ 0.10 for ALL pairs]: the
    // pair is no longer equalized BY DESIGN — the hero is dominant at
    // HERO_WIDTH_TARGET = 0.65 and the support may TUCK up to 25% behind it).
    // Measured (seeds 1..5, two equal 256×256 squares, true SAT overlap):
    // hero 0.645–0.669, supports 0.520–0.553, hero–support SAT ≤ 0.249
    // (inside the HERO_TUCK_CAP = 0.25 tuck tolerance), support–support SAT
    // 0.000.
    for (const seed of [1, 2, 3, 4, 5]) {
      const its = squareItems(2);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(2);
      const heroId = heroItemIdOf(its, null)!;
      const heroW = widthPct(
        res.placements.find((p) => p.itemId === heroId)!,
        its.find((i) => i.id === heroId)!,
      );
      expect(heroW, `seed ${seed} hero`).toBeGreaterThanOrEqual(0.60);
      expect(heroW, `seed ${seed} hero`).toBeLessThanOrEqual(0.70);
      const sup = its.find((i) => i.id !== heroId)!;
      const supW = widthPct(res.placements.find((p) => p.itemId === sup.id)!, sup);
      expect(supW, `seed ${seed} support`).toBeGreaterThanOrEqual(0.45);
      // True rotated-rect overlap via the production SAT measure, split by
      // pair kind: hero pairs ride the 0.25 tuck cap, support pairs stay 0.10.
      const sat = maxSatByPairKind(res, its);
      expect(sat.heroPairs, `seed ${seed} hero–support SAT`).toBeLessThanOrEqual(
        0.25 + 1e-6,
      );
      expect(sat.otherPairs, `seed ${seed} support–support SAT`).toBeLessThanOrEqual(
        0.10 + 1e-6,
      );
    }
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

  it("3 items → hero ≈0.65 & supports ≥ 0.40; 4–5 items → hero 0.60–0.65, mean support 0.29–0.42 (hero-aware SAT caps)", () => {
    // CHANGED (hero-montage policy — replaces the old mean-width floors
    // [n=3 ≥ 0.45, n=5 ≥ 0.30 over ALL items, SAT ≤ 0.10 for ALL pairs]): the
    // mean now mixes ONE dominant hero with smaller orbiting supports, so the
    // hero and the support band are asserted separately, and hero pairs ride
    // the 0.25 tuck cap. Also switched from the mixed-aspect `items(n)` to
    // the equal-square `squareItems(n)` measured configuration (mixed-aspect
    // mean-width coverage remains in the avg-width curve test below).
    // Measured (seeds 1..5, true SAT measure):
    //   n=3: hero 0.649–0.665, supports (min) 0.424–0.459, hero-pair SAT
    //        ≤ 0.249, support–support SAT ≤ 0.094.
    //   n=4: hero 0.605–0.651, mean support 0.368–0.415 (min 0.316–0.407).
    //   n=5: hero 0.639–0.651, mean support 0.309–0.354 (min 0.219–0.339).
    // The 0.5×hero support floor is a SOFT resolution at n=4–5: where the
    // floored scale is geometrically infeasible in every cell, the per-cell
    // ladder resolves below the floor (hard bounds/overlap/minSize always
    // win) — measured min support 0.219 at n=5 = 0.337× the hero (see the
    // dedicated floor-resolution test in the hero-montage describe).
    for (const [n, heroMin, heroMax, supMin, supAvgMin] of [
      [3, 0.60, 0.70, 0.40, 0.40],
      [4, 0.60, 0.70, 0.30, 0.29],
      [5, 0.60, 0.70, 0.20, 0.29],
    ] as const) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const its = squareItems(n);
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        const heroId = heroItemIdOf(its, null)!;
        const heroW = widthPct(
          res.placements.find((p) => p.itemId === heroId)!,
          its.find((i) => i.id === heroId)!,
        );
        expect(heroW, `n=${n} seed ${seed} hero`).toBeGreaterThanOrEqual(heroMin);
        expect(heroW, `n=${n} seed ${seed} hero`).toBeLessThanOrEqual(heroMax);
        const supWs = its
          .filter((i) => i.id !== heroId)
          .map((i) => widthPct(res.placements.find((p) => p.itemId === i.id)!, i));
        expect(
          Math.min(...supWs),
          `n=${n} seed ${seed} min support`,
        ).toBeGreaterThanOrEqual(supMin);
        const supAvg = supWs.reduce((s, v) => s + v, 0) / supWs.length;
        expect(supAvg, `n=${n} seed ${seed} mean support`).toBeGreaterThanOrEqual(supAvgMin);
        // Hero-aware SAT caps: hero pairs ≤ 0.25 tuck, support pairs ≤ 0.10.
        const sat = maxSatByPairKind(res, its);
        expect(sat.heroPairs, `n=${n} seed ${seed} hero–support SAT`).toBeLessThanOrEqual(
          0.25 + 1e-6,
        );
        expect(sat.otherPairs, `n=${n} seed ${seed} support–support SAT`).toBeLessThanOrEqual(
          0.10 + 1e-6,
        );
      }
    }
  });

  it("average display width curve is non-increasing 1→2→3→5→10→25 (0.02 flat tolerance)", () => {
    // CHANGED (hero-montage policy): re-measured curve (3 seeds per n) is
    // 0.780 → 0.529 → 0.522 → 0.351 → 0.260 → 0.169 (was 0.760 → 0.536 →
    // 0.528 → 0.378 → 0.278 → 0.175). The hero policy HOLDS UP n=2–3 (the
    // dominant 0.65-width hero lifts the mean over the old equalized pair),
    // n=5 drops a bit (smaller supports), and n ≥ 6 follows the legacy
    // per-item share curve. The assertion is unchanged: NON-INCREASING with
    // a 0.02 seed-noise tolerance at every step.
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

  it("checkLayout passes under hero-aware caps (hero tuck 0.25 / others 0.10) for every n = 1..25", () => {
    // CHANGED (hero-montage policy): the ctx is hero-aware — pairs involving
    // the hero measure against the HERO_TUCK_CAP (0.25) tuck tolerance,
    // support–support pairs keep overlapCapFor(n) (0.10).
    for (let n = 1; n <= 25; n++) {
      const its = items(n, (i) => 0.9 - ((i * 7) % 70) / 100);
      const res = solve(its, 1234 + n);
      expect(res.placements).toHaveLength(n);
      expect(heroAwareCheck(res, its).ok).toBe(true);
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

describe("solveLayout — group-aware solver (semantic grouping)", () => {
  /** Build a LayoutComposition hint object for the given groups/itemHints. */
  function hintsFor(
    groups: Array<{ ids: string[]; cx: number; cy: number; spread: number }>,
    itemHints: Array<{ itemId: string; role?: "focal" | "support"; tiltToward?: string; importance?: number }> = [],
    focal?: { x: number; y: number },
  ) {
    return layoutCompositionSchema.parse({
      focalPoint: focal ?? { x: card.w / 2, y: card.h * 0.6 },
      groups: groups.map((g) => ({ itemIds: g.ids, cx: g.cx, cy: g.cy, spread: g.spread })),
      hints: itemHints,
      textZone: TEXT_ZONE,
      suggestedGreetingStyle: { align: "center", y: 150 },
    });
  }

  /** Center distance between two placements (centers ARE x/y). */
  const dist = (a: Placement, b: Placement): number => Math.hypot(a.x - b.x, a.y - b.y);

  /** Placed half-extent of a square item = half its display width. */
  const halfOf = (p: Placement, item: LayoutItem): number => (item.imgW * p.scale * K) / 2;

  // CHANGED (hero-montage policy): SAT overlaps are now measured per pair
  // kind via the shared maxSatByPairKind (hero pairs ≤ 0.25 tuck cap,
  // support–support ≤ 0.10).

  it("cohesion: 2 same-group items sit near-touching (d ≤ 1.3×(halfA+halfB)), constraints pass", () => {
    // Measured (seeds 1..5, equal 256×256 squares, cohesion target 1.15×):
    // the pair equilibrates at ≈ 1.15–1.2× (halfA+halfB) — the cohesion term
    // (W=1.0) dominates the spacing term's comfort distance (≈ 1.31× with
    // rotation-inflated AABBs) below the target.
    const its = [mkItem("a"), mkItem("b", { orderIndex: 1 })];
    const hints = hintsFor([{ ids: ["a", "b"], cx: card.w / 2, cy: card.h * 0.55, spread: 140 }]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const res = solveLayout(its, {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(seed),
      });
      expect(res.placements).toHaveLength(2);
      const pa = res.placements.find((p) => p.itemId === "a")!;
      const pb = res.placements.find((p) => p.itemId === "b")!;
      const halfSum = halfOf(pa, its[0]!) + halfOf(pb, its[1]!);
      const d = dist(pa, pb);
      expect(d, `seed ${seed} d/halfSum=${(d / halfSum).toFixed(2)}`).toBeLessThanOrEqual(
        1.3 * halfSum + 1e-9,
      );
      // CHANGED (hero-montage policy): the only pair here INVOLVES THE HERO
      // ("a" is the hero — highest weight), so it rides the 0.25 tuck cap.
      const sat = maxSatByPairKind(res, its);
      expect(sat.heroPairs, `seed ${seed} hero–support SAT`).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(sat.otherPairs, `seed ${seed} support–support SAT`).toBeLessThanOrEqual(0.10 + 1e-6);
      // CHANGED: hero-aware checkLayout ctx (tuck cap for the hero pair).
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  });

  it("separation: 2 different-group items keep breathing room (d ≥ 1.10×(halfA+halfB))", () => {
    // CHANGED (hero-montage policy): "a" (visualWeight 0.8) is the HERO — it
    // now solves DOMINANT (≈0.65 of the card width, was ~0.55), so halfSum
    // grew and the relative center distance dropped. Measured (seeds 1..5):
    // d/halfSum = 1.340 / 1.389 / 1.146 / 1.285 / 1.264 (was ≥ 1.4 with the
    // old equalized sizing) — still clear breathing room around the bigger
    // hero, asserted at the re-measured 1.10× floor. ("a" is the hero by the
    // equal-weight orderIndex tie-break — same items as before.)
    const its = [mkItem("a"), mkItem("b", { orderIndex: 1 })];
    const hints = hintsFor([
      { ids: ["a"], cx: card.w * 0.3, cy: card.h * 0.55, spread: 90 },
      { ids: ["b"], cx: card.w * 0.7, cy: card.h * 0.55, spread: 90 },
    ]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const res = solveLayout(its, {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(seed),
      });
      expect(res.placements).toHaveLength(2);
      const pa = res.placements.find((p) => p.itemId === "a")!;
      const pb = res.placements.find((p) => p.itemId === "b")!;
      const halfSum = halfOf(pa, its[0]!) + halfOf(pb, its[1]!);
      const d = dist(pa, pb);
      expect(d, `seed ${seed} d/halfSum=${(d / halfSum).toFixed(2)}`).toBeGreaterThanOrEqual(
        1.1 * halfSum - 1e-9,
      );
      const sat = maxSatByPairKind(res, its);
      expect(sat.heroPairs, `seed ${seed} hero–support SAT`).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(sat.otherPairs, `seed ${seed} support–support SAT`).toBeLessThanOrEqual(0.10 + 1e-6);
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  });

  it("orientation: B with tiltToward A faces A (rotation within ±20° of the angle toward A)", () => {
    // Geometry: A's group is anchored top-right, B's bottom-left — the
    // separation + focal terms park A and B in opposite corners, so the
    // angle from B to A is a robust ≈ −55° diagonal (NOT the ≈ 0° horizontal
    // arrangement a single shared group produces, where correctly facing A
    // coincides with rotation ≈ 0 and the assertion would be vacuous).
    const its = [
      mkItem("a", { visualWeight: 0.8, orderIndex: 0 }),
      mkItem("b", { visualWeight: 0.4, orderIndex: 1 }),
    ];
    const hints = hintsFor(
      [
        { ids: ["a"], cx: card.w * 0.72, cy: card.h * 0.32, spread: 140 },
        { ids: ["b"], cx: card.w * 0.28, cy: card.h * 0.72, spread: 140 },
      ],
      [{ itemId: "b", tiltToward: "a", importance: 0.4 }],
    );
    // textZone: TEXT_ZONE stays — this tilt test runs WITH the zone; only the
    // constructed-geometry tuck test above uses textZone: null.
    for (const seed of [1, 2, 3, 4, 5]) {
      const res = solveLayout(its, {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(seed),
      });
      expect(res.placements).toHaveLength(2);
      const pa = res.placements.find((p) => p.itemId === "a")!;
      const pb = res.placements.find((p) => p.itemId === "b")!;
      const angToA =
        ((Math.atan2(pa.y - pb.y, pa.x - pb.x) * 180) / Math.PI + 540) % 360 - 180;
      const dev = Math.abs(((pb.rotation - angToA + 540) % 360) - 180);
      expect(dev, `seed ${seed} rot=${pb.rotation} ang=${angToA.toFixed(1)}`).toBeLessThanOrEqual(
        20 + 1e-9,
      );
      // B visibly TILTED (a diagonal target angle → rotation far from 0;
      // the pre-hint policy would keep it within ±12°).
      expect(Math.abs(pb.rotation), `seed ${seed} rot=${pb.rotation}`).toBeGreaterThan(12);
      // CHANGED (hero-montage policy): hero-aware checkLayout ctx — the
      // hero-involving pair rides the 0.25 tuck cap.
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  });

  it("sizes: the group's focal item gets ≥ the support's width (importance ordering)", () => {
    const its = [
      mkItem("a", { visualWeight: 0.8, orderIndex: 0 }),
      mkItem("b", { visualWeight: 0.4, orderIndex: 1 }),
    ];
    const hints = hintsFor(
      [{ ids: ["a", "b"], cx: card.w / 2, cy: card.h * 0.58, spread: 140 }],
      [
        { itemId: "a", role: "focal", importance: 1 },
        { itemId: "b", role: "support", importance: 0.3 },
      ],
    );
    for (const seed of [1, 2, 3, 4, 5]) {
      const res = solveLayout(its, {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(seed),
      });
      expect(res.placements).toHaveLength(2);
      const wa = its[0]!.imgW * res.placements.find((p) => p.itemId === "a")!.scale * K;
      const wb = its[1]!.imgW * res.placements.find((p) => p.itemId === "b")!.scale * K;
      expect(wa, `seed ${seed}`).toBeGreaterThanOrEqual(wb - 1e-9);
      // CHANGED (hero-montage policy): hero-aware checkLayout ctx — the focal
      // hint designates "a" as the hero, so the pair rides the 0.25 tuck cap.
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  });

  it("determinism: hinted solve is byte-identical for the same seed", () => {
    const its = items(6, (i) => 0.3 + 0.1 * i);
    const hints = hintsFor(
      [
        { ids: ["i0", "i1", "i2"], cx: card.w * 0.35, cy: card.h * 0.55, spread: 130 },
        { ids: ["i3", "i4", "i5"], cx: card.w * 0.65, cy: card.h * 0.6, spread: 130 },
      ],
      its.map((i, idx) => ({
        itemId: i.id,
        tiltToward: "group_center" as const,
        importance: 1 - idx * 0.1,
      })),
    );
    const run = () =>
      solveLayout(its, {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(777),
      });
    const a = run();
    const b = run();
    expect(JSON.stringify(a.placements)).toBe(JSON.stringify(b.placements));
    expect(a.score).toBe(b.score);
  });

  it("stress: 25 items with pair groups converge; same-group pairs cluster tighter than cross-group", () => {
    const its = items(25, (i) => ((i * 37) % 100) / 100);
    const groups: Array<{ ids: string[]; cx: number; cy: number; spread: number }> = [];
    for (let i = 0; i < its.length; i += 2) {
      const ids = its.slice(i, i + 2).map((it) => it.id);
      if (ids.length === 1 && groups.length > 0) groups[groups.length - 1]!.ids.push(ids[0]!);
      else groups.push({ ids, cx: card.w * (i % 4 === 0 ? 0.35 : 0.65), cy: card.h * 0.6, spread: 120 });
    }
    const hints = hintsFor(
      groups,
      its.map((i) => ({ itemId: i.id, tiltToward: "group_center" as const })),
    );
    const res = solveLayout(its, {
      cardDims: card,
      k: K,
      textZone: TEXT_ZONE,
      hints,
      rng: mulberry32(2024),
    });
    expect(res.placements).toHaveLength(25);
    expect(res.warnings.some((w) => w.includes("could not be placed"))).toBe(false);
    // CHANGED (hero-montage policy): hero-aware checkLayout ctx (tuck cap for
    // hero pairs, relaxedMinSize forwarded).
    expect(
      heroAwareCheck(res, its, hints, res.relaxedMinSize).ok,
    ).toBe(true);
    const byId = new Map(res.placements.map((p) => [p.itemId, p] as const));
    let intra = 0;
    let intraN = 0;
    let cross = 0;
    let crossN = 0;
    for (let i = 0; i < its.length; i++) {
      for (let j = i + 1; j < its.length; j++) {
        const d = dist(byId.get(its[i]!.id)!, byId.get(its[j]!.id)!);
        const sameGroup = groups.some((g) => g.ids.includes(its[i]!.id) && g.ids.includes(its[j]!.id));
        if (sameGroup) {
          intra += d;
          intraN++;
        } else {
          cross += d;
          crossN++;
        }
      }
    }
    expect(intra / intraN).toBeLessThan(cross / crossN);
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

describe("solveLayout — hero-montage policy (dominant hero + orbiting supports)", () => {
  /** Display width of a 256×256 square item as a fraction of the card width. */
  const sqW = (p: Placement): number => (256 * p.scale * K) / card.w;

  /** n equal 256×256 square items, same weight. */
  const sq = (n: number, weightFn?: (i: number) => number): LayoutItem[] =>
    Array.from({ length: n }, (_, i) =>
      mkItem(`i${i}`, { orderIndex: i, visualWeight: weightFn ? weightFn(i) : 0.5 }),
    );

  it("hero identification: highest visualWeight wins; a role:'focal' hint overrides", () => {
    // No hints: highest visualWeight, stable orderIndex tie-break.
    const weighted = sq(3, (i) => [0.3, 0.9, 0.5][i]!);
    expect(heroItemIdOf(weighted, null)).toBe("i1");
    expect(heroItemIdOf(sq(3), null)).toBe("i0");
    // Hint override: the layout AI's role:'focal' hint designates the hero
    // even against the default ranking (equal weights would pick i0 by
    // orderIndex).
    const its = sq(2);
    const hints = layoutCompositionSchema.parse({
      focalPoint: { x: card.w / 2, y: card.h * 0.6 },
      groups: [{ itemIds: ["i0", "i1"], cx: card.w / 2, cy: card.h * 0.6, spread: 140 }],
      hints: [{ itemId: "i1", role: "focal", importance: 1 }],
      textZone: TEXT_ZONE,
      suggestedGreetingStyle: { align: "center", y: 150 },
    });
    expect(heroItemIdOf(its, hints)).toBe("i1");
    // End to end: the designated hero solves DOMINANT (wider than every
    // support, at the 0.65 hero target) even though it would NOT have been
    // the default rank-0 item.
    const res = solveLayout(its, {
      cardDims: card,
      k: K,
      textZone: TEXT_ZONE,
      hints,
      rng: mulberry32(9),
    });
    expect(res.placements).toHaveLength(2);
    const wHero = sqW(res.placements.find((p) => p.itemId === "i1")!);
    const wSup = sqW(res.placements.find((p) => p.itemId === "i0")!);
    expect(wHero).toBeGreaterThanOrEqual(0.60);
    expect(wHero).toBeGreaterThan(wSup);
  });

  it("tuck-cap bounds: hero–support 0.20 passes / 0.30 fails; support–support 0.08 passes / 0.12 fails", () => {
    // Constructed pairs (unrotated equal squares, display width 200 =
    // 0.28×card.w): for two squares of width W stacked vertically with center
    // distance d, the true SAT ratio is exactly (W − d)/W — so d encodes the
    // ratio. The hero sits just below the text zone (TEXT_ZONE y ∈ [60, 220]);
    // the constructed ratios are asserted first, then the checkLayout verdicts.
    const W = 200;
    const scale = W / (256 * K);
    const hero = mkItem("h");
    const supA = mkItem("s1");
    const supB = mkItem("s2");
    const at = (id: string, y: number): Placement => ({
      itemId: id,
      x: card.w / 2,
      y,
      scale,
      rotation: 0,
      zIndex: 0,
    });
    const heroY = 330; // hero box y ∈ [230, 430] — clear of the text zone
    const dFor = (ratio: number) => W * (1 - ratio);
    const corners = (p: Placement, item: LayoutItem) => rotatedRectCorners(p, item, K);
    // Hero-aware ctx: pairs involving "h" measure against the 0.25 tuck cap.
    // Hero-aware ctx: pairs involving "h" measure against the 0.25 tuck cap.
    // textZone: null — this is a PURE pair-cap test; the constructed hero box
    // brushes the padded text zone, which is not what's under test.
    const heroCtx = {
      card,
      k: K,
      textZone: null,
      heroItemId: "h",
      heroOverlapCap: HERO_TUCK_CAP,
    };

    // Hero–support at 0.20 ≤ HERO_TUCK_CAP: PASSES.
    const tuck20 = [at("h", heroY), at("s1", heroY + dFor(0.20))];
    expect(
      overlapRatio(corners(tuck20[0]!, hero), corners(tuck20[1]!, supA)),
    ).toBeCloseTo(0.20, 9);
    expect(checkLayout(tuck20, [hero, supA], heroCtx).ok).toBe(true);
    // Same geometry WITHOUT the hero ctx: the plain 0.10 cap rejects it — the
    // tuck tolerance is exactly what admits the 20% tuck.
    expect(
      checkLayout(tuck20, [hero, supA], { card, k: K, textZone: TEXT_ZONE }).ok,
    ).toBe(false);
    // Hero–support at 0.30 > HERO_TUCK_CAP: FAILS with an overlap_cap violation.
    const tuck30 = [at("h", heroY), at("s1", heroY + dFor(0.30))];
    expect(
      overlapRatio(corners(tuck30[0]!, hero), corners(tuck30[1]!, supA)),
    ).toBeCloseTo(0.30, 9);
    const c30 = checkLayout(tuck30, [hero, supA], heroCtx);
    expect(c30.ok).toBe(false);
    expect(
      c30.violations.some(
        (v) => v.code === "overlap_cap" && v.itemId === "s1" && v.otherItemId === "h",
      ),
    ).toBe(true);

    // Support–support in the SAME hero-aware ctx (the hero is placed but does
    // not touch them): the plain 0.10 cap applies to non-hero pairs.
    const s1Y = 560; // s1 box y ∈ [460, 660] — no hero contact (hero ends 430)
    const ss08 = [at("h", heroY), at("s1", s1Y), at("s2", s1Y + dFor(0.08))];
    expect(
      overlapRatio(corners(ss08[1]!, supA), corners(ss08[2]!, supB)),
    ).toBeCloseTo(0.08, 9);
    expect(checkLayout(ss08, [hero, supA, supB], heroCtx).ok).toBe(true);
    const ss12 = [at("h", heroY), at("s1", s1Y), at("s2", s1Y + dFor(0.12))];
    expect(
      overlapRatio(corners(ss12[1]!, supA), corners(ss12[2]!, supB)),
    ).toBeCloseTo(0.12, 9);
    const c12 = checkLayout(ss12, [hero, supA, supB], heroCtx);
    expect(c12.ok).toBe(false);
    expect(
      c12.violations.some(
        (v) => v.code === "overlap_cap" && v.itemId === "s2" && v.otherItemId === "s1",
      ),
    ).toBe(true);
  });

  it("hero renders topmost: zIndex above every support", () => {
    // Hero-montage zIndex: the hero gets max(orderIndex) + 1; supports keep
    // their orderIndex. Measured (seeds 1..5, n ≤ 25): heroTop always true.
    for (const seed of [1, 2, 3]) {
      const its = sq(5);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(5);
      const heroId = heroItemIdOf(its, null)!;
      const zHero = res.placements.find((p) => p.itemId === heroId)!.zIndex;
      expect(zHero, `seed ${seed}`).toBe(5); // max orderIndex (4) + 1
      for (const p of res.placements) {
        if (p.itemId !== heroId) expect(p.zIndex, `seed ${seed} ${p.itemId}`).toBeLessThan(zHero);
      }
    }
  });

  it("2-step redesignation: B (focal hint) becomes the hero; the old hero A shrinks to a support", () => {
    // Step 1: A alone → solo hero (the 0.85 solo curve, unchanged). Step 2: B
    // arrives with a role:'focal' hint → B takes the hero size and A resizes
    // as a support (the solver re-ranks hero-first on EVERY solve).
    // Measured (seeds 1..5, equal 256×256 squares): B_after 0.650–0.679,
    // A_after 0.458–0.468, A_solo 0.850.
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = mkItem("a", { orderIndex: 0 });
      const r1 = solveLayout([a], {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        rng: mulberry32(seed),
      });
      expect(r1.placements).toHaveLength(1);
      expect(sqW(r1.placements[0]!), `seed ${seed} A solo`).toBeGreaterThanOrEqual(0.75);

      const b = mkItem("b", { orderIndex: 1 });
      const hints = layoutCompositionSchema.parse({
        focalPoint: { x: card.w / 2, y: card.h * 0.6 },
        groups: [{ itemIds: ["a", "b"], cx: card.w / 2, cy: card.h * 0.6, spread: 140 }],
        hints: [{ itemId: "b", role: "focal", importance: 1 }],
        textZone: TEXT_ZONE,
        suggestedGreetingStyle: { align: "center", y: 150 },
      });
      expect(heroItemIdOf([a, b], hints)).toBe("b");
      const r2 = solveLayout([a, b], {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        hints,
        rng: mulberry32(seed),
      });
      expect(r2.placements).toHaveLength(2);
      const wB = sqW(r2.placements.find((p) => p.itemId === "b")!);
      const wA2 = sqW(r2.placements.find((p) => p.itemId === "a")!);
      // B lands on the hero curve (measured 0.650–0.679 ≥ 0.60).
      expect(wB, `seed ${seed} B hero`).toBeGreaterThanOrEqual(0.60);
      // A shrinks onto the support curve (measured 0.458–0.468; asserted at
      // the brief's 0.55 + 0.05 tolerance).
      expect(wA2, `seed ${seed} A shrunk`).toBeLessThanOrEqual(0.55 + 0.05);
      expect(wB).toBeGreaterThan(wA2);
      // B renders topmost.
      expect(r2.placements.find((p) => p.itemId === "b")!.zIndex, `seed ${seed}`).toBe(2);
      expect(r2.placements.find((p) => p.itemId === "a")!.zIndex, `seed ${seed}`).toBeLessThan(2);
    }
  });

  it("support floor (0.5×hero): hard where feasible, soft-resolves below when geometrically infeasible", () => {
    // n=5 equal squares, seeds 1..5. SUPPORT_HERO_FLOOR = 0.5× the hero width
    // is a hard clamp in the candidate generator, BUT when no cell can fit
    // the floored scale within the hard bounds/overlap/minSize constraints,
    // the per-cell fallback ladder resolves BELOW the floor (hard constraints
    // always win over the floor — documented resolution). Measured min
    // support/hero ratios: 0.522 / 0.500 / 0.395 / 0.511 / 0.337 — the floor
    // holds in 3/5 seeds, soft-resolves in 2/5, and never drops below 0.30×
    // the hero. Every layout still satisfies the hero-aware hard constraints.
    const minRatios: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const its = sq(5);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(5);
      const heroId = heroItemIdOf(its, null)!;
      const wHero = sqW(res.placements.find((p) => p.itemId === heroId)!);
      const supWs = res.placements.filter((p) => p.itemId !== heroId).map(sqW);
      const minRatio = Math.min(...supWs) / wHero;
      minRatios.push(minRatio);
      expect(minRatio, `seed ${seed} support/hero floor`).toBeGreaterThanOrEqual(0.30);
      expect(heroAwareCheck(res, its).ok, `seed ${seed}`).toBe(true);
    }
    // The floor is NOT absolute: at n=5 at least one seed soft-resolves below
    // it (measured 0.337) instead of failing to place the support.
    expect(Math.min(...minRatios)).toBeLessThan(0.5);
  });

  it("large n: hero follows the legacy curve (n=8 ≈0.33, n=10 ≈0.28); hero-pair SAT ≤ 0.25, others ≤ 0.10", () => {
    // Measured (equal squares, seeds 1..3): n=8 hero 0.328–0.335, n=10 hero
    // 0.279–0.281, n=25 hero 0.168–0.178 — at large counts the per-item share
    // curve (legacy TOTAL_COVERAGE_TARGET/n split) shrinks the hero like
    // everyone else (the 0.5× support floor is maintained by the same
    // desired-scale floor; with near-equal shares it rarely binds). SAT:
    // hero-pairs ≤ 0.243 and support–support ≤ 0.099 measured — inside the
    // hero-aware caps.
    for (const [n, heroMin, heroMax] of [
      [8, 0.28, 0.36],
      [10, 0.26, 0.30],
      [25, 0.15, 0.20],
    ] as const) {
      for (const seed of [1, 2, 3]) {
        const its = sq(n);
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        const heroId = heroItemIdOf(its, null)!;
        const wHero = sqW(res.placements.find((p) => p.itemId === heroId)!);
        expect(wHero, `n=${n} seed ${seed} hero`).toBeGreaterThanOrEqual(heroMin);
        expect(wHero, `n=${n} seed ${seed} hero`).toBeLessThanOrEqual(heroMax);
        const sat = maxSatByPairKind(res, its);
        expect(sat.heroPairs, `n=${n} seed ${seed} hero–support SAT`).toBeLessThanOrEqual(
          0.25 + 1e-6,
        );
        expect(sat.otherPairs, `n=${n} seed ${seed} support–support SAT`).toBeLessThanOrEqual(
          0.10 + 1e-6,
        );
      }
    }
  });
});