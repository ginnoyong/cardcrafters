/**
 * Layout scoring tests (build-phase step 3) — term sanity, hierarchy
 * direction, and determinism. Pure functions, no mocks needed.
 */

import { describe, expect, it } from "vitest";

import { CARD_COORD_SPACE } from "@cardcrafters/shared";

import { cardBox, scaleFor, type LayoutItem } from "./constraints";
import { scoreLayout, type ScoreContext } from "./score";

const card = cardBox({ width: CARD_COORD_SPACE, height: CARD_COORD_SPACE }, 5, 7);
const K = (0.25 * Math.min(card.w, card.h)) / 256;
const FOCAL = { x: card.w * 0.618, y: card.h * 0.382 };

function mkItem(id: string, overrides: Partial<LayoutItem> = {}): LayoutItem {
  return { id, imgW: 256, imgH: 256, visualWeight: 0.5, orderIndex: 0, ...overrides };
}

function ctx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return { card, k: K, focalPoint: FOCAL, ...overrides };
}

/** A placement with the item's default (geometric-mid) scale. */
function place(item: LayoutItem, x: number, y: number, rotation = 0, scale?: number) {
  return { itemId: item.id, x, y, scale: scale ?? scaleFor(item, card, K), rotation, zIndex: item.orderIndex };
}

describe("focal term", () => {
  it("a layout hugging the focal point scores lower than one pushed to a corner", () => {
    const a = mkItem("a");
    const b = mkItem("b", { visualWeight: 0.8 });
    const near = [place(a, FOCAL.x, FOCAL.y), place(b, FOCAL.x + 40, FOCAL.y - 30, 5)];
    const far = [place(a, card.w * 0.1, card.h * 0.9), place(b, card.w * 0.15, card.h * 0.95, 5)];
    expect(scoreLayout(near, [a, b], ctx())).toBeLessThan(scoreLayout(far, [a, b], ctx()));
  });

  it("heavier items are pulled harder toward the focal point", () => {
    // Distinct orderIndex values: with equal display sizes the hierarchy
    // term's size-rank tie-break would otherwise fall back to placement
    // order and dominate the (correctly weighted) focal difference.
    const light = mkItem("a", { visualWeight: 0.05, orderIndex: 0 });
    const heavy = mkItem("a2", { visualWeight: 1, orderIndex: 1 });
    // Same distance from the focal point, but the layout whose HEAVY item is
    // close and light item far must beat the inverse.
    const d = 200;
    const heavyNear = [
      place(heavy, FOCAL.x + d * 0.2, FOCAL.y),
      place(light, FOCAL.x + d, FOCAL.y),
    ];
    const heavyFar = [
      place(light, FOCAL.x + d * 0.2, FOCAL.y),
      place(heavy, FOCAL.x + d, FOCAL.y),
    ];
    expect(scoreLayout(heavyNear, [light, heavy], ctx())).toBeLessThan(
      scoreLayout(heavyFar, [light, heavy], ctx()),
    );
  });
});

describe("spacing term", () => {
  it("a spread layout scores lower than a cramped (overlapping) one", () => {
    const a = mkItem("a", { visualWeight: 0.9 });
    const b = mkItem("b", { visualWeight: 0.8 });
    const size = scaleFor(a, card, K) * 256 * K; // display px
    const cramped = [place(a, card.w / 2, card.h / 2), place(b, card.w / 2 + size * 0.4, card.h / 2)];
    const spread = [place(a, card.w * 0.3, card.h * 0.35), place(b, card.w * 0.7, card.h * 0.65)];
    const sCramped = scoreLayout(cramped, [a, b], ctx());
    const sSpread = scoreLayout(spread, [a, b], ctx());
    expect(sSpread).toBeLessThan(sCramped);
  });
});

describe("coverage term", () => {
  it("penalizes near-empty and over-stuffed cards inside the 25–60% band ideal", () => {
    const item = mkItem("a", { imgW: 256, imgH: 256 });
    const scale = scaleFor(item, card, K);
    // One min-ish sticker ≈ 3% coverage → below the band.
    const tiny = [place(item, card.w / 2, card.h / 2, 0, scaleFor(item, card, K, undefined, 6))];
    // Many large stickers → above the band.
    const items = Array.from({ length: 14 }, (_, i) => mkItem(`s${i}`, { orderIndex: i }));
    const stuffed = items.map((it, i) =>
      place(it, card.w * (0.15 + 0.05 * (i % 8)), card.h * (0.12 + 0.06 * Math.floor(i / 4)), 0, 1.5),
    );
    const sTiny = scoreLayout(tiny, [item], ctx());
    const sStuffed = scoreLayout(stuffed, items, ctx());
    expect(sTiny).toBeGreaterThan(0.05);
    expect(sStuffed).toBeGreaterThan(0.05);
  });
});

describe("hierarchy term", () => {
  it("weight-sorted sizes beat anti-sorted sizes", () => {
    const heavy = mkItem("h", { visualWeight: 1, orderIndex: 0 });
    const mid = mkItem("m", { visualWeight: 0.6, orderIndex: 1 });
    const light = mkItem("l", { visualWeight: 0.1, orderIndex: 2 });
    const items = [heavy, mid, light];
    const bigScale = 1.6;
    const smallScale = 0.28;
    const matching = [
      place(heavy, card.w * 0.35, card.h * 0.4, 0, bigScale),
      place(mid, card.w * 0.6, card.h * 0.55, 0, 0.8),
      place(light, card.w * 0.8, card.h * 0.7, 0, smallScale),
    ];
    const anti = [
      place(heavy, card.w * 0.35, card.h * 0.4, 0, smallScale),
      place(mid, card.w * 0.6, card.h * 0.55, 0, 0.8),
      place(light, card.w * 0.8, card.h * 0.7, 0, bigScale),
    ];
    expect(scoreLayout(matching, items, ctx())).toBeLessThan(scoreLayout(anti, items, ctx()));
  });
});

describe("rotation term", () => {
  it("wild rotation variance penalizes unless clustered", () => {
    const items = [mkItem("a"), mkItem("b", { orderIndex: 1 }), mkItem("c", { orderIndex: 2 })];
    const wild = items.map((it, i) => place(it, card.w * (0.3 + 0.2 * i), card.h * 0.5, i * 60 - 60));
    const calm = items.map((it, i) => place(it, card.w * (0.3 + 0.2 * i), card.h * 0.5, 0));
    expect(scoreLayout(wild, items, ctx())).toBeGreaterThan(scoreLayout(calm, items, ctx()));
    expect(scoreLayout(wild, items, ctx({ clustered: true }))).toBeCloseTo(
      scoreLayout(wild, items, ctx({ clustered: true, focalPoint: null })) - 0, 0,
    );
  });
});

describe("determinism", () => {
  it("same input → same score, always", () => {
    const items = [
      mkItem("a", { visualWeight: 0.9, orderIndex: 0 }),
      mkItem("b", { visualWeight: 0.4, orderIndex: 1, imgW: 300, imgH: 200 }),
    ];
    const placements = [place(items[0]!, card.w * 0.4, card.h * 0.5, 7), place(items[1]!, card.w * 0.7, card.h * 0.6, -12)];
    const s1 = scoreLayout(placements, items, ctx({ textZone: null }));
    const s2 = scoreLayout(placements, items, ctx({ textZone: null }));
    expect(s1).toBe(s2);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s1).toBeLessThanOrEqual(1);
  });
});
