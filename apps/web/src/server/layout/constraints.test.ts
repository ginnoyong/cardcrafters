/**
 * Layout constraints tests (build-phase step 3) — pure geometry:
 * property-style random placements (seeded mulberry32) always satisfy the
 * bounds + size rules, text-zone rejection, overlap-cap boundary cases, and
 * rotated-AABB correctness.
 */

import { describe, expect, it } from "vitest";

import {
  CARD_COORD_SPACE,
  MAX_ITEM_SIZE_PCT,
  MAX_PAIRWISE_OVERLAP,
  MIN_ITEM_SIZE_PCT,
  SMALL_N_OVERLAP_CAP,
} from "@cardcrafters/shared";

import {
  boxArea,
  boxIntersection,
  cardBox,
  checkItem,
  checkLayout,
  displayWidth,
  inBoundsOk,
  overlapCapFor,
  overlapCapOk,
  placedBox,
  safeMargin,
  scaleFor,
  scaleWindow,
  sizeOk,
  TEXT_ZONE_PAD_FRAC,
  textOverlapOk,
  type Aabb,
  type LayoutItem,
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

describe("overlapCap", () => {
  const A: Aabb = { x1: 0, y1: 0, x2: 100, y2: 100 };
  const area = boxArea(A);

  it("exactly 25% overlap passes (boundary)", () => {
    const B: Aabb = { x1: 75, y1: 0, x2: 175, y2: 100 };
    expect(boxArea(boxIntersection(A, B)) / area).toBeCloseTo(0.25, 9);
    expect(overlapCapOk(A, B)).toBe(true);
  });

  it("26% overlap fails", () => {
    const B: Aabb = { x1: 74, y1: 0, x2: 174, y2: 100 };
    expect(boxArea(boxIntersection(A, B)) / area).toBeCloseTo(0.26, 9);
    expect(overlapCapOk(A, B)).toBe(false);
  });

  it("cap is a parameter (default = general MAX_PAIRWISE_OVERLAP)", () => {
    const B: Aabb = { x1: 70, y1: 0, x2: 170, y2: 100 }; // 30% overlap
    expect(boxArea(boxIntersection(A, B)) / area).toBeCloseTo(0.3, 9);
    expect(overlapCapOk(A, B, MAX_PAIRWISE_OVERLAP)).toBe(false);
    expect(overlapCapOk(A, B, SMALL_N_OVERLAP_CAP)).toBe(true);
    // Boundary of the relaxed cap itself.
    const C: Aabb = { x1: 65, y1: 0, x2: 165, y2: 100 }; // exactly 35%
    expect(overlapCapOk(A, C, SMALL_N_OVERLAP_CAP)).toBe(true);
    const D: Aabb = { x1: 64, y1: 0, x2: 164, y2: 100 }; // 36%
    expect(overlapCapOk(A, D, SMALL_N_OVERLAP_CAP)).toBe(false);
  });

  it("overlapCapFor: relaxed for n ≤ 3, general otherwise", () => {
    expect(overlapCapFor(1)).toBe(SMALL_N_OVERLAP_CAP);
    expect(overlapCapFor(2)).toBe(SMALL_N_OVERLAP_CAP);
    expect(overlapCapFor(3)).toBe(SMALL_N_OVERLAP_CAP);
    expect(overlapCapFor(4)).toBe(MAX_PAIRWISE_OVERLAP);
    expect(overlapCapFor(25)).toBe(MAX_PAIRWISE_OVERLAP);
  });

  it("checkItem/checkLayout honor ctx.overlapCap", () => {
    const item = mkItem();
    const { min } = scaleWindow(item, card, K);
    const w = displayWidth(item, min, K);
    const cx = card.w / 2;
    const cy = card.h / 2;
    const p1 = { itemId: "a", x: cx, y: cy, scale: min, rotation: 0, zIndex: 0 };
    const p2 = { itemId: "b", x: cx + w * 0.7, y: cy, scale: min, rotation: 0, zIndex: 1 };
    const its = [item, { ...item, id: "b", orderIndex: 1 }];
    // 30% overlap of equal boxes: legal only under the relaxed cap.
    const boxes = [
      { itemId: "a", box: placedBox(p1, item, K) },
      { itemId: "b", box: placedBox(p2, item, K) },
    ];
    expect(overlapCapOk(boxes[0]!.box, boxes[1]!.box, 0.35)).toBe(true);
    expect(overlapCapOk(boxes[0]!.box, boxes[1]!.box)).toBe(false);
    expect(checkItem(p2, its[1]!, { card, k: K, textZone: null, overlapCap: 0.35 }, [boxes[0]!])).toEqual([]);
    expect(
      checkLayout([p1, p2], its, { card, k: K, textZone: null, overlapCap: 0.35 }).ok,
    ).toBe(true);
    expect(
      checkLayout([p1, p2], its, { card, k: K, textZone: null }).violations.some(
        (v) => v.code === "overlap_cap",
      ),
    ).toBe(true);
  });

  it("surfaces overlap_cap violations through checkLayout", () => {
    const item = mkItem();
    // Tiny scale so both boxes fit side by side; then force heavy overlap.
    const { min } = scaleWindow(item, card, K);
    const scale = min;
    const w = displayWidth(item, scale, K);
    const cx = card.w / 2;
    const cy = card.h / 2;
    const p1 = { itemId: "a", x: cx, y: cy, scale, rotation: 0, zIndex: 0 };
    const p2 = { itemId: "b", x: cx + w * 0.5, y: cy, scale, rotation: 0, zIndex: 1 };
    const items = [item, { ...item, id: "b", orderIndex: 1 }];
    const res = checkLayout([p1, p2], items, { card, k: K, textZone: null });
    expect(res.violations.filter((v) => v.code === "overlap_cap").length).toBeGreaterThan(0);
  });

  it("inBoundsOk rejects/accepts at the margin line", () => {
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
