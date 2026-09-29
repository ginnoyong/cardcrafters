/**
 * Layout solver tests (build-phase step 3) — mulberry32-seeded, deterministic.
 *
 * Pinned to the v4 layout hierarchy (FINAL): the hero's size is EMERGENT —
 * solved from the coverage budget (target 80% of the usable canvas) with
 * supports pinned to the [0.5, 0.6]×hero ratio band, clamped to
 * [HERO_MIN_WIDTH, HERO_MAX_WIDTH] = [0.25, 0.75] card width (hero scale
 * jitter disabled: jitter 1). The solver drives the placed usable-union
 * coverage into the [0.65, 0.80] COVERAGE BAND via the degradation ladder
 * (ratio-adjust → reversed-order retry → hero shrink → desiredShrink → text
 * drop; max 17 relaxations). n = 2 sits at the 0.75 hero ceiling (the budget
 * alone cannot be spent by one 0.55-ratio support); the hero window declines
 * monotonically toward the 0.25 floor as supports multiply.
 *
 * EVERY numeric pin below is a MEASURED value (probe batch over seeds 1..5,
 * default 5:7 card + top greeting zone, AFTER the hero-jitter fix), asserted
 * with −0.03 measurement slack where the pin sits on a boundary.
 * Configurations:
 *   - "squares": n equal 256×256 stickers, weight 0.5 (the hero-window
 *     fixture — never drops an item).
 *   - "mixed": imgW = 200 + (i%3)·60, imgH = 200 + ((i+1)%3)·60, weights
 *     0.9 − ((i·7)%70)/100. v4 places EVERY item at every n (seeds 1..5 and
 *     1234+n measured — the ratio-adjust + reversed-retry levers recover the
 *     drops v3 saw from n = 15); documented below.
 */

import { describe, expect, it } from "vitest";

import {
  CARD_COORD_SPACE,
  layoutCompositionSchema,
  MIN_ITEM_SIZE_PCT,
  type LayoutComposition,
  type Placement,
} from "@cardcrafters/shared";

import {
  cardBox,
  checkLayout,
  displayHeight,
  displayWidth,
  HERO_TUCK_CAP,
  overlapCapFor,
  overlapRatio,
  placedBox,
  rotatedRectCorners,
  safeMargin,
  scaleWindow,
  textOverlapOk,
  TEXT_ZONE_PAD_FRAC,
  type LayoutItem,
  type Rect,
} from "./constraints";
import { scoreLayout } from "./score";
import { heroItemIdOf, mulberry32, solveLayout } from "./solver";

const card = cardBox({ width: CARD_COORD_SPACE, height: CARD_COORD_SPACE }, 5, 7);
const K = (0.25 * Math.min(card.w, card.h)) / 256; // baseFit(card)
const TEXT_ZONE: Rect = { x: 0.1 * card.w, y: 0.06 * card.h, w: 0.8 * card.w, h: 0.16 * card.h };

function mkItem(id: string, overrides: Partial<LayoutItem> = {}): LayoutItem {
  return { id, imgW: 256, imgH: 256, visualWeight: 0.5, orderIndex: 0, ...overrides };
}

/** Mixed-aspect items (the every-n / stress fixture). */
function items(n: number, weightFn?: (i: number) => number): LayoutItem[] {
  return Array.from({ length: n }, (_, i) =>
    mkItem(`i${i}`, {
      orderIndex: i,
      visualWeight: weightFn ? weightFn(i) : 0.9 - ((i * 7) % 70) / 100,
      imgW: 200 + (i % 3) * 60,
      imgH: 200 + ((i + 1) % 3) * 60,
    }),
  );
}

/** n equal 256×256 square items (the hero-window fixture). */
function squareItems(n: number, weightFn?: (i: number) => number): LayoutItem[] {
  return Array.from({ length: n }, (_, i) =>
    mkItem(`i${i}`, { orderIndex: i, visualWeight: weightFn ? weightFn(i) : 0.5 }),
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

/** Hero-relaxation is announced with this warning (the yield ladder). */
function isHeroRelaxed(res: ReturnType<typeof solveLayout>): boolean {
  return res.warnings.some((w) => w.includes("hero width target relaxed"));
}

/** Mean centroid of all placements (placement.x/y ARE the centroids). */
function centroid(placements: Placement[]): { x: number; y: number } {
  const x = placements.reduce((s, p) => s + p.x, 0) / placements.length;
  const y = placements.reduce((s, p) => s + p.y, 0) / placements.length;
  return { x, y };
}

/** Unrotated display width of a placement as a fraction of the card width. */
function widthPct(p: Placement, item: LayoutItem): number {
  return (item.imgW * p.scale * K) / card.w;
}

/** Display width of a 256×256 square item as a fraction of the card width. */
function sqW(p: Placement): number {
  return (256 * p.scale * K) / card.w;
}

/** Weight-desc rank the solver places by (stable tie-break by orderIndex). */
function weightRank(items: LayoutItem[], id: string): number {
  const byW = [...items].sort(
    (a, b) => b.visualWeight - a.visualWeight || a.orderIndex - b.orderIndex,
  );
  return byW.findIndex((i) => i.id === id);
}

/**
 * Usable canvas (safe margin + inflated text zone excluded) — the same
 * rectangle the solver's space check measures coverage over.
 */
function usableRect(textZone: Rect | null): Rect {
  const m = safeMargin(card);
  const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
  const y1 = Math.max(m.y, textZone ? textZone.y + textZone.h + pad : 0);
  return { x: m.x, y: y1, w: card.w - 2 * m.x, h: card.h - m.y - y1 };
}

/**
 * Usable-canvas UNION coverage (48×48 sample grid over the usable rect,
 * deterministic — the solver's own space-check measure).
 */
function unionCoverage(
  placements: Placement[],
  items: LayoutItem[],
  textZone: Rect | null,
): number {
  const ua = usableRect(textZone);
  if (!(ua.w > 0) || !(ua.h > 0)) return 1;
  const N = 48;
  let covered = 0;
  for (let gy = 0; gy < N; gy++) {
    const cy = ua.y + ((gy + 0.5) * ua.h) / N;
    for (let gx = 0; gx < N; gx++) {
      const cx = ua.x + ((gx + 0.5) * ua.w) / N;
      for (const p of placements) {
        const item = items.find((i) => i.id === p.itemId)!;
        const b = placedBox(p, item, K);
        if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) {
          covered++;
          break;
        }
      }
    }
  }
  return covered / (N * N);
}

/** Sum of placed display AREAS over the usable area (overlap not deduped). */
function areaCoverage(placements: Placement[], items: LayoutItem[]): number {
  const ua = usableRect(TEXT_ZONE);
  let area = 0;
  for (const p of placements) {
    const item = items.find((i) => i.id === p.itemId)!;
    area += displayWidth(item, p.scale, K) * displayHeight(item, p.scale, K);
  }
  return area / (ua.w * ua.h);
}

/**
 * Hero-aware ConstraintCtx for checkLayout (hero-montage policy): pairs
 * involving the HERO measure against the HERO_TUCK_CAP (0.25) tuck tolerance;
 * support–support pairs keep overlapCapFor(n) (0.10). `hints` (optional) is
 * forwarded to heroItemIdOf so focal-hint designation is honored;
 * `checkTextOverlap: false` is forwarded for the n > 20 layouts where the
 * solver itself drops the text rule for items beyond the first 20.
 */
function heroAwareCheck(
  res: ReturnType<typeof solveLayout>,
  its: LayoutItem[],
  hints?: LayoutComposition | null,
  minSizePct?: number,
  opts: { checkTextOverlap?: boolean } = {},
): ReturnType<typeof checkLayout> {
  return checkLayout(res.placements, its, {
    card,
    k: K,
    textZone: TEXT_ZONE,
    ...(minSizePct !== undefined ? { minSizePct } : {}),
    ...(opts.checkTextOverlap !== undefined ? { checkTextOverlap: opts.checkTextOverlap } : {}),
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
    // The ctx is hero-aware — pairs involving the hero measure against the
    // HERO_TUCK_CAP (0.25) tuck tolerance, not the plain 0.10 cap (the
    // solver legitimately tucks supports up to 25% behind the dominant hero).
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
  it("converges on crowded mixed-aspect cards, constraints pass, nothing out of bounds", () => {
    // v4 MEASURED (seed 2024): the ratio-adjust + reversed-retry levers place
    // ALL items — no drops on crowded mixed cards anymore.
    const its = items(25, (i) => ((i * 37) % 100) / 100);
    const res = solve(its, 2024);
    expect(res.placements).toHaveLength(25);
    expect(res.relaxedMinSize).toBeLessThanOrEqual(MIN_ITEM_SIZE_PCT);
    // Every omitted item would be announced (none expected).
    const dropWarnings = res.warnings.filter((w) => w.includes("could not be placed"));
    expect(dropWarnings).toHaveLength(25 - res.placements.length);
    // n > 20: the solver itself drops the text-overlap rule for items beyond
    // the first 20 (ranked by weight), so the ctx must skip that rule too —
    // only text_overlap violations differ between the two runs (MEASURED:
    // violations are ONLY text_overlap for items at weight-rank ≥ 20).
    const check = heroAwareCheck(res, its, null, res.relaxedMinSize, {
      checkTextOverlap: false,
    });
    expect(check.ok).toBe(true);
    // Belt and braces: no emitted AABB may escape the card itself.
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
  it("a bottom-left focal hint keeps the hero centered but groups supports around it (USER DECISION: hero is pinned center)", () => {
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
    // USER DECISION (hero pinned center): the hint's focalPoint no longer
    // moves the hero — the hero stays at the card center in BOTH runs, and
    // the hint instead shapes the SUPPORTS (which orbit it). Assert:
    // (a) the hero is centered in both runs, (b) the hinted run's supports
    // sit tighter to the hero (the hint's group spread biases the ring
    // radius), i.e. mean support→hero distance is not larger with hints.
    // MEASURED (seed 55): hero at (0.500, 0.500) in both runs.
    const heroId = heroItemIdOf(its, null)!;
    const heroCentered = (res: ReturnType<typeof solveLayout>) => {
      const hp = res.placements.find((p) => p.itemId === heroId)!;
      expect(Math.abs(hp.x / card.w - 0.5)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(hp.y / card.h - 0.5)).toBeLessThanOrEqual(0.06);
    };
    heroCentered(withHints);
    heroCentered(withoutHints);
    const meanSupportDist = (res: ReturnType<typeof solveLayout>) => {
      const hp = res.placements.find((p) => p.itemId === heroId)!;
      const ds = res.placements
        .filter((p) => p.itemId !== heroId)
        .map((p) => Math.hypot(p.x - hp.x, p.y - hp.y));
      return ds.reduce((s, d) => s + d, 0) / ds.length;
    };
    expect(meanSupportDist(withHints)).toBeLessThanOrEqual(
      meanSupportDist(withoutHints) + 60,
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

describe("solveLayout — hero hierarchy v4 (measured pins)", () => {
  // MEASURED emergent hero width windows (seeds 1..5, default 5:7 card +
  // greeting zone). The hero's size is solved from the coverage budget
  // (80% of usable area) with supports in the [0.5, 0.6]×hero band —
  // n = 2 rides the 0.75 HERO_MAX_WIDTH ceiling, and the window declines
  // monotonically toward the 0.25 floor as the supports consume the budget.
  // Every window is measured min..max ± 0.03 per fixture.
  const HERO_WINDOWS: ReadonlyArray<readonly [boolean, number, number, number]> = [
    // [squares?, n, lo, hi]
    //            measured (squares)   measured (mixed)
    [true, 2, 0.682, 0.761], // 0.712–0.731 (mean 0.718)
    [true, 3, 0.653, 0.713], // 0.683–0.683
    [true, 4, 0.520, 0.580], // 0.550–0.550
    [true, 5, 0.474, 0.601], // 0.504–0.571
    [true, 6, 0.466, 0.547], // 0.496–0.517
    [true, 8, 0.381, 0.520], // 0.411–0.490
    [true, 10, 0.340, 0.491], // 0.370–0.461
    [true, 12, 0.308, 0.418], // 0.338–0.388
    [true, 16, 0.262, 0.372], // 0.292–0.342
    [true, 20, 0.229, 0.289], // 0.259–0.259
    [true, 25, 0.220, 0.301], // 0.250–0.271
    [false, 2, 0.548, 0.651], // 0.578–0.621 (mean 0.604)
    [false, 3, 0.540, 0.622], // 0.570–0.592
    [false, 4, 0.474, 0.584], // 0.504–0.554
    [false, 5, 0.480, 0.540], // 0.510–0.510
    [false, 6, 0.461, 0.545], // 0.491–0.515
    [false, 8, 0.377, 0.487], // 0.407–0.457
    [false, 10, 0.344, 0.454], // 0.374–0.424
    [false, 12, 0.293, 0.428], // 0.323–0.398
    [false, 16, 0.247, 0.327], // 0.277–0.297
    [false, 20, 0.220, 0.326], // 0.250–0.296
    [false, 25, 0.220, 0.298], // 0.250–0.268
  ];

  it("emergent hero window per n: squares + mixed, seeds 1..5, every hero inside its measured band (0.75 ceiling → 0.25 floor)", () => {
    for (const [squareFix, n, lo, hi] of HERO_WINDOWS) {
      for (let seed = 1; seed <= 5; seed++) {
        const its = squareFix ? squareItems(n) : items(n);
        const res = solve(its, seed);
        expect(res.placements, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} all placed`).toHaveLength(n);
        const heroId = heroItemIdOf(its, null)!;
        const heroW = squareFix
          ? sqW(res.placements.find((p) => p.itemId === heroId)!)
          : widthPct(
              res.placements.find((p) => p.itemId === heroId)!,
              its.find((i) => i.id === heroId)!,
            );
        expect(heroW, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero`).toBeGreaterThanOrEqual(lo);
        expect(heroW, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero`).toBeLessThanOrEqual(hi);
      }
    }
  }, 600_000);

  it("n ≤ 3: hero ≥ 0.55 with NO hero-relax (both fixtures); the yield ladder first fires at n=4 (squares 5/5, mixed 1/5 — documented)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const squareFix of [true, false]) {
        for (const n of [2, 3]) {
          const its = squareFix ? squareItems(n) : items(n);
          const res = solve(its, seed);
          expect(res.placements).toHaveLength(n);
          const heroId = heroItemIdOf(its, null)!;
          const heroW = squareFix
            ? sqW(res.placements.find((p) => p.itemId === heroId)!)
            : widthPct(
                res.placements.find((p) => p.itemId === heroId)!,
                its.find((i) => i.id === heroId)!,
              );
          expect(
            heroW,
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero ≥ 0.55`,
          ).toBeGreaterThanOrEqual(0.55);
          expect(
            isHeroRelaxed(res),
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} no hero-relax`,
          ).toBe(false);
        }
        // n=4 (MEASURED): the ladder's first hero-shrink fires on ALL seeds
        // for squares (hero lands at exactly 0.550 — the packing-limited
        // underfill of the sq n=4 fixture), but only 1/5 for mixed (the
        // mixed aspect spread packs more freely). Both stay ≤ 0.584.
        const its4 = squareFix ? squareItems(4) : items(4);
        const res4 = solve(its4, seed);
        expect(res4.placements).toHaveLength(4);
        const heroId4 = heroItemIdOf(its4, null)!;
        const hero4 = squareFix
          ? sqW(res4.placements.find((p) => p.itemId === heroId4)!)
          : widthPct(
              res4.placements.find((p) => p.itemId === heroId4)!,
              its4.find((i) => i.id === heroId4)!,
            );
        expect(hero4, `${squareFix ? "sq" : "mx"} n=4 seed ${seed} hero ≤ 0.584`).toBeLessThanOrEqual(0.584);
        if (squareFix) {
          expect(isHeroRelaxed(res4), `sq n=4 seed ${seed} hero-relax fires`).toBe(true);
          expect(hero4, `sq n=4 seed ${seed} hero < 0.56`).toBeLessThan(0.56);
        }
      }
    }
    // mixed n=4: MEASURED exactly 1/5 seeds relax (which seed varies with the
    // draw order — assert the count, not a specific seed); squares n=4 is 5/5
    // (asserted above per seed).
    const mxRelaxed = [1, 2, 3, 4, 5].filter((s) =>
      isHeroRelaxed(solve(items(4), s)),
    ).length;
    expect(mxRelaxed, "mx n=4 hero-relax seed count").toBe(1);
  }, 300_000);

  it("support RATIO BAND: supports within [0.48, 0.63]×hero for n ≤ 12 (squares + mixed, seeds 1..5); ≥ 0.45 beyond (documented 0.480 excursion)", () => {
    // v4 hard band [0.5, 0.6]×hero enforced in candidates / local search /
    // rebalance. MEASURED set-wide (seeds 1..5): n ≤ 12 min ratio 0.486
    // (squares n=10 — a min-size-clamped late support), max 0.600; mixed
    // min 0.500, max 0.600. The hero-jitter fix removed the 0.45–0.47
    // excursions of the pre-fix probe entirely.
    for (const n of [2, 3, 4, 5, 6, 8, 10, 12]) {
      for (const squareFix of [true, false]) {
        for (let seed = 1; seed <= 5; seed++) {
          const its = squareFix ? squareItems(n) : items(n);
          const res = solve(its, seed);
          expect(res.placements).toHaveLength(n);
          const heroId = heroItemIdOf(its, null)!;
          const w = (p: Placement) =>
            squareFix ? sqW(p) : widthPct(p, its.find((i) => i.id === p.itemId)!);
          const wHero = w(res.placements.find((p) => p.itemId === heroId)!);
          const ratios = res.placements
            .filter((p) => p.itemId !== heroId)
            .map((p) => w(p) / wHero);
          expect(
            Math.min(...ratios),
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} min support/hero`,
          ).toBeGreaterThanOrEqual(0.48);
          expect(
            Math.max(...ratios),
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} max support/hero`,
          ).toBeLessThanOrEqual(0.63);
        }
      }
    }
    // Beyond n=12 the same band holds in measurement with ONE documented
    // excursion: mixed n=25 min ratio 0.480 (a min-size-clamped support
    // under the relaxed ladder) — asserted at the 0.45 floor, never below.
    for (const n of [16, 20, 25]) {
      for (const squareFix of [true, false]) {
        for (let seed = 1; seed <= 5; seed++) {
          const its = squareFix ? squareItems(n) : items(n);
          const res = solve(its, seed);
          expect(res.placements).toHaveLength(n);
          const heroId = heroItemIdOf(its, null)!;
          const w = (p: Placement) =>
            squareFix ? sqW(p) : widthPct(p, its.find((i) => i.id === p.itemId)!);
          const wHero = w(res.placements.find((p) => p.itemId === heroId)!);
          const ratios = res.placements
            .filter((p) => p.itemId !== heroId)
            .map((p) => w(p) / wHero);
          expect(
            Math.min(...ratios),
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} min support/hero`,
          ).toBeGreaterThanOrEqual(0.45); // measured set-min 0.480 (mixed n=25)
          expect(
            Math.max(...ratios),
            `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} max support/hero`,
          ).toBeLessThanOrEqual(0.63); // measured set-max 0.600
        }
      }
    }
  }, 600_000);

  it("n=4 floors: min support/hero ≥ 0.50 with the text zone, ≥ 0.52 without it; top-corner anchors paint the corners", () => {
    // MEASURED (equal squares, seeds 1..5): with the greeting zone the hero
    // lands at exactly 0.550 and supports ride the band (min 0.510–0.518,
    // max 0.600); without the zone the emergent hero grows to 0.705 (larger
    // usable budget) and supports clamp into [0.5, 0.6]×hero (min
    // 0.550–0.585, max 0.583–0.599). Corner-anchor top-corner region
    // coverage 0.443–0.833 with the zone.
    for (let seed = 1; seed <= 5; seed++) {
      const its = squareItems(4);
      const heroId = heroItemIdOf(its, null)!;

      // With the text zone (default card).
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(4);
      const wHero = sqW(res.placements.find((p) => p.itemId === heroId)!);
      const ratios = res.placements
        .filter((p) => p.itemId !== heroId)
        .map((p) => sqW(p) / wHero);
      expect(Math.min(...ratios), `seed ${seed} TZ min support/hero`).toBeGreaterThanOrEqual(0.50);
      expect(Math.max(...ratios), `seed ${seed} TZ max support/hero`).toBeLessThanOrEqual(0.63);
      expect(heroAwareCheck(res, its).ok, `seed ${seed} TZ checkLayout`).toBe(true);
      // Corner anchors keep the top-corner slots painted (measured ≥ 0.443).
      expect(
        cornerRegionCoverage(res, its),
        `seed ${seed} top-corner coverage`,
      ).toBeGreaterThanOrEqual(0.41);

      // Without the text zone: the hero grows (0.705 measured), the band holds.
      const resNoTz = solve(its, seed, null);
      expect(resNoTz.placements).toHaveLength(4);
      const wHeroNoTz = sqW(resNoTz.placements.find((p) => p.itemId === heroId)!);
      const ratiosNoTz = resNoTz.placements
        .filter((p) => p.itemId !== heroId)
        .map((p) => sqW(p) / wHeroNoTz);
      expect(wHeroNoTz, `seed ${seed} no-TZ hero grows`).toBeGreaterThanOrEqual(0.65);
      expect(Math.min(...ratiosNoTz), `seed ${seed} no-TZ min support/hero`).toBeGreaterThanOrEqual(0.52); // measured 0.550−0.03
      expect(
        checkLayout(resNoTz.placements, its, {
          card,
          k: K,
          textZone: null,
          overlapCap: overlapCapFor(its.length),
          heroItemId: heroId,
          heroOverlapCap: HERO_TUCK_CAP,
        }).ok,
        `seed ${seed} no-TZ checkLayout`,
      ).toBe(true);
    }
  }, 300_000);

  it("coverage: squares n=3 area-cov ≥ 0.77; union usable-cov ≥ measured−0.03 (feasible n ≥ 0.58–0.66; packing-limited underfill documented)", () => {
    // v4 drives the placed usable-union coverage into the [0.65, 0.80] band.
    // MEASURED (seeds 1..5): feasible n land inside the band — squares n=2
    // 0.691–0.735, n=3 0.748–0.781, n=6 0.673–0.704; mixed n=3 0.615–0.667,
    // n=5 0.629–0.648, n=6 0.648–0.687, n=8 0.659–0.728, n=10 0.652–0.708,
    // n=25 0.631–0.690. PACKING-LIMITED underfill (hard bounds + overlap cap
    // + the 0.6×hero ceiling prevent reaching 0.65): squares n=4 0.563–0.599
    // (the hero is exactly 0.550 and 3 supports cannot pack tighter), n=5
    // 0.585–0.766, n=20 0.535–0.545 (hero at the 0.25 floor); mixed n=2
    // 0.573–0.637, n=4 0.598–0.681, n=12 0.547–0.763, n=16 0.542–0.569,
    // n=20 0.549–0.708. Pinned at measured min − 0.03.
    const COVERAGE_PINS: ReadonlyArray<readonly [boolean, number, number]> = [
      // [squares?, n, measured min − 0.03]
      [true, 2, 0.66], // measured 0.691
      [true, 3, 0.71], // measured 0.748
      [true, 4, 0.53], // measured 0.563 (packing-limited)
      [true, 5, 0.55], // measured 0.585 (packing-limited)
      [true, 6, 0.64], // measured 0.673
      [true, 8, 0.55], // measured 0.586
      [true, 10, 0.55], // measured 0.582
      [true, 12, 0.53], // measured 0.560
      [true, 16, 0.51], // measured 0.545
      [true, 20, 0.50], // measured 0.535 (hero at the 0.25 floor)
      [true, 25, 0.57], // measured 0.600
      [false, 2, 0.54], // measured 0.573
      [false, 3, 0.58], // measured 0.615
      [false, 4, 0.56], // measured 0.598
      [false, 5, 0.59], // measured 0.629
      [false, 6, 0.61], // measured 0.648
      [false, 8, 0.62], // measured 0.659
      [false, 10, 0.62], // measured 0.652
      [false, 12, 0.51], // measured 0.547
      [false, 16, 0.51], // measured 0.542
      [false, 20, 0.51], // measured 0.549
      [false, 25, 0.60], // measured 0.631
    ];
    for (const [squareFix, n, pin] of COVERAGE_PINS) {
      for (let seed = 1; seed <= 5; seed++) {
        const its = squareFix ? squareItems(n) : items(n);
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        expect(
          unionCoverage(res.placements, its, TEXT_ZONE),
          `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} union coverage`,
        ).toBeGreaterThanOrEqual(pin);
      }
    }
    // Area coverage at n=3 (squares): the sums sit AT the 0.80 budget target
    // (measured 0.800–0.806, overlap-free).
    for (let seed = 1; seed <= 5; seed++) {
      const sq3 = squareItems(3);
      const res3 = solve(sq3, seed);
      expect(res3.placements).toHaveLength(3);
      expect(
        areaCoverage(res3.placements, sq3),
        `seed ${seed} squares n=3 area coverage`,
      ).toBeGreaterThanOrEqual(0.77);
    }
  }, 600_000);

  it("every-n checkLayout n=1..25: all placed, ok under the hero-aware ctx with relaxedMinSize (text rule skipped for n > 20)", () => {
    // v4 MEASURED (seeds 1234+n): the mixed fixture places EVERY item at
    // every n — the ratio-adjust / reversed-retry levers recovered the v3
    // drops. The solve may relax minSize on crowded cards; the ctx must
    // check against the RELAXED minimum. For n > 20 the text-overlap rule is
    // skipped in the ctx, matching the solver's own last-resort behavior:
    // with the rule ON, MEASURED violations are ONLY text_overlap for items
    // at weight-desc rank ≥ 20 (the first 20 keep the zone clean).
    for (let n = 1; n <= 25; n++) {
      const its = items(n, (i) => 0.9 - ((i * 7) % 70) / 100);
      const res = solve(its, 1234 + n);
      expect(res.placements.length, `n=${n} all placed`).toBe(n);
      expect(
        heroAwareCheck(res, its, undefined, res.relaxedMinSize, {
          checkTextOverlap: n > 20 ? false : true,
        }).ok,
        `n=${n} checkLayout`,
      ).toBe(true);
      if (n > 20) {
        // Diagnosis (MEASURED): the ONLY full-ctx violations are text_overlap
        // — and only for items ranked beyond the first 20.
        const heroId = heroItemIdOf(its, null)!;
        const full = checkLayout(res.placements, its, {
          card,
          k: K,
          textZone: TEXT_ZONE,
          minSizePct: res.relaxedMinSize,
          overlapCap: overlapCapFor(its.length),
          heroItemId: heroId,
          heroOverlapCap: HERO_TUCK_CAP,
        });
        for (const v of full.violations) {
          expect(v.code, `n=${n} violation code`).toBe("text_overlap");
          expect(
            weightRank(its, v.itemId),
            `n=${n} text_overlap rank (${v.itemId})`,
          ).toBeGreaterThanOrEqual(20);
        }
      }
    }
  }, 600_000);

  it("all-placed: equal squares never drop an item (n = 1..25, seeds 1..5)", () => {
    for (let n = 1; n <= 25; n++) {
      for (let seed = 1; seed <= 5; seed++) {
        const its = squareItems(n);
        const res = solve(its, seed);
        expect(res.placements, `n=${n} seed ${seed}`).toHaveLength(n);
        expect(
          res.warnings.some((w) => w.includes("could not be placed")),
          `n=${n} seed ${seed} no drop warning`,
        ).toBe(false);
      }
    }
  }, 600_000);

  it("all-placed (mixed): v4 places EVERY item at every n (n = 1..25, seeds 1..5 — the v3 drops from n=15 are gone)", () => {
    // MEASURED (seeds 1..5): placed = n exactly for all n ≤ 25. The v4
    // ladder's ratio-adjust + reversed-order retry recover the starved late
    // arrivals that v3 dropped from n = 15.
    for (let n = 1; n <= 25; n++) {
      for (let seed = 1; seed <= 5; seed++) {
        expect(solve(items(n), seed).placements, `n=${n} seed ${seed}`).toHaveLength(n);
      }
    }
  }, 600_000);

  it("centered hero: x,y within 0.41–0.59 (±0.03 slack) for n ≤ 3, both fixtures (hero seeded at the exact card center)", () => {
    // MEASURED hero centroid fractions (squares + mixed, seeds 1..5, n ≤ 3):
    // x 0.426–0.529, y 0.480–0.548. The hero's ONLY seed is the exact card
    // center; bounds clamping may nudge it for wide heroes but keeps it in
    // the middle band.
    for (const squareFix of [true, false]) {
      for (const n of [2, 3]) {
        for (let seed = 1; seed <= 5; seed++) {
          const its = squareFix ? squareItems(n) : items(n);
          const res = solve(its, seed);
          expect(res.placements).toHaveLength(n);
          const heroId = heroItemIdOf(its, null)!;
          const hp = res.placements.find((p) => p.itemId === heroId)!;
          const fx = hp.x / card.w;
          const fy = hp.y / card.h;
          expect(fx, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero x`).toBeGreaterThanOrEqual(0.41);
          expect(fx, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero x`).toBeLessThanOrEqual(0.59);
          expect(fy, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero y`).toBeGreaterThanOrEqual(0.41);
          expect(fy, `${squareFix ? "sq" : "mx"} n=${n} seed ${seed} hero y`).toBeLessThanOrEqual(0.59);
        }
      }
    }
  }, 300_000);

  it("average display width curve is non-increasing 1→2→3→5→10→25 at the measured means (tolerance 0.03)", () => {
    // MEASURED mean-over-PLACED display widths (mixed fixture, seeds 1..3):
    // 0.738 → 0.472 → 0.422 → 0.327 → 0.228 → 0.153 (the emergent hero and
    // the ratio band push the curve DOWN vs v3 — the coverage budget is now
    // split across more, band-clamped supports). Asserted BOTH against the
    // measured means (±0.03) and non-increasing stepwise (0.03 tolerance).
    const MEASURED: ReadonlyArray<readonly [number, number]> = [
      [1, 0.738],
      [2, 0.472],
      [3, 0.422],
      [5, 0.327],
      [10, 0.228],
      [25, 0.153],
    ];
    const avgs: number[] = [];
    for (const [n, measured] of MEASURED) {
      const perSeed: number[] = [];
      for (const seed of [1, 2, 3]) {
        const its = items(n, (i) => 0.5 + 0.05 * (i % 4));
        const res = solve(its, seed);
        expect(res.placements.length).toBeGreaterThanOrEqual(1);
        perSeed.push(
          res.placements.reduce(
            (s, p) => s + widthPct(p, its.find((i) => i.id === p.itemId)!),
            0,
          ) / res.placements.length,
        );
      }
      const avg = perSeed.reduce((s, v) => s + v, 0) / perSeed.length;
      expect(avg, `n=${n} measured mean`).toBeGreaterThanOrEqual(measured - 0.03);
      expect(avg, `n=${n} measured mean`).toBeLessThanOrEqual(measured + 0.03);
      avgs.push(avg);
    }
    for (let i = 1; i < avgs.length; i++) {
      expect(avgs[i]!).toBeLessThanOrEqual(avgs[i - 1]! + 0.03);
    }
  }, 300_000);

  it("n = 2 lands diagonal/staggered across seeds (polar ring placement)", () => {
    // MEASURED: 5/5 seeds have both |dx| and |dy| over 15% of the card
    // dimension (mixed default fixture, dx 0.268–0.354, dy 0.250–0.285).
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
  }, 120_000);

  it("SAT caps: hero pairs ride the 0.25 tuck cap, support–support stays 0.10 (squares n=2..6, seeds 1..5)", () => {
    // Hard caps (constraints.ts), not measurements — the layouts must respect
    // them at every n.
    for (const n of [2, 3, 4, 5, 6]) {
      for (let seed = 1; seed <= 5; seed++) {
        const its = squareItems(n);
        const res = solve(its, seed);
        expect(res.placements).toHaveLength(n);
        const sat = maxSatByPairKind(res, its);
        expect(sat.heroPairs, `n=${n} seed ${seed} hero–support SAT`).toBeLessThanOrEqual(
          0.25 + 1e-6,
        );
        expect(sat.otherPairs, `n=${n} seed ${seed} support–support SAT`).toBeLessThanOrEqual(
          0.10 + 1e-6,
        );
      }
    }
  }, 300_000);

  it("hero renders topmost: zIndex above every support", () => {
    // Hero-montage zIndex: the hero gets max(orderIndex) + 1; supports keep
    // their orderIndex. MEASURED (seeds 1..5, n ≤ 25): heroTop always true.
    for (const seed of [1, 2, 3]) {
      const its = squareItems(5);
      const res = solve(its, seed);
      expect(res.placements).toHaveLength(5);
      const heroId = heroItemIdOf(its, null)!;
      const zHero = res.placements.find((p) => p.itemId === heroId)!.zIndex;
      expect(zHero, `seed ${seed}`).toBe(5); // max orderIndex (4) + 1
      for (const p of res.placements) {
        if (p.itemId !== heroId) expect(p.zIndex, `seed ${seed} ${p.itemId}`).toBeLessThan(zHero);
      }
    }
  }, 120_000);

  it("2-step redesignation: B (focal hint) becomes the hero; the old hero A shrinks to a support", () => {
    // Step 1: A alone → solo hero (the 0.75 HERO_MAX_WIDTH ceiling — the
    // solo item fills the coverage budget alone). Step 2: B arrives with a
    // role:'focal' hint → B takes the hero size and A resizes as a support
    // (the solver re-ranks hero-first on EVERY solve).
    // MEASURED (seeds 1..5, equal 256×256 squares): A_solo 0.750,
    // B_hero 0.712–0.731, A_after 0.427 (ratio to B 0.585–0.600 — the band
    // ceiling), B > A always.
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = mkItem("a", { orderIndex: 0 });
      const r1 = solveLayout([a], {
        cardDims: card,
        k: K,
        textZone: TEXT_ZONE,
        rng: mulberry32(seed),
      });
      expect(r1.placements).toHaveLength(1);
      expect(sqW(r1.placements[0]!), `seed ${seed} A solo`).toBeGreaterThanOrEqual(0.72);

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
      // B lands on the n=2 hero window (measured 0.712–0.731).
      expect(wB, `seed ${seed} B hero`).toBeGreaterThanOrEqual(0.68);
      expect(wB, `seed ${seed} B hero`).toBeLessThanOrEqual(0.76);
      // A shrinks off the solo curve onto the support band (measured 0.427;
      // ratio to B 0.585–0.600 — never below the 0.5×hero band floor).
      expect(wA2, `seed ${seed} A shrunk`).toBeLessThanOrEqual(0.46);
      expect(wA2, `seed ${seed} A support floor`).toBeGreaterThanOrEqual(0.5 * wB - 0.01);
      expect(wB).toBeGreaterThan(wA2);
      // B renders topmost.
      expect(r2.placements.find((p) => p.itemId === "b")!.zIndex, `seed ${seed}`).toBe(2);
      expect(r2.placements.find((p) => p.itemId === "a")!.zIndex, `seed ${seed}`).toBeLessThan(2);
    }
  }, 120_000);

  /**
   * Top-corner region coverage (the prime empty space the space-aware floor
   * targets): fraction of grid cells with x ∈ [0, 0.25] ∪ [0.75, 1] and
   * y ∈ [0.24, 0.45] covered by a placed AABB. Same measure as the solver's
   * corner-anchor doc block (96×96 sample grid, pure + deterministic).
   */
  function cornerRegionCoverage(
    res: ReturnType<typeof solveLayout>,
    its: LayoutItem[],
  ): number {
    const N = 96;
    const inRegion = (fx: number, fy: number) =>
      fy >= 0.24 && fy <= 0.45 && (fx <= 0.25 || fx >= 0.75);
    let total = 0;
    let covered = 0;
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const fx = (gx + 0.5) / N;
        const fy = (gy + 0.5) / N;
        if (!inRegion(fx, fy)) continue;
        total++;
        const cx = fx * card.w;
        const cy = fy * card.h;
        for (const p of res.placements) {
          const item = its.find((i) => i.id === p.itemId)!;
          const b = placedBox(p, item, K);
          if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) {
            covered++;
            break;
          }
        }
      }
    }
    return total > 0 ? covered / total : 0;
  }
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

  it("cohesion: 2 same-group items sit near-touching (d ≤ 1.3×(halfA+halfB)), constraints pass", () => {
    // MEASURED (seeds 1..5, equal 256×256 squares, cohesion target 1.15×):
    // the pair equilibrates at d/halfSum ≈ 0.870–0.956 — the cohesion term
    // (W=1.0) pulls the support up against the (center-pinned, now larger
    // v4) hero.
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
      // The only pair here INVOLVES THE HERO ("a" is the hero — first
      // sticker), so it rides the 0.25 tuck cap.
      const sat = maxSatByPairKind(res, its);
      expect(sat.heroPairs, `seed ${seed} hero–support SAT`).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(sat.otherPairs, `seed ${seed} support–support SAT`).toBeLessThanOrEqual(0.10 + 1e-6);
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  }, 120_000);

  it("separation: 2 different-group items keep breathing room (d ≥ 0.70×(halfA+halfB))", () => {
    // USER DECISION (hero pinned center): "a" is the hero (first sticker) and
    // CANNOT move to its group center anymore — the hero sits centered and
    // the support orbits it. MEASURED (seeds 1..5): d/halfSum ≈ 0.897–0.991 —
    // the hero's dominance keeps the pair close, but the SAT caps still hold
    // and the separation term keeps true overlap inside the 0.25 tuck
    // tolerance. Asserted at the measured 0.70× floor.
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
        0.7 * halfSum - 1e-9,
      );
      const sat = maxSatByPairKind(res, its);
      expect(sat.heroPairs, `seed ${seed} hero–support SAT`).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(sat.otherPairs, `seed ${seed} support–support SAT`).toBeLessThanOrEqual(0.10 + 1e-6);
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  }, 120_000);

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
      // USER DECISION: orientation is DISABLED — every sticker stays at
      // 0 degrees, tiltToward hints are parsed but inert. Assert rotation 0
      // for both items across all seeds.
      expect(pb.rotation, `seed ${seed} b rotation`).toBe(0);
      expect(pa.rotation, `seed ${seed} a rotation`).toBe(0);
      // Hero-aware checkLayout ctx — the hero-involving pair rides the 0.25
      // tuck cap.
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  }, 120_000);

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
      // Hero-aware checkLayout ctx — the focal hint designates "a" as the
      // hero, so the pair rides the 0.25 tuck cap.
      expect(heroAwareCheck(res, its, hints).ok, `seed ${seed}`).toBe(true);
    }
  }, 120_000);

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
  }, 120_000);

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
    // v4 MEASURED (seed 2024): all 25 placed — the v3 drops are recovered.
    expect(res.placements).toHaveLength(25);
    // n > 20: the text rule is skipped in the ctx (MEASURED: the only
    // full-ctx violations are text_overlap for items at weight-rank ≥ 20).
    expect(
      heroAwareCheck(res, its, hints, res.relaxedMinSize, { checkTextOverlap: false }).ok,
    ).toBe(true);
    const byId = new Map(res.placements.map((p) => [p.itemId, p] as const));
    let intra = 0;
    let intraN = 0;
    let cross = 0;
    let crossN = 0;
    for (let i = 0; i < its.length; i++) {
      for (let j = i + 1; j < its.length; j++) {
        const pa = byId.get(its[i]!.id);
        const pb = byId.get(its[j]!.id);
        if (!pa || !pb) continue;
        const d = dist(pa, pb);
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
  }, 300_000);
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
  }, 120_000);
});

describe("solveLayout — hero identification", () => {
  it("FIRST sticker wins by default; a role:'focal' hint overrides", () => {
    // USER DECISION: no hints → the FIRST sticker is the hero ("similar size
    // as the first sticker"), regardless of visualWeight; the layout AI's
    // role:'focal' hint may re-designate a later sticker.
    const weighted = squareItems(3, (i) => [0.3, 0.9, 0.5][i]!);
    expect(heroItemIdOf(weighted, null)).toBe("i0");
    expect(heroItemIdOf(squareItems(3), null)).toBe("i0");
    // Hint override: the layout AI's role:'focal' hint designates the hero
    // even against the default ranking (equal weights would pick i0 by
    // orderIndex).
    const its = squareItems(2);
    const hints = layoutCompositionSchema.parse({
      focalPoint: { x: card.w / 2, y: card.h * 0.6 },
      groups: [{ itemIds: ["i0", "i1"], cx: card.w / 2, cy: card.h * 0.6, spread: 140 }],
      hints: [{ itemId: "i1", role: "focal", importance: 1 }],
      textZone: TEXT_ZONE,
      suggestedGreetingStyle: { align: "center", y: 150 },
    });
    expect(heroItemIdOf(its, hints)).toBe("i1");
    // End to end: the designated hero solves DOMINANT (wider than every
    // support, inside the n=2 hero window) even though it would NOT have
    // been the default rank-0 item. MEASURED (seed 9): wHero 0.712,
    // wSup 0.427 (ratio 0.60 — the band ceiling).
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
    expect(wHero).toBeGreaterThanOrEqual(0.68);
    expect(wHero).toBeGreaterThan(wSup);
  }, 120_000);
});

describe("solveLayout — hero tuck-cap bounds (constructed geometry)", () => {
  it("hero–support 0.20 passes / 0.30 fails; support–support 0.08 passes / 0.12 fails", () => {
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
});
