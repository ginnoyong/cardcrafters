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
  type Placement,
} from "@cardcrafters/shared";

import {
  cardBox,
  checkLayout,
  placedBox,
  safeMargin,
  scaleWindow,
  textOverlapOk,
  type LayoutItem,
  type Rect,
} from "./constraints";
import { scoreLayout } from "./score";
import { mulberry32, solveLayout } from "./solver";

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

describe("solveLayout — sizing policy (coverage-proportional targets)", () => {
  /** Unrotated display width of a placement as a fraction of the card width. */
  const widthPct = (p: Placement, item: LayoutItem): number =>
    (item.imgW * p.scale * K) / card.w;

  it("1 item → display width ≈ 75–85% of the card width", () => {
    const item = mkItem("solo");
    const res = solve([item], 7);
    expect(res.placements).toHaveLength(1);
    const w = widthPct(res.placements[0]!, item);
    expect(w).toBeGreaterThanOrEqual(0.75);
    expect(w).toBeLessThanOrEqual(0.85);
  });

  it("3 items → each clearly smaller than the solo item; 5 smaller again", () => {
    for (const n of [3, 5]) {
      const its = items(n, (i) => 0.9 - i * 0.1);
      const res = solve(its, 11);
      expect(res.placements).toHaveLength(n);
      const avgW =
        its.reduce(
          (s, it) =>
            s +
            widthPct(
              res.placements.find((p) => p.itemId === it.id)!,
              it,
            ),
          0,
        ) / n;
      // Solo target ≈ 80% width; n=3 → ~sqrt(0.5/3) ≈ 41%; n=5 → ~32%.
      expect(avgW).toBeLessThan(n === 3 ? 0.55 : 0.42);
      expect(avgW).toBeGreaterThan(0.2);
    }
  });

  it("average display width decreases monotonically as n grows 1→2→3→5→10", () => {
    const avgs: number[] = [];
    for (const n of [1, 2, 3, 5, 10]) {
      const its = items(n, (i) => 0.5 + 0.05 * (i % 4));
      const res = solve(its, 99);
      expect(res.placements).toHaveLength(n);
      avgs.push(
        its.reduce(
          (s, it) =>
            s +
            widthPct(res.placements.find((p) => p.itemId === it.id)!, it),
          0,
        ) / n,
      );
    }
    for (let i = 1; i < avgs.length; i++) {
      expect(avgs[i]!).toBeLessThan(avgs[i - 1]!);
    }
  });

  it("all n still pass checkLayout (n = 1, 2, 3, 5, 10)", () => {
    for (const n of [1, 2, 3, 5, 10]) {
      const its = items(n, (i) => 0.9 - (i * 7) % 70 / 100);
      const res = solve(its, 1234 + n);
      expect(res.placements).toHaveLength(n);
      expect(
        checkLayout(res.placements, its, { card, k: K, textZone: TEXT_ZONE }).ok,
      ).toBe(true);
    }
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