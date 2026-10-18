/**
 * Layout constraints tests (build-phase step 3) — pure geometry:
 * property-style random placements (seeded mulberry32) always satisfy the
 * bounds + size rules, text-zone rejection, and the TRUE rotated-rect
 * (SAT + clipped-polygon area) overlap measure: hand-computed areas, the
 * 45° false-positive case the old AABB measure rejected, and the
 * corner-based cap enforcement through checkItem/checkLayout.
 */

import { describe, expect, it } from "vitest";

import {
  CARD_COORD_SPACE,
  MAX_ITEM_SIZE_PCT,
  MAX_PAIRWISE_OVERLAP,
  MIN_ITEM_SIZE_PCT,
  type Placement,
} from "@cardcrafters/shared";

import {
  aabbOverlapCapOk,
  boxArea,
  boxIntersection,
  cardBox,
  HERO_TUCK_CAP,
  checkItem,
  checkLayout,
  displayWidth,
  type ConstraintCtx,
  inBoundsOk,
  overlapCapFor,
  overlapRatio,
  overlapCapOk,
  placedBox,
  placedFootprint,
  polygonArea,
  rotatedRectArea,
  rotatedRectCorners,
  rotatedRectOverlapArea,
  safeMargin,
  scaleFor,
  scaleWindow,
  sizeOk,
  TEXT_ZONE_PAD_FRAC,
  textOverlapOk,
  type Aabb,
  type LayoutItem,
  type Vec2,
} from "./constraints";
import { mulberry32 } from "./solver";

const card = cardBox({ width: CARD_COORD_SPACE, height: CARD_COORD_SPACE }, 5, 7);
const K = (0.25 * Math.min(card.w, card.h)) / 256; // baseFit(card)
const ZONE = { x: 0.1 * card.w, y: 0.06 * card.h, w: 0.8 * card.w, h: 0.16 * card.h };

function mkItem(overrides: Partial<LayoutItem> = {}): LayoutItem {
  return { id: "a", imgW: 256, imgH: 256, visualWeight: 0.5, orderIndex: 0, ...overrides };
}

/** Random scale inside the legal window (shrunk until the rotated AABB fits),
 *  then a center that keeps the AABB in bounds. */
function randomPlacement(rng: () => number, item: LayoutItem) {
  const { min, max } = scaleWindow(item, card, K);
  const m = safeMargin(card);
  const freeX = card.w - 2 * m.x;
  const freeY = card.h - 2 * m.y;
  let scale = min * 1.05 + rng() * (max - min) * 0.9;
  let rotation = (rng() * 2 - 1) * 180;
  // Shrink until the rotated AABB fits the free area on both axes (tall/narrow
  // source images may only fit near the min scale).
  for (let tries = 0; tries < 50; tries++) {
    const half = placedBox({ x: 0, y: 0, scale, rotation }, item, K);
    const hx = -half.x1;
    const hy = -half.y1;
    if (2 * hx <= freeX && 2 * hy <= freeY) break;
    scale *= 0.9;
  }
  const half = placedBox({ x: 0, y: 0, scale, rotation }, item, K);
  const hx = -half.x1;
  const hy = -half.y1;
  const x = m.x + hx + rng() * Math.max(0, freeX - 2 * hx);
  const y = m.y + hy + rng() * Math.max(0, freeY - 2 * hy);
  return { itemId: item.id, x, y, scale, rotation, zIndex: item.orderIndex };
}

/** Corner set of a side×side square centered at (cx, cy) rotated `deg`,
 *  via the production rotatedRectCorners (k = 1, scale = side / 256). */
function squareCorners(cx: number, cy: number, side: number, deg: number): Vec2[] {
  const item = mkItem({ imgW: side, imgH: side });
  return rotatedRectCorners({ x: cx, y: cy, scale: 1, rotation: deg }, item, 1);
}

describe("cardBox + sizing model", () => {
  it("fits a 5:7 card into the coordinate space anchored at origin", () => {
    expect(card.w).toBeCloseTo((5 / 7) * CARD_COORD_SPACE, 6);
    expect(card.h).toBeCloseTo(CARD_COORD_SPACE, 6);
  });

  it("a 256px sticker at scale 1 covers ~25% of the card min dimension", () => {
    const item = mkItem();
    const w = displayWidth(item, 1, K);
    expect(w / Math.min(card.w, card.h)).toBeCloseTo(0.25, 6);
  });

  it("scaleFor clamps into the min/max window", () => {
    const item = mkItem();
    const lo = scaleFor(item, card, K, 0);
    const hi = scaleFor(item, card, K, 1e9);
    expect(displayWidth(item, lo, K) / card.w).toBeCloseTo(MIN_ITEM_SIZE_PCT / 100, 6);
    expect(displayWidth(item, hi, K) / card.w).toBeCloseTo(MAX_ITEM_SIZE_PCT / 100, 6);
    // No scale → geometric middle of the window (also legal).
    const mid = scaleFor(item, card, K);
    expect(displayWidth(item, mid, K) / card.w).toBeGreaterThanOrEqual(MIN_ITEM_SIZE_PCT / 100);
    expect(displayWidth(item, mid, K) / card.w).toBeLessThanOrEqual(MAX_ITEM_SIZE_PCT / 100);
  });
});

describe("size window (raised MAX_ITEM_SIZE_PCT = 85)", () => {
  it("an ~80%-width solo item passes sizeOk; ~90% fails", () => {
    const item = mkItem(); // 256px square sticker
    // displayWidth = imgW × scale × k; k makes scale 1 ≈ 25% of min dim.
    const scaleForPct = (pct: number) => (pct / 100) * card.w / (256 * K);
    expect(sizeOk(item, scaleForPct(80), card, K)).toBe(true);
    expect(sizeOk(item, scaleForPct(85), card, K)).toBe(true);
    expect(sizeOk(item, scaleForPct(90), card, K)).toBe(false);
    expect(sizeOk(item, scaleForPct(5), card, K)).toBe(false);
  });
});

describe("property: 200 random placements satisfy bounds + size", () => {
  it("no out_of_bounds / too_small / too_large violations, all seeds", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const item = mkItem({
        id: `i${i}`,
        imgW: 128 + Math.floor(rng() * 384),
        imgH: 128 + Math.floor(rng() * 384),
        orderIndex: i,
      });
      const p = randomPlacement(rng, item);
      const res = checkLayout([p], [item], { card, k: K, textZone: null });
      const codes = new Set(res.violations.map((v) => v.code));
      expect(codes.has("out_of_bounds"), `seed iter ${i}`).toBe(false);
      expect(codes.has("too_small"), `seed iter ${i}`).toBe(false);
      expect(codes.has("too_large"), `seed iter ${i}`).toBe(false);
      expect(res.ok).toBe(true);
    }
  });
});

describe("noTextOverlap", () => {
  it("rejects an AABB intersecting the inflated zone", () => {
    const item = mkItem();
    const scale = scaleFor(item, card, K);
    const inside = { itemId: item.id, x: ZONE.x + ZONE.w / 2, y: ZONE.y + ZONE.h / 2, scale, rotation: 0, zIndex: 0 };
    const res = checkItem(inside, item, { card, k: K, textZone: ZONE });
    expect(res.map((v) => v.code)).toContain("text_overlap");
    expect(textOverlapOk(placedBox(inside, item, K), ZONE, card)).toBe(false);
  });

  it("accepts an AABB just outside the 2% padding", () => {
    const item = mkItem();
    const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
    const scale = scaleFor(item, card, K, undefined, MIN_ITEM_SIZE_PCT);
    const box = placedBox({ x: 0, y: 0, scale, rotation: 0 }, item, K);
    const hh = (box.y2 - box.y1) / 2;
    const m = safeMargin(card);
    // Just BELOW the inflated zone, horizontally centered (min-size item:
    // there is no room between the margin and the zone on the x axis).
    const cy = ZONE.y + ZONE.h + pad + hh + 1;
    const cx = card.w / 2;
    expect(cy + hh).toBeLessThanOrEqual(card.h - m.y);
    const p = { itemId: item.id, x: cx, y: cy, scale, rotation: 0, zIndex: 0 };
    const res = checkItem(p, item, { card, k: K, textZone: ZONE });
    expect(res).toEqual([]);
  });
});

describe("SAT overlap — true rotated-rect measure", () => {
  it("two axis-aligned squares with 25% area overlap → overlapRatio = 0.25", () => {
    // Squares of side 100, centers offset by 75 in x: the intersection is a
    // 25 × 100 strip → 2500 / 10000 = 0.25 of each (equal) area.
    const a = squareCorners(0, 0, 100, 0);
    const b = squareCorners(75, 0, 100, 0);
    expect(rotatedRectOverlapArea(a, b)).toBeCloseTo(2500, 6);
    expect(overlapRatio(a, b)).toBeCloseTo(0.25, 6);
    // The 10% cap rejects it; exactly 10% passes (boundary).
    expect(overlapCapOk(a, b, 0.10)).toBe(false);
    const b10 = squareCorners(90, 0, 100, 0);
    expect(overlapRatio(a, b10)).toBeCloseTo(0.10, 6);
    expect(overlapCapOk(a, b10, 0.10)).toBe(true);
  });

  it("two 45°-rotated squares: AABBs overlap ~40% per axis, TRUE overlap = 0", () => {
    // Two side-100 squares both rotated 45° (diamonds, AABB 100√2 ≈ 141.42
    // per side), centers offset by (85, 85). Their AABBs overlap by
    // (141.42 − 85) / 141.42 ≈ 39.8% along EACH axis, but along the
    // separating axis (1,1)/√2 the projection of the center offset is
    // 170/√2 ≈ 120.2 > 50 + 50 (the diamonds' half-extents along their
    // edge normals), so the rotated rectangles themselves never intersect.
    const a = squareCorners(0, 0, 100, 45);
    const b = squareCorners(85, 85, 100, 45);
    expect(overlapRatio(a, b)).toBeLessThan(1e-9);
    expect(overlapCapOk(a, b, 0.10)).toBe(true);
    // The deprecated AABB measure REJECTS this legal pair — the documented
    // false positive that motivated the corner-based rewrite.
    const aabbA: Aabb = { x1: -70.71, y1: -70.71, x2: 70.71, y2: 70.71 };
    const aabbB: Aabb = { x1: 14.29, y1: 14.29, x2: 155.71, y2: 155.71 };
    expect(aabbOverlapCapOk(aabbA, aabbB, 0.10)).toBe(false);
  });

  it("hand-computed non-trivial case: square ∩ 45°-rotated square = octagon", () => {
    // Unit square [0,1]² and the same square rotated 45° about the shared
    // center (0.5, 0.5). The rotated square is the diamond
    // |x−0.5| + |y−0.5| ≤ 1/√2; inside the unit square it cuts one right
    // isosceles triangle off each corner with leg c = 1 − 1/√2 (the corner
    // (0,0) triangle is bounded by x + y = c), area c²/2 each.
    //   intersection = 1 − 4·c²/2 = 1 − 2(1 − 1/√2)² = 2√2 − 2 ≈ 0.828427
    // Both rects have area 1, so the overlap ratio equals that area.
    const a = squareCorners(0.5, 0.5, 1, 0);
    const b = squareCorners(0.5, 0.5, 1, 45);
    expect(rotatedRectArea(a)).toBeCloseTo(1, 9);
    expect(rotatedRectArea(b)).toBeCloseTo(1, 9);
    const expected = 2 * Math.SQRT2 - 2;
    expect(rotatedRectOverlapArea(a, b)).toBeCloseTo(expected, 9);
    expect(overlapRatio(a, b)).toBeCloseTo(expected, 9);
  });

  it("rotatedRectCorners winding + area: positive shoelace, area = w × h", () => {
    const item = mkItem({ imgW: 100, imgH: 40 });
    const corners = rotatedRectCorners({ x: 5, y: 5, scale: 1, rotation: 30 }, item, 1);
    expect(polygonArea(corners)).toBeGreaterThan(0); // CCW-positive winding
    expect(rotatedRectArea(corners)).toBeCloseTo(4000, 6); // rotation-invariant
    // 0° corners are the axis-aligned rect itself.
    const c0 = rotatedRectCorners({ x: 5, y: 5, scale: 1, rotation: 0 }, item, 1);
    expect(c0[0]).toEqual({ x: -45, y: -15 });
    expect(c0[2]).toEqual({ x: 55, y: 25 });
  });

  it("overlapCapFor(n) === 0.10 for every n (single user tolerance)", () => {
    for (let n = 1; n <= 25; n++) {
      expect(overlapCapFor(n)).toBe(0.10);
      expect(overlapCapFor(n)).toBe(MAX_PAIRWISE_OVERLAP);
    }
  });

  it("checkItem/checkLayout enforce the corner-based cap (0.3 fails, 0.08 passes)", () => {
    const item = mkItem();
    const other = { ...item, id: "b", orderIndex: 1 };
    const { min } = scaleWindow(item, card, K);
    const w = displayWidth(item, min, K); // display width in normalized units
    const cx = card.w / 2;
    const cy = card.h / 2;
    const mk = (id: string, x: number) => ({ itemId: id, x, y: cy, scale: min, rotation: 0, zIndex: 0 });
    // Offset 0.7 × width → intersection strip 0.3 × width → ratio 0.30.
    const p30a = mk("a", cx - w * 0.35);
    const p30b = mk("b", cx + w * 0.35);
    // Offset 0.92 × width → ratio 0.08.
    const p08a = mk("a", cx - w * 0.46);
    const p08b = mk("b", cx + w * 0.46);
    const its = [item, other];
    const fpA = placedFootprint(p30a, item, K);
    const fpA08 = placedFootprint(p08a, item, K);
    // Sanity: the true ratios are what the geometry says.
    expect(overlapRatio(fpA.corners, placedFootprint(p30b, other, K).corners)).toBeCloseTo(0.3, 6);
    expect(overlapRatio(fpA08.corners, placedFootprint(p08b, other, K).corners)).toBeCloseTo(0.08, 6);
    // checkItem: 30% is rejected, 8% accepted, under the default 10% cap.
    expect(
      checkItem(p30b, other, { card, k: K, textZone: null }, [fpA])
        .map((v) => v.code),
    ).toContain("overlap_cap");
    expect(
      checkItem(p08b, other, { card, k: K, textZone: null }, [fpA08]),
    ).toEqual([]);
    // ctx.overlapCap is honored (relaxed cap admits the 30% pair).
    expect(
      checkItem(p30b, other, { card, k: K, textZone: null, overlapCap: 0.35 }, [fpA]),
    ).toEqual([]);
    // checkLayout surfaces the violation pair-wise.
    const res = checkLayout([p30a, p30b], its, { card, k: K, textZone: null });
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "overlap_cap")).toBe(true);
    expect(
      checkLayout([p08a, p08b], its, { card, k: K, textZone: null }).ok,
    ).toBe(true);
  });

  it("aabbOverlapCapOk vs overlapCapOk on the same AABB pair (legacy contrast)", () => {
    // Axis-aligned squares overlapping 30%: both measures agree it fails 0.10.
    const A: Aabb = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const B: Aabb = { x1: 70, y1: 0, x2: 170, y2: 100 };
    expect(boxArea(boxIntersection(A, B)) / boxArea(A)).toBeCloseTo(0.3, 9);
    expect(aabbOverlapCapOk(A, B, 0.10)).toBe(false);
    expect(overlapCapOk(squareCorners(50, 50, 100, 0), squareCorners(120, 50, 100, 0), 0.10)).toBe(false);
    // …and both agree a 10%-exact overlap passes at the boundary.
    const B10: Aabb = { x1: 90, y1: 0, x2: 190, y2: 100 };
    expect(aabbOverlapCapOk(A, B10, 0.10)).toBe(true);
    expect(overlapCapOk(squareCorners(50, 50, 100, 0), squareCorners(140, 50, 100, 0), 0.10)).toBe(true);
  });
});

describe("inBoundsOk at the margin line", () => {
  it("rejects/accepts at the margin line", () => {
    const m = safeMargin(card);
    expect(inBoundsOk({ x1: m.x - 1, y1: m.y, x2: 100, y2: 100 }, card)).toBe(false);
    expect(inBoundsOk({ x1: m.x, y1: m.y, x2: card.w - m.x, y2: card.h - m.y }, card)).toBe(true);
  });
});

describe("rotated AABB", () => {
  it("90° rotation swaps width/height", () => {
    const item = mkItem({ imgW: 100, imgH: 200 });
    const p = { itemId: item.id, x: 500, y: 500, scale: 1, rotation: 90, zIndex: 0 };
    const b = placedBox(p, item, 1); // k=1 → display = source px
    expect(b.x2 - b.x1).toBeCloseTo(200, 6);
    expect(b.y2 - b.y1).toBeCloseTo(100, 6);
    expect(b.x1).toBeCloseTo(500 - 100, 6);
    expect(b.y1).toBeCloseTo(500 - 50, 6);
  });

  it("0° rotation keeps width/height; 45° overestimates symmetrically", () => {
    const item = mkItem({ imgW: 100, imgH: 200 });
    const b0 = placedBox({ x: 0, y: 0, scale: 1, rotation: 0 }, item, 1);
    expect(b0.x2 - b0.x1).toBeCloseTo(100, 6);
    expect(b0.y2 - b0.y1).toBeCloseTo(200, 6);
    const b45 = placedBox({ x: 0, y: 0, scale: 1, rotation: 45 }, item, 1);
    expect(b45.x2 - b45.x1).toBeCloseTo((100 + 200) / Math.SQRT2, 3);
  });
});

describe("overlapCapFactor — final-montage relaxation", () => {
  // Axis-aligned squares of display width w: center separation (1 − ratio) × w
  // → intersection strip ratio (same construction as the corner-based cap
  // test above). 0.12 sits BETWEEN the strict 0.10 cap and the relaxed
  // 0.10 × 1.8 = 0.18 cap; 0.30 sits BETWEEN the strict 0.25 hero tuck cap
  // and the relaxed 0.25 × 1.8 = 0.45 tuck cap.
  const item = mkItem();
  const other = { ...item, id: "b", orderIndex: 1 };
  const { min } = scaleWindow(item, card, K);
  const w = displayWidth(item, min, K); // display width in normalized units
  const cy = card.h / 2;
  const mk = (id: string, x: number): Placement => ({
    itemId: id,
    x,
    y: cy,
    scale: min,
    rotation: 0,
    zIndex: 0,
  });
  const pair = (ratio: number) => {
    const sep = w * (1 - ratio);
    const a = mk("a", card.w / 2 - sep / 2);
    const b = mk("b", card.w / 2 + sep / 2);
    return { a, b, fpA: placedFootprint(a, item, K) };
  };
  const ctx = (extra: Partial<ConstraintCtx> = {}) => ({
    card,
    k: K,
    textZone: null,
    ...extra,
  });

  it("default (absent) and factor 1 reproduce the strict caps exactly", () => {
    const p30 = pair(0.30);
    const p08 = pair(0.08);
    for (const factor of [undefined, 1] as const) {
      const c = ctx(factor === undefined ? {} : { overlapCapFactor: factor });
      // 0.30 pair: rejected under the strict 0.10 support–support cap.
      expect(
        checkItem(p30.b, other, c, [p30.fpA]).map((v) => v.code),
      ).toContain("overlap_cap");
      // 0.08 pair: accepted either way.
      expect(checkItem(p08.b, other, c, [p08.fpA])).toEqual([]);
    }
  });

  it("factor 1.8 relaxes the support–support cap 0.10 → 0.18", () => {
    const p12 = pair(0.12);
    expect(
      overlapRatio(p12.fpA.corners, placedFootprint(p12.b, other, K).corners),
    ).toBeCloseTo(0.12, 6);
    // Strict (no factor): the 0.12 pair violates the 0.10 cap.
    expect(
      checkItem(p12.b, other, ctx(), [p12.fpA]).map((v) => v.code),
    ).toContain("overlap_cap");
    // Relaxed (factor 1.8 → effective 0.18): the SAME geometry is legal.
    expect(
      checkItem(p12.b, other, ctx({ overlapCapFactor: 1.8 }), [p12.fpA]),
    ).toEqual([]);
    // …and the whole layout flips from illegal to legal, pairwise.
    expect(checkLayout([p12.a, p12.b], [item, other], ctx()).ok).toBe(false);
    expect(
      checkLayout([p12.a, p12.b], [item, other], ctx({ overlapCapFactor: 1.8 })).ok,
    ).toBe(true);
  });

  it("factor 1.8 relaxes the hero tuck cap 0.25 → 0.45", () => {
    const heroCtx = (factor?: number) =>
      ctx({
        heroItemId: "a",
        heroOverlapCap: HERO_TUCK_CAP,
        ...(factor !== undefined ? { overlapCapFactor: factor } : {}),
      });
    const p30 = pair(0.30);
    expect(
      overlapRatio(p30.fpA.corners, placedFootprint(p30.b, other, K).corners),
    ).toBeCloseTo(0.30, 6);
    // Strict tuck cap 0.25: the 0.30 hero–support pair is rejected.
    const strict = checkLayout([p30.a, p30.b], [item, other], heroCtx());
    expect(strict.ok).toBe(false);
    expect(
      strict.violations.some(
        (v) => v.code === "overlap_cap" && v.itemId === "b" && v.otherItemId === "a",
      ),
    ).toBe(true);
    // Relaxed tuck cap 0.45 (0.25 × 1.8): the SAME geometry is legal.
    expect(checkLayout([p30.a, p30.b], [item, other], heroCtx(1.8)).ok).toBe(true);
    // The factor must NOT loosen the cap beyond its own band: a 0.55 pair
    // still violates even the relaxed 0.45 tuck cap.
    const p55 = pair(0.55);
    expect(checkLayout([p55.a, p55.b], [item, other], heroCtx(1.8)).ok).toBe(false);
  });
});
