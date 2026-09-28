/**
 * Layout solver (build-phase step 3) — PURE and deterministic given a seeded
 * RNG. Turns READY items into placements satisfying the constraints in
 * constraints.ts, scored by score.ts.
 *
 * Algorithm (see the build-phase plan):
 *   1. Order items by visualWeight desc (stable tie-break by orderIndex) so
 *      heavy stickers claim the best spots first.
 *   2. Candidate generation per item: a 6×6 grid over the allowed area
 *      (card minus safe margin) with seeded jitter +, when `hints` name a
 *      group for the item, extra samples around that group's center. Each
 *      candidate gets a seeded scale (clamped by scaleFor) and rotation
 *      (±12°; the top-weight item stays at 0° unless hints exist).
 *   3. Greedy placement: pick the candidate minimizing the incremental
 *      scoreLayout (scored against the already-placed set only). Items with
 *      no valid candidate are retried after the pass; leftovers trigger
 *      relaxation.
 *   4. Local search: `iterations` (default 60) seeded nudges (position ±3% of
 *      the card dimension, scale ±10%, rotation ±5°), accepted only when the
 *      constraints still hold and the incremental score improves.
 *   5. Relaxation: if not everything fits, retry the whole solve with minSize
 *      relaxed by −1% steps (floor 3%, max 5 relaxations); as a last resort
 *      the text-overlap rule is dropped for items beyond the first 20 (with a
 *      warning). Out-of-bounds placements are NEVER emitted: bounds and
 *      minSize are hard constraints — an item that still cannot fit is simply
 *      omitted from the result (also warned).
 *
 * zIndex = the item's orderIndex (later submissions render on top).
 */

import type { LayoutComposition, Placement } from "@cardcrafters/shared";
import { MIN_ITEM_SIZE_PCT, SOLO_ITEM_COVERAGE, TOTAL_COVERAGE_TARGET } from "@cardcrafters/shared";

import {
  baseFit,
  checkItem,
  placedBox,
  scaleFor,
  safeMargin,
  textOverlapOk,
  type CardBox,
  type ConstraintCtx,
  type LayoutItem,
  type Rect,
} from "./constraints";
import { scoreLayout, type ScoreContext } from "./score";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, fast, deterministic 32-bit PRNG (public domain). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash — derives stable seeds from strings (teamId+round). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Options + result
// ---------------------------------------------------------------------------

export interface SolveOptions {
  /** Card box in normalized units (cardBox output). */
  cardDims: CardBox;
  /** k sizing factor; defaults to baseFit(cardDims). */
  k?: number;
  /** Reserved greeting-text zone (normalized rect, may be null). */
  textZone: Rect | null;
  /** Seeded RNG; default mulberry32(0). Engine seeds with teamId+round. */
  rng?: () => number;
  /** LLM layout_composition output (optional). */
  hints?: LayoutComposition | null;
  /** Local-search iterations (default 60). */
  iterations?: number;
}

export interface SolveResult {
  placements: Placement[];
  /** True when every emitted placement respects the (inflated) text zone. */
  textZoneUsed: boolean;
  /** Min size % actually used (≤ MIN_ITEM_SIZE_PCT after relaxation). */
  relaxedMinSize: number;
  /** Non-fatal notes: relaxation, dropped text rule, unplaceable items. */
  warnings: string[];
  /** Final scoreLayout score of the result (engine-side comparison). */
  score: number;
}

/** Local-search nudge magnitudes. */
const POS_NUDGE_FRAC = 0.03; // of the card dimension, per axis
const SCALE_NUDGE_FRAC = 0.1;
const ROT_NUDGE_DEG = 5;
/** Candidate generation. */
const GRID = 6;
const JITTER_FRAC = 0.45; // of one grid cell, per axis
const HINT_SAMPLES = 6; // extra candidates near the hinted group center
/** Relaxation bounds. */
const MIN_SIZE_FLOOR_PCT = 3;
const MAX_RELAXATIONS = 5;
/** Beyond this many items the text rule may be dropped (last resort). */
const TEXT_RULE_DROP_LIMIT = 20;
/**
 * Sizing policy (coverage-proportional targets):
 *
 * The TOTAL displayed item area should target a fixed fraction of the card
 * area, split across items. With one item the target is SOLO_ITEM_COVERAGE
 * ("as big as possible"); with several it is TOTAL_COVERAGE_TARGET. Between
 * 1 and 3 items the two targets are linearly blended so the total area does
 * not jump when the second item arrives:
 *
 *   totalCoverage(n) = lerp(SOLO, TOTAL, clamp(n − 1, 0, 1))
 *
 * (Deviation from the original (n−1)/2 blend: two items physically cannot
 * fill more than ~55–60% of this portrait card each once the text zone,
 * safe margins and the 25% pairwise-overlap cap are respected, so a slower
 * blend would make the 2-item target infeasible and the fallback scale
 * steps would place n=2 items SMALLER than n=3 ones. Reaching the multi-item
 * target at n=2 keeps average display size monotonically decreasing.)
 * Each item's share of that total is proportional to its visualWeight
 * (heavier → larger), with equal shares as the fallback when weights are
 * missing/near-zero. Share → desired display area → desired display width
 * window. The candidate generator seeds its ±10% scale jitter around this
 * desired scale instead of the geometric window middle, and the size-window
 * clamp plus the hard in-bounds/overlap constraints remain the safety net:
 * when the desired scale cannot fit, the largest in-bounds candidate wins.
 *
 * n = 1 → 0.65 → w ≈ 0.95×card.w raw, clamped to the 85% MAX window → the
 * solo item fills the card. For n ≥ 2 the total is additionally capped at
 * MAX_ITEM_AREA_SHARE × n (see MAX_ITEM_AREA_SHARE below).
 */
const WEIGHT_FLOOR = 0.05; // keeps zero-weight items from getting a zero share
/**
 * Per-item cap on the desired AREA as a fraction of the card area (applies
 * when n ≥ 2; the solo target of 65% is intentionally larger). Geometry-
 * driven: on the default 5:7 card with the greeting zone reserving the top
 * ~20%, two near-square stickers can each fill at most ~22% of the card
 * before the 25% pairwise-overlap cap forces the solver to shrink one of
 * them below the intended target anyway (a ~25%-area square simply cannot
 * coexist with another one under the text zone). Capping the DESIRED area
 * keeps the 2-item target feasible so the fallback steps never have to kick
 * in and average display size stays monotonically decreasing in n.
 */
const MAX_ITEM_AREA_SHARE = 0.22;

/** Blended total-coverage target for n items (see the sizing-policy doc). */
export function totalCoverageTarget(n: number): number {
  const t = Math.min(1, Math.max(0, n - 1));
  return SOLO_ITEM_COVERAGE + (TOTAL_COVERAGE_TARGET - SOLO_ITEM_COVERAGE) * t;
}

/**
 * Desired display scale per item under the coverage-proportional policy.
 * Returns itemId → scale (already clamped to the size window).
 */
function desiredScales(
  ordered: LayoutItem[],
  card: CardBox,
  k: number,
  minSizePct: number,
): Map<string, number> {
  const n = ordered.length;
  // The per-item area cap only applies when several items share the card —
  // the solo target (SOLO_ITEM_COVERAGE) is intentionally larger so the one
  // item fills the card. (Applying the cap at n = 1 would shrink the desired
  // solo area to MAX_ITEM_AREA_SHARE and the solo item would land at ~55%
  // width instead of filling the card.)
  const totalTargetArea =
    n === 1
      ? SOLO_ITEM_COVERAGE * card.w * card.h
      : Math.min(totalCoverageTarget(n), MAX_ITEM_AREA_SHARE * n) *
        card.w *
        card.h;
  const eff = ordered.map((i) => Math.max(i.visualWeight, WEIGHT_FLOOR));
  const sum = eff.reduce((s, w) => s + w, 0);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const item = ordered[i]!;
    const share = eff[i]! / sum;
    const desiredArea = totalTargetArea * share;
    // Display area = w × h = w² × (imgH/imgW)  →  w = sqrt(area × imgW/imgH).
    const desiredWidth = Math.sqrt((desiredArea * item.imgW) / item.imgH);
    const scale = desiredWidth / (item.imgW * k);
    map.set(item.id, scaleFor(item, card, k, scale, minSizePct));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

interface Placed {
  item: LayoutItem;
  placement: Placement;
}

/**
 * One solve attempt at a given minSize / text-rule policy. Items that cannot
 * satisfy the hard constraints are returned in `unplaced` (never placed
 * illegally).
 */
function attemptSolve(
  items: LayoutItem[],
  opts: SolveOptions,
  minSizePct: number,
  dropTextBeyond: number | null,
): { placed: Placed[]; unplaced: LayoutItem[]; textZoneUsed: boolean } {
  const card = opts.cardDims;
  const k = opts.k ?? baseFit(card);
  const rng = opts.rng ?? mulberry32(0);
  const hints = opts.hints ?? null;
  const clustered = hints ? hints.groups.length > 1 : false;
  const focalPoint = hints?.focalPoint ?? null;

  // Hint lookup: itemId → group center/spread.
  const grouped = new Map<string, { cx: number; cy: number; spread: number }>();
  for (const g of hints?.groups ?? []) {
    for (const id of g.itemIds) grouped.set(id, { cx: g.cx, cy: g.cy, spread: g.spread });
  }

  // Sort: visualWeight desc, stable tie-break by orderIndex.
  const ordered = [...items].sort(
    (a, b) => b.visualWeight - a.visualWeight || a.orderIndex - b.orderIndex,
  );

  const ctx: ConstraintCtx = { card, k, textZone: opts.textZone, minSizePct };
  const m = safeMargin(card);
  const ax1 = m.x;
  const ax2 = card.w - m.x;
  const ay1 = m.y;
  const ay2 = card.h - m.y;
  const cellX = (ax2 - ax1) / (GRID - 1);
  const cellY = (ay2 - ay1) / (GRID - 1);
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v));
  const textRuleApplies = (item: LayoutItem): boolean =>
    dropTextBeyond === null || ordered.indexOf(item) < dropTextBeyond;

  // Coverage-proportional desired scale per item (sizing policy — see the
  // block comment above). Seeds the candidate scale jitter.
  const desired = desiredScales(ordered, card, k, minSizePct);

  /** Valid candidate placements for one item vs the current placed set.
   *
   * Scale fallback is PER CANDIDATE CELL, not global: every grid cell (and
   * hint sample) first tries the item's DESIRED (coverage-proportional)
   * scale and only falls back to progressively smaller scales when the hard
   * constraints reject the larger ones IN THAT CELL. The greedy pass therefore
   * always sees each cell at its largest feasible scale — a crowded card
   * shrinks individual cells instead of shrinking the whole candidate set
   * globally (which used to let the edge/coverage score terms pull items
   * below their desired size even when the desired scale fit somewhere).
   *
   * Determinism: all seeded RNG draws (jitter, scale jitter, rotation) are
   * hoisted up front in a fixed order (grid cells, then hint samples), so
   * the draw sequence never depends on which scale step happens to succeed.
   */
  const SCALE_FALLBACK_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  const candidatesFor = (item: LayoutItem, index: number, placed: Placed[]): Placement[] => {
    const group = grouped.get(item.id);
    const baseScale =
      desired.get(item.id) ?? scaleFor(item, card, k, undefined, minSizePct);
    const placedBoxes = placed.map((p) => ({ itemId: p.item.id, box: placedBox(p.placement, p.item, k) }));
    const ok = (c: Placement): boolean =>
      checkItem(
        c,
        item,
        { ...ctx, checkTextOverlap: textRuleApplies(item) },
        placedBoxes,
      ).length === 0;

    // Clamp a candidate's center so THIS item's rotated AABB (at the given
    // scale/rotation) stays inside the safe area — big items get their
    // centers confined near the card middle, small ones keep the full grid.
    const makeCand = (x: number, y: number, scale: number, rotation: number): Placement => {
      const s = scaleFor(item, card, k, scale, minSizePct);
      const box = placedBox({ x: 0, y: 0, scale: s, rotation }, item, k);
      const hx = -box.x1;
      const hy = -box.y1;
      return {
        itemId: item.id,
        x: clamp(x, ax1 + hx, ax2 - hx),
        y: clamp(y, ay1 + hy, ay2 - hy),
        scale: s,
        rotation: Math.round(rotation * 100) / 100,
        zIndex: item.orderIndex,
      };
    };

    // Hoist ALL seeded RNG draws up front (fixed order → deterministic):
    // one position/jitter/scale-jitter/rotation draw set per grid cell and
    // per hint sample, before any constraint checking happens.
    const seeds: Array<{ x: number; y: number; jitter: number; rot: number }> = [];
    // Grid positions (6×6) with seeded jitter.
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const jx = (rng() - 0.5) * 2 * JITTER_FRAC * cellX;
        const jy = (rng() - 0.5) * 2 * JITTER_FRAC * cellY;
        const x = clamp(ax1 + gx * cellX + jx, ax1, ax2);
        const y = clamp(ay1 + gy * cellY + jy, ay1, ay2);
        const jitter = 0.9 + rng() * 0.2;
        // Focal (top-weight) item stays unrotated unless hints suggest otherwise.
        const rot = index === 0 && !hints ? 0 : (rng() * 2 - 1) * 12;
        seeds.push({ x, y, jitter, rot });
      }
    }
    // Hint-guided samples near the item's group center.
    if (group) {
      for (let s = 0; s < HINT_SAMPLES; s++) {
        const x = clamp(group.cx + (rng() * 2 - 1) * group.spread, ax1, ax2);
        const y = clamp(group.cy + (rng() * 2 - 1) * group.spread, ay1, ay2);
        const jitter = 0.9 + rng() * 0.2;
        const rot = (rng() * 2 - 1) * 12;
        seeds.push({ x, y, jitter, rot });
      }
    }

    // Per cell: try scale fallback steps largest→smallest inside the cell;
    // the first (largest) scale whose candidate passes the hard constraints
    // (bounds + size + text rule + pairwise overlap) wins that cell.
    const cands: Placement[] = [];
    for (const seed of seeds) {
      for (const step of SCALE_FALLBACK_STEPS) {
        const cand = makeCand(
          seed.x,
          seed.y,
          baseScale * step * seed.jitter,
          seed.rot * step,
        );
        if (ok(cand)) {
          cands.push(cand);
          break;
        }
      }
    }
    return cands;
  };

  /** Incremental score of `cand` + `item` against the already-placed set. */
  const incremental = (cand: Placement, item: LayoutItem, placed: Placed[]): number => {
    const placements = [cand, ...placed.map((p) => p.placement)];
    const ids = new Set(placements.map((p) => p.itemId));
    const subset = items.filter((i) => ids.has(i.id));
    const sctx: ScoreContext = { card, k, focalPoint, clustered };
    return scoreLayout(placements, subset, sctx);
  };

  const placed: Placed[] = [];
  let unplaced = [...ordered];

  // Greedy passes with retries until no progress.
  let progress = true;
  while (progress && unplaced.length > 0) {
    progress = false;
    const stillUnplaced: LayoutItem[] = [];
    for (const item of unplaced) {
      const index = ordered.indexOf(item);
      const cands = candidatesFor(item, index, placed);
      if (cands.length === 0) {
        stillUnplaced.push(item);
        continue;
      }
      let best = cands[0]!;
      let bestScore = incremental(best, item, placed);
      for (let i = 1; i < cands.length; i++) {
        const s = incremental(cands[i]!, item, placed);
        if (s < bestScore) {
          best = cands[i]!;
          bestScore = s;
        }
      }
      placed.push({ item, placement: best });
      progress = true;
    }
    unplaced = stillUnplaced;
  }

  // Local search: seeded nudges, accepted only when they improve the score.
  // Scale floor: the sizing policy only ever shrinks an item below its
  // DESIRED (coverage-proportional) scale when the hard constraints force it
  // (the per-cell fallback steps in candidatesFor). The local search must not
  // re-shrink items below that line just to game the soft score terms (the
  // focal term would otherwise trade solo-item size for a nudge toward the
  // card center). Floor = min(current, desired): an item already placed at a
  // fallback scale keeps its current scale as the floor.
  const iterations = opts.iterations ?? 60;
  for (let it = 0; it < iterations && placed.length > 0; it++) {
    const idx = Math.floor(rng() * placed.length) % placed.length;
    const p = placed[idx]!;
    const others = placed.filter((_, i) => i !== idx);
    const item = p.item;
    const desiredScale = desired.get(item.id);
    const scaleFloor =
      desiredScale !== undefined
        ? Math.min(p.placement.scale, desiredScale)
        : 0;
    const moved: Placement = {
      ...p.placement,
      x: p.placement.x + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.w,
      y: p.placement.y + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.h,
      scale: Math.max(
        scaleFloor,
        scaleFor(
          item,
          card,
          k,
          p.placement.scale * (1 + (rng() * 2 - 1) * SCALE_NUDGE_FRAC),
          minSizePct,
        ),
      ),
      rotation: p.placement.rotation + (rng() * 2 - 1) * ROT_NUDGE_DEG,
    };
    const placedBoxes = others.map((o) => ({
      itemId: o.item.id,
      box: placedBox(o.placement, o.item, k),
    }));
    const ok =
      checkItem(
        moved,
        item,
        { ...ctx, checkTextOverlap: textRuleApplies(item) },
        placedBoxes,
      ).length === 0;
    if (!ok) continue;
    if (incremental(moved, item, others) < incremental(p.placement, item, others)) {
      placed[idx] = { item, placement: moved };
    }
  }

  // textZoneUsed: the zone existed AND every emitted placement respects it.
  const textZoneUsed =
    opts.textZone !== null &&
    placed.every(
      (p) =>
        textRuleApplies(p.item) &&
        textOverlapOk(placedBox(p.placement, p.item, k), opts.textZone, card),
    );

  return { placed, unplaced, textZoneUsed };
}

/** Full deterministic solve with progressive relaxation. */
export function solveLayout(items: LayoutItem[], opts: SolveOptions): SolveResult {
  const warnings: string[] = [];
  if (items.length === 0) {
    return {
      placements: [],
      textZoneUsed: opts.textZone !== null,
      relaxedMinSize: MIN_ITEM_SIZE_PCT,
      warnings,
      score: 0,
    };
  }

  let minSizePct = MIN_ITEM_SIZE_PCT;
  let result = attemptSolve(items, opts, minSizePct, null);
  let relaxations = 0;
  while (result.unplaced.length > 0 && relaxations < MAX_RELAXATIONS) {
    relaxations++;
    minSizePct = Math.max(MIN_SIZE_FLOOR_PCT, minSizePct - 1);
    result = attemptSolve(items, opts, minSizePct, null);
  }
  if (relaxations > 0 && minSizePct < MIN_ITEM_SIZE_PCT) {
    warnings.push(`relaxed min item size to ${minSizePct}% of card width`);
  }

  // Last resort: drop the text-overlap rule for items beyond the first 20.
  if (result.unplaced.length > 0 && items.length > TEXT_RULE_DROP_LIMIT) {
    warnings.push(
      `text-overlap rule dropped for items beyond the first ${TEXT_RULE_DROP_LIMIT}`,
    );
    result = attemptSolve(items, opts, minSizePct, TEXT_RULE_DROP_LIMIT);
  }

  // Items that STILL cannot fit are omitted (bounds + minSize are hard).
  for (const item of result.unplaced) {
    warnings.push(`item ${item.id} could not be placed within card constraints`);
  }

  const card = opts.cardDims;
  const k = opts.k ?? baseFit(card);
  const placements = result.placed
    .map((p) => ({ ...p.placement, zIndex: p.item.orderIndex }))
    .sort((a, b) => a.zIndex - b.zIndex);
  const ctx: ScoreContext = {
    card,
    k,
    focalPoint: opts.hints?.focalPoint ?? null,
    clustered: opts.hints ? opts.hints.groups.length > 1 : false,
  };
  return {
    placements,
    textZoneUsed: result.textZoneUsed && result.unplaced.length === 0,
    relaxedMinSize: minSizePct,
    warnings,
    score: scoreLayout(placements, items, ctx),
  };
}
