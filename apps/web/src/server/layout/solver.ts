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
import { MIN_ITEM_SIZE_PCT } from "@cardcrafters/shared";

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

  /** Valid candidate placements for one item vs the current placed set. */
  const candidatesFor = (item: LayoutItem, index: number, placed: Placed[]): Placement[] => {
    const group = grouped.get(item.id);
    const baseScale = scaleFor(item, card, k, undefined, minSizePct);
    const placedBoxes = placed.map((p) => ({ itemId: p.item.id, box: placedBox(p.placement, p.item, k) }));
    const cands: Placement[] = [];
    const push = (x: number, y: number, scale: number, rotation: number): void => {
      cands.push({
        itemId: item.id,
        x,
        y,
        scale: scaleFor(item, card, k, scale, minSizePct),
        rotation: Math.round(rotation * 100) / 100,
        zIndex: item.orderIndex,
      });
    };

    // Grid positions (6×6) with seeded jitter, each with its own scale/rotation.
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const jx = (rng() - 0.5) * 2 * JITTER_FRAC * cellX;
        const jy = (rng() - 0.5) * 2 * JITTER_FRAC * cellY;
        const x = clamp(ax1 + gx * cellX + jx, ax1, ax2);
        const y = clamp(ay1 + gy * cellY + jy, ay1, ay2);
        const scale = baseScale * (0.9 + rng() * 0.2);
        // Focal (top-weight) item stays unrotated unless hints suggest otherwise.
        const rotation = index === 0 && !hints ? 0 : (rng() * 2 - 1) * 12;
        push(x, y, scale, rotation);
      }
    }

    // Hint-guided samples near the item's group center.
    if (group) {
      for (let s = 0; s < HINT_SAMPLES; s++) {
        const x = clamp(group.cx + (rng() * 2 - 1) * group.spread, ax1, ax2);
        const y = clamp(group.cy + (rng() * 2 - 1) * group.spread, ay1, ay2);
        push(x, y, baseScale * (0.9 + rng() * 0.2), (rng() * 2 - 1) * 12);
      }
    }

    // Hard-constraint filter (bounds + size + text rule + pairwise overlap).
    return cands.filter(
      (c) =>
        checkItem(
          c,
          item,
          { ...ctx, checkTextOverlap: textRuleApplies(item) },
          placedBoxes,
        ).length === 0,
    );
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
  const iterations = opts.iterations ?? 60;
  for (let it = 0; it < iterations && placed.length > 0; it++) {
    const idx = Math.floor(rng() * placed.length) % placed.length;
    const p = placed[idx]!;
    const others = placed.filter((_, i) => i !== idx);
    const item = p.item;
    const moved: Placement = {
      ...p.placement,
      x: p.placement.x + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.w,
      y: p.placement.y + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.h,
      scale: scaleFor(
        item,
        card,
        k,
        p.placement.scale * (1 + (rng() * 2 - 1) * SCALE_NUDGE_FRAC),
        minSizePct,
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
