/**
 * Layout scoring (build-phase step 3) — PURE, deterministic, lower = better.
 *
 * scoreLayout(placements, items, ctx) returns a number in 0..1 (weighted sum
 * of six normalized 0..1 terms; weights below sum to exactly 1). Determinism:
 * no randomness, no time, no iteration order dependence — same inputs always
 * produce the same number (coverage uses a fixed sampling grid, ranking uses
 * a deterministic orderIndex tie-break).
 *
 * Terms (weight · meaning):
 *  focal 0.35  — visualWeight-weighted mean distance of item centroids from
 *                ctx.focalPoint, normalized by half the card diagonal
 *                (heavy stickers should sit near the composition's focus).
 *  space 0.25  — pairwise crowding: pairs whose centroid distance is below a
 *                "comfort distance" = 1.1 × sqrt(avg of the two AABB areas)
 *                are penalized proportionally to the shortfall.
 *  cover 0.15  — card coverage (fraction of a 24×24 sample grid inside any
 *                AABB) is penalized outside the 25–60% sweet spot band.
 *  hiera 0.15  — size hierarchy: Spearman-style rank correlation between
 *                visualWeight and display size; penalty = (1 − corr)/2, so
 *                heavy items being big scores 0 and inverted order scores ~1.
 *  edge  0.05  — items whose AABB hugs the safe margin (gap < 1% of the card
 *                dimension) — placements that LOOK cramped against the edge.
 *  rot   0.05  — rotation variance: std of rotations > 12° is penalized
 *                (scattered random-looking tilts), unless ctx.clustered says
 *                the hint asked for a tight cluster.
 */

import type { Placement } from "@cardcrafters/shared";

import {
  boxArea,
  boxCenter,
  placedBox,
  safeMargin,
  type CardBox,
  type LayoutItem,
  type Rect,
} from "./constraints";

/** Term weights — sum to exactly 1 so the score lives on a 0..1 scale. */
export const SCORE_WEIGHTS = {
  focal: 0.35,
  spacing: 0.25,
  coverage: 0.15,
  hierarchy: 0.15,
  edge: 0.05,
  rotation: 0.05,
} as const;

export interface ScoreContext {
  card: CardBox;
  k: number;
  /** Greeting text zone — reserved by the solver, NOT scored here. */
  textZone?: Rect | null;
  /** Composition focus (LLM hint or card center by default). */
  focalPoint?: { x: number; y: number } | null;
  /** When a hint asked for a clustered composition, skip rotation-variance. */
  clustered?: boolean;
}

/** Coverage sampling grid resolution (per axis, over the card box). */
const COVERAGE_GRID = 24;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** visualWeight-weighted normalized focal distance. */
export function focalTerm(
  placements: Placement[],
  items: Map<string, LayoutItem>,
  ctx: ScoreContext,
): number {
  if (placements.length === 0) return 0;
  const focal =
    ctx.focalPoint ??
    { x: ctx.card.w / 2, y: ctx.card.h / 2 };
  const halfDiag = 0.5 * Math.hypot(ctx.card.w, ctx.card.h);
  let wSum = 0;
  let dSum = 0;
  for (const p of placements) {
    const item = items.get(p.itemId);
    if (!item) continue;
    const c = boxCenter(placedBox(p, item, ctx.k));
    const w = item.visualWeight > 0 ? item.visualWeight : 0; // weight 0 contributes nothing
    const d = Math.min(1, Math.hypot(c.x - focal.x, c.y - focal.y) / halfDiag);
    wSum += w;
    dSum += w * d;
  }
  // All-zero weights (fully transparent stickers): fall back to unweighted mean.
  if (wSum <= 0) {
    let n = 0;
    let s = 0;
    for (const p of placements) {
      const item = items.get(p.itemId);
      if (!item) continue;
      const c = boxCenter(placedBox(p, item, ctx.k));
      s += Math.min(1, Math.hypot(c.x - focal.x, c.y - focal.y) / halfDiag);
      n++;
    }
    return n === 0 ? 0 : s / n;
  }
  return dSum / wSum;
}

/** Mean pairwise crowding shortfall vs the comfort distance. */
export function spacingTerm(
  placements: Placement[],
  items: Map<string, LayoutItem>,
  ctx: ScoreContext,
): number {
  if (placements.length < 2) return 0;
  const boxes = placements
    .map((p) => {
      const item = items.get(p.itemId);
      return item ? { box: placedBox(p, item, ctx.k), p } : null;
    })
    .filter((b): b is { box: ReturnType<typeof placedBox>; p: Placement } => b !== null);
  let penalty = 0;
  let pairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const ca = boxCenter(a.box);
      const cb = boxCenter(b.box);
      const comfort =
        1.1 * Math.sqrt((boxArea(a.box) + boxArea(b.box)) / 2);
      const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
      if (d < comfort) penalty += (comfort - d) / comfort;
      pairs++;
    }
  }
  return pairs === 0 ? 0 : clamp01(penalty / pairs);
}

/** Coverage outside the 25–60% band, measured on a fixed 24×24 grid. */
export function coverageTerm(
  placements: Placement[],
  items: Map<string, LayoutItem>,
  ctx: ScoreContext,
): number {
  if (placements.length === 0) return 1; // empty card = maximally uncovered
  const boxes = placements
    .map((p) => {
      const item = items.get(p.itemId);
      return item ? placedBox(p, item, ctx.k) : null;
    })
    .filter((b): b is ReturnType<typeof placedBox> => b !== null);
  let covered = 0;
  const total = COVERAGE_GRID * COVERAGE_GRID;
  for (let gy = 0; gy < COVERAGE_GRID; gy++) {
    const y = ((gy + 0.5) / COVERAGE_GRID) * ctx.card.h;
    for (let gx = 0; gx < COVERAGE_GRID; gx++) {
      const x = ((gx + 0.5) / COVERAGE_GRID) * ctx.card.w;
      for (const b of boxes) {
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) {
          covered++;
          break;
        }
      }
    }
  }
  const cov = covered / total;
  if (cov < 0.25) return (0.25 - cov) / 0.25;
  if (cov > 0.6) return Math.min(1, (cov - 0.6) / 0.4);
  return 0;
}

/**
 * Spearman-style rank correlation between visualWeight and display size
 * (display width at the placement's scale). Penalty = (1 − corr)/2.
 * Ranks break ties by orderIndex for full determinism.
 */
export function hierarchyTerm(
  placements: Placement[],
  items: Map<string, LayoutItem>,
  ctx: ScoreContext,
): number {
  if (placements.length < 2) return 0;
  const rows = placements
    .map((p) => {
      const item = items.get(p.itemId);
      if (!item) return null;
      return {
        weight: item.visualWeight,
        size: item.imgW * p.scale,
        order: item.orderIndex,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const n = rows.length;
  if (n < 2) return 0;
  const rankBy = (
    key: (r: (typeof rows)[number]) => number,
  ): number[] => {
    const idx = rows.map((_, i) => i);
    idx.sort((ia, ib) => {
      const d = key(rows[ia]!) - key(rows[ib]!);
      return d !== 0 ? d : rows[ia]!.order - rows[ib]!.order;
    });
    const ranks = new Array<number>(n);
    idx.forEach((rowIdx, rank) => {
      ranks[rowIdx] = rank;
    });
    return ranks;
  };
  const rw = rankBy((r) => r.weight);
  const rs = rankBy((r) => r.size);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rw[i]! - rs[i]!) ** 2;
  const corr = 1 - (6 * d2) / (n * (n * n - 1));
  return (1 - corr) / 2;
}

/** Fraction of items whose AABB sits within 1% of the safe-margin line. */
export function edgeTerm(
  placements: Placement[],
  items: Map<string, LayoutItem>,
  ctx: ScoreContext,
): number {
  if (placements.length === 0) return 0;
  const m = safeMargin(ctx.card);
  const tolX = 0.01 * ctx.card.w;
  const tolY = 0.01 * ctx.card.h;
  let hugging = 0;
  let n = 0;
  for (const p of placements) {
    const item = items.get(p.itemId);
    if (!item) continue;
    const b = placedBox(p, item, ctx.k);
    const near =
      b.x1 - m.x < tolX ||
      ctx.card.w - m.x - b.x2 < tolX ||
      b.y1 - m.y < tolY ||
      ctx.card.h - m.y - b.y2 < tolY;
    if (near) hugging++;
    n++;
  }
  return n === 0 ? 0 : hugging / n;
}

/** Population std of rotations above 12° (skipped for clustered hints). */
export function rotationTerm(
  placements: Placement[],
  ctx: ScoreContext,
): number {
  if (ctx.clustered || placements.length < 2) return 0;
  const mean =
    placements.reduce((s, p) => s + p.rotation, 0) / placements.length;
  const variance =
    placements.reduce((s, p) => s + (p.rotation - mean) ** 2, 0) /
    placements.length;
  const std = Math.sqrt(variance);
  return std <= 12 ? 0 : Math.min(1, (std - 12) / 30);
}

// ---------------------------------------------------------------------------
// Combined score
// ---------------------------------------------------------------------------

/**
 * Score a full layout. Lower is better; 0 = ideal, 1 = worst on every term.
 * Deterministic — see the module doc comment for term definitions.
 */
export function scoreLayout(
  placements: Placement[],
  items: LayoutItem[],
  ctx: ScoreContext,
): number {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const terms = {
    focal: focalTerm(placements, byId, ctx),
    spacing: spacingTerm(placements, byId, ctx),
    coverage: coverageTerm(placements, byId, ctx),
    hierarchy: hierarchyTerm(placements, byId, ctx),
    edge: edgeTerm(placements, byId, ctx),
    rotation: rotationTerm(placements, ctx),
  };
  let score = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof typeof SCORE_WEIGHTS>) {
    score += SCORE_WEIGHTS[key] * terms[key];
  }
  return score;
}
