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
 *      group for the item, extra samples around that group's center + 12
 *      polar ring samples around the composition focus (golden-angle
 *      stepping, radii 15–50% of the card's min dimension) so diagonal /
 *      organic arrangements are reachable, not just axis-aligned grid
 *      neighbors. Each candidate gets a seeded scale (clamped by scaleFor)
 *      and rotation (±12° grid / ±15° ring; the top-weight item stays at
 *      0° unless hints exist).
 *   3. Greedy placement: pick the candidate minimizing the incremental
 *      scoreLayout PLUS a solver-internal scale-fidelity term (see
 *      `fidelity` below — the soft score alone does not reward size, so
 *      without it items drift below their desired scale). Items with
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
import {
  MIN_ITEM_SIZE_PCT,
  SOLO_ITEM_COVERAGE,
  TOTAL_COVERAGE_TARGET,
} from "@cardcrafters/shared";

import {
  baseFit,
  checkItem,
  displayWidth,
  overlapCapFor,
  placedBox,
  placedFootprint,
  scaleFor,
  safeMargin,
  textOverlapOk,
  type CardBox,
  type ConstraintCtx,
  type LayoutItem,
  type PlacedFootprint,
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
  /**
   * Pairwise-overlap cap (0–1). Defaults to overlapCapFor(items.length) =
   * MAX_PAIRWISE_OVERLAP (the single 10% user tolerance for EVERY item count;
   * the former relaxed small-n cap is retired — see shared constants). Tests
   * inject a fixed value to pin the policy under measurement.
   */
  overlapCap?: number;
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
/**
 * Weight of the solver-internal scale-fidelity term added to the incremental
 * score (see `fidelity` in attemptSolve). Tuned so reaching the desired scale
 * outweighs focal/edge positioning preferences between feasible candidates,
 * while hard-constraint trimming still dominates (infeasible scales are never
 * candidates in the first place).
 */
const SCALE_FIDELITY_WEIGHT = 0.5;
/**
 * Coordinate-descent sweeps after the greedy pass (see the sweep block in
 * attemptSolve). 3 sweeps cover the few-item cases the sweeps exist for;
 * the loop also breaks early when a sweep changes nothing.
 */
const COORD_SWEEPS = 3;
/** Candidate generation. */
const GRID = 6;
/**
 * Per-candidate SCALE jitter around the desired (coverage-policy) scale —
 * reduced from ±20% (0.9 + rng·0.2) to ±8% in the sizing-accuracy pass:
 * wide jitter blurred the equalization blend (a same-weight sibling could
 * draw a ±20% different multiplier and land at ratio > 1.3 even with
 * identical desired scales — the "sizes not equal or similar" complaint).
 * ±8% keeps organic variety without breaking size similarity.
 */
const SCALE_JITTER_MIN = 0.92;
const SCALE_JITTER_MAX = 1.08;
const JITTER_FRAC = 0.45; // of one grid cell, per axis
const HINT_SAMPLES = 6; // extra candidates near the hinted group center
/**
 * Polar ring candidates (placement freedom / organic layouts): in addition
 * to the axis-aligned grid, each item also samples RING_SAMPLES positions
 * on a ring AROUND THE COMPOSITION FOCUS (hint focal point, else card
 * center). Angles step by the golden angle (137.5° — consecutive samples
 * spread evenly around the circle) with seeded jitter; radii sweep
 * [RING_RADIUS_MIN, RING_RADIUS_MAX] × the card's min dimension. Without
 * these, two large items can only land on grid lines, i.e. axis-aligned
 * left/right or top/bottom of each other; the rings let the scorer pick
 * diagonal / staggered arrangements.
 */
const RING_SAMPLES = 12;
const GOLDEN_ANGLE_DEG = 137.5;
const RING_ANGLE_JITTER_DEG = GOLDEN_ANGLE_DEG / 2;
const RING_RADIUS_MIN = 0.15;
const RING_RADIUS_MAX = 0.5;
const RING_ROT_JITTER_DEG = 15;
/** Relaxation bounds. */
const MIN_SIZE_FLOOR_PCT = 3;
const MAX_RELAXATIONS = 5;
/** Beyond this many items the text rule may be dropped (last resort). */
const TEXT_RULE_DROP_LIMIT = 20;
// ---------------------------------------------------------------------------
// Balanced-pair refinement (sizing-accuracy pass) — few-item layouts only.
// ---------------------------------------------------------------------------
/** The refinement runs for layouts with at most this many items. */
const REBALANCE_MAX_ITEMS = 5;
/** Refinement rounds (each fixes the single widest/narrowest pair). */
const REBALANCE_ROUNDS = 6;
/**
 * Target width ratio between the widest and narrowest sticker (few-item
 * layouts). Mirrors the equalization blend's intent: similar stickers should
 * LOOK similar in size even when packing forces one of them below its
 * desired scale (first-mover advantage — see the refinement doc in
 * attemptSolve).
 */
const REBALANCE_RATIO = 1.15;
/**
 * Concession ladder for the widest item (fractions of its current scale).
 * Each rung shrinks the widest item, re-places BOTH the wide item and the
 * narrowest item in the freed room, and the compound move is committed only
 * when the global objective (scoreLayout + fidelity) improves.
 */
const REBALANCE_LADDER = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
/** How many of the re-ranked wide-item candidates get expanded per rung. */
const REBALANCE_WIDE_EXPAND = 6;
/**
 * Sizing policy v2 (few items FILL the card — coverage-proportional targets):
 *
 * Each item's DESIRED area is perItemShare(n) × card area, split by
 * visualWeight (heavier → larger; equal shares as the fallback when weights
 * are missing/near-zero). The per-item share curve is:
 *
 *   perItemShare(n) =
 *     n = 1         → SOLO_ITEM_COVERAGE (0.65 — "as big as possible")
 *     2 ≤ n ≤ 5     → FILL_COVERAGE / n   (n=2 → 0.30, n=3 → 0.20, n=5 → 0.12)
 *     5 < n < 12    → lerp(FILL_COVERAGE/n, TOTAL_COVERAGE_TARGET/n, t),
 *                     t = (n − 5) / 7
 *     n ≥ 12        → TOTAL_COVERAGE_TARGET / n (the legacy total-coverage
 *                     split; large-n behavior unchanged)
 *
 * Rationale (v2): the previous policy capped every n ≥ 2 item at 22% card
 * area, so the SECOND sticker arrived visibly small (~55% width) while the
 * card still had room. v2 keeps per-item share HIGH for small n so few
 * stickers together fill the card: two stickers chase 0.35 card area each
 * (≈ 65–70% display width on the default 5:7 card — see the feasibility
 * note below), the curve converges back to the legacy
 * TOTAL_COVERAGE_TARGET/n split by n = 12, so large-n behavior (including
 * the 25-item stress case) is unchanged.
 *
 * Feasibility (measured, see the sizing-policy tests): the brief's initial
 * n = 2 target of 0.45 area share per item (and even 0.40) is INFEASIBLE on
 * the default 5:7 card — two squares at 0.40 share (75% width) cannot
 * coexist under the greeting-text zone, the 4% safe margin and the pairwise
 * overlap cap; at the general 25% cap the largest jointly-feasible pair of
 * squares measures ≈ 0.30 area share ≈ 64–65% width (staggered diagonally,
 * SIZING-ACCURACY PASS (true rotated-rect overlap + 10% tolerance +
 * equalization): the pairwise overlap is now measured on the actual rotated
 * rectangles (SAT-exact intersection area, see rotatedRectOverlapArea) with
 * a SINGLE user-set tolerance of 10% for every item count — the previous
 * AABB measure + relaxed 0.35 small-n cap rejected feasible big placements
 * (bounding boxes of rotated stickers overlap far more than the stickers
 * themselves) and still produced visible overlap. Freeing that phantom
 * overlap lets FILL_COVERAGE rise to 0.7 while both stickers keep growing
 * (measured: n = 2 avg width 0.546 → 0.67, smallest item 0.44 → 0.58 across
 * 5 seeds; true overlap stays ≤ 0.10 per pair by construction).
 *
 * SIZE EQUALIZATION: the per-item share is blended 50/50 between the
 * visualWeight-weighted split and a flat equal split ( EQUALIZE_FRAC = 0.5,
 * weight floor unchanged). Rationale: the user reported sizes "not equal or
 * similar" — with the pure weight split, two same-weight items could still
 * land at ratio > 1.3 (the greedy first-mover takes the bigger feasible
 * spot); the blend keeps heavy items modestly larger (hierarchy term) while
 * pinning similar-weight items within ~1.25× of each other.
 *
 * (Superseded feasibility note kept for the record: under the OLD AABB
 * overlap measure, raising FILL_COVERAGE past 0.6 made n = 2 WORSE — the
 * sequential greedy let the first sticker consume the extra wish while the
 * second starved. With the true measure the starvation mechanism is gone,
 * so the higher share translates into size for BOTH stickers.)
 *
 * Share → desired display area → desired display width window. The
 * candidate generator seeds its ±10% scale jitter around this desired
 * scale instead of the geometric window middle, and the size-window clamp
 * plus the hard in-bounds/overlap constraints remain the safety net: when
 * the desired scale cannot fit, the largest in-bounds candidate wins.
 *
 * n = 1 → 0.65 → w ≈ 0.95×card.w raw, clamped to the 85% MAX window → the
 * solo item fills the card.
 */
const WEIGHT_FLOOR = 0.05; // keeps zero-weight items from getting a zero share
/**
 * Total card-area fraction the items chase while the card still looks
 * "full" (2 ≤ n ≤ 5): perItemShare = FILL_COVERAGE / n. Raised from 0.6 to
 * 0.7 in the sizing-accuracy pass: the SAT fix freed the phantom AABB
 * overlap budget, so larger jointly-feasible targets actually convert into
 * size now (n = 2 → 0.35, n = 3 → 0.233, n = 5 → 0.14). Measured jointly
 * feasible on the default 5:7 card at the 10% true-overlap tolerance (see
 * the measured-curve block above and the solver tests).
 */
const FILL_COVERAGE = 0.7;
/**
 * Size-equalization blend (0..1): the fraction of the per-item share that
 * comes from the FLAT equal split rather than the visualWeight-weighted
 * split (see the equalization note above; 0 = old pure weight split). 0.5
 * keeps a visible size hierarchy for very different weights while similar
 * weights land within ~1.25× of each other (tested).
 */
const EQUALIZE_FRAC = 0.5;
/**
 * Per-item DISPLAY-WIDTH targets (fraction of card width) for few-item
 * layouts (2 ≤ n ≤ 5) — the few-item sizing policy of the sizing-accuracy
 * pass. Width, not area, because the user-visible complaint is width
 * ("stickers do not maximize the card space", "sizes not equal or similar")
 * and because an AREA share translates into aspect-dependent widths (a
 * landscape sticker's share-faithful width is 1.3× a portrait's at the same
 * share — the direct cause of unequal siblings; see the measured-ceilings
 * block above).
 *
 * Values are tuned just under the measured jointly-feasible ceilings at the
 * 10% true-overlap tolerance (binary-search probe over exact SAT overlap on
 * the default card: two squares ≈ 0.55–0.58 width, portrait-mix pair ≈ 0.50,
 * three mixed items ≈ 0.48, five ≈ 0.41; landscape pairs reach ≈ 0.72):
 *   n=2 → 0.56, n=3 → 0.48, n=4 → 0.42, n=5 → 0.38.
 * (The brief's aspirational "n=2 both ≥ 0.60" is geometrically unreachable
 * for SQUARE stickers on the 5:7 card under the fixed greeting zone + 4%
 * margins + honest 10% overlap — documented; landscape pairs DO exceed 0.60.)
 * The n = 2 target sits AT the measured axis-aligned ceiling (≈ 0.58): the
 * solver's fidelity term + refinement converge to the largest jointly
 * feasible pair, so a target at the ceiling drives both stickers to ≥ 0.55
 * without overshooting into infeasibility (final-pass measurement, seeds
 * 1–5, two equal 256×256 squares: both ≥ 0.55 on every seed, worst-pair SAT
 * overlap ≤ 0.10).
 * The visualWeight blend (EQUALIZE_FRAC) and the size-window clamp still
 * modulate the target; the per-candidate scale fallback + fidelity term
 * remain the feasibility mechanism. n = 1 keeps the solo area target and
 * n ≥ 6 keeps the area-share curve (perItemShare) — legacy behavior.
 */
const PER_ITEM_WIDTH_TARGET: Record<number, number> = {
  // n=2 must sit BELOW the geometric ceiling (~0.576 for equal squares under
  // the 10% overlap cap on the 5:7 card: (2w−657)(2w−720) ≤ 0.1w² ⇒ w ≤ 411px).
  // A target above the ceiling guarantees one item starves while the other
  // holds the target (measured: 0.58 target → pairs like 0.55/0.42). 0.55
  // leaves the ~10% overlap budget as headroom for the diagonal packing.
  2: 0.55,
  3: 0.48,
  4: 0.42,
  5: 0.38,
};
/** Blend window [start, end] over which the fill curve converges to the
 * legacy TOTAL_COVERAGE_TARGET/n split (fully legacy from n = 12 on). */
const FILL_BLEND_START = 5;
const FILL_BLEND_END = 12;
/**
 * Per-item cap on the DESIRED area as a fraction of the card area — kept as
 * a SAFEGUARD for large n only (applied when n ≥ MAX_ITEM_CAP_MIN_ITEMS).
 * It used to apply from n = 2 and was the direct cause of the small second
 * sticker; with the v2 curve the share for n ≥ 8 is always well below the
 * cap, so the cap no longer binds at any n — it only guards against a future
 * target-curve change pushing large-n desired areas past the crowded-card
 * ceiling. The solo target (65%) is intentionally exempt.
 */
const MAX_ITEM_AREA_SHARE = 0.22;
const MAX_ITEM_CAP_MIN_ITEMS = 8;

/**
 * Desired card-area share per item for an n-item layout (see the
 * sizing-policy v2 doc above). Monotonically non-increasing in n.
 */
export function perItemShare(n: number): number {
  if (n <= 1) return SOLO_ITEM_COVERAGE;
  const fill = FILL_COVERAGE / n;
  const legacy = TOTAL_COVERAGE_TARGET / n;
  const t = Math.min(
    1,
    Math.max(0, (n - FILL_BLEND_START) / (FILL_BLEND_END - FILL_BLEND_START)),
  );
  return Math.min(SOLO_ITEM_COVERAGE, fill + (legacy - fill) * t);
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
  // Desired area per item under the v2 share curve (see the sizing-policy
  // doc above). The MAX_ITEM_AREA_SHARE safeguard only engages for large n
  // (n ≥ MAX_ITEM_CAP_MIN_ITEMS); for small n the share itself IS the
  // target and the hard constraints do the feasibility trimming via the
  // per-candidate scale fallback.
  const cardArea = card.w * card.h;
  const capArea =
    n >= MAX_ITEM_CAP_MIN_ITEMS ? MAX_ITEM_AREA_SHARE * cardArea : Infinity;
  const eff = ordered.map((i) => Math.max(i.visualWeight, WEIGHT_FLOOR));
  const sum = eff.reduce((s, w) => s + w, 0);
  const map = new Map<string, number>();
  // Few-item width policy for 2 ≤ n ≤ 5 (see PER_ITEM_WIDTH_TARGET); the
  // area-share curve keeps driving n = 1 (solo) and n ≥ 6 (legacy split).
  const widthTarget = PER_ITEM_WIDTH_TARGET[n];
  for (let i = 0; i < n; i++) {
    const item = ordered[i]!;
    // Size equalization: blend the visualWeight-weighted split 50/50 with a
    // flat equal split (EQUALIZE_FRAC; WEIGHT_FLOOR unchanged). Both splits
    // normalize to the same total (n × perItemShare for areas, n ×
    // widthTarget for widths), so the blend preserves the policy total —
    // only its distribution changes.
    const weightedShare = (n * eff[i]!) / sum;
    const share = EQUALIZE_FRAC * 1 + (1 - EQUALIZE_FRAC) * weightedShare;
    if (widthTarget !== undefined) {
      // Few-item width policy: the desired display WIDTH is the policy
      // target × the blended share factor; the item's aspect sets the
      // height. Same share for same weight → same desired width.
      const desiredWidth = widthTarget * share * card.w;
      const scale = desiredWidth / (item.imgW * k);
      map.set(item.id, scaleFor(item, card, k, scale, minSizePct));
      continue;
    }
    // Area path (n = 1 solo target; n ≥ 6 legacy coverage split):
    // perItemShare(n) is ALREADY a per-item share of the card area, so the
    // visualWeight proportions are normalized by n·share (= 1 for equal
    // weights): heavier items get more than perItemShare, lighter ones
    // less, and the intended total stays n × perItemShare.
    const desiredArea = Math.min(perItemShare(n) * cardArea, capArea) * share;
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
  // Overlap policy: the SINGLE 10% user tolerance (overlapCapFor) applies
  // to the whole layout, measured on TRUE rotated rectangles (see
  // constraints.ts — bounding-box overlap is no longer the measure).
  const overlapCap = opts.overlapCap ?? overlapCapFor(items.length);

  // Hint lookup: itemId → group center/spread.
  const grouped = new Map<string, { cx: number; cy: number; spread: number }>();
  for (const g of hints?.groups ?? []) {
    for (const id of g.itemIds) grouped.set(id, { cx: g.cx, cy: g.cy, spread: g.spread });
  }

  // Sort: visualWeight desc, stable tie-break by orderIndex.
  const ordered = [...items].sort(
    (a, b) => b.visualWeight - a.visualWeight || a.orderIndex - b.orderIndex,
  );

  const ctx: ConstraintCtx = { card, k, textZone: opts.textZone, minSizePct, overlapCap };
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
   * hoisted up front in a fixed order (grid cells, then hint samples, then
   * polar ring samples — always the same count per item), so the draw
   * sequence never depends on which scale step happens to succeed.
   */
  // Per-cell scale fallback ladder — refined from [1, .9, .8, .7, .6, .5,
  // .4, .3] to 5% steps in the sizing-accuracy pass: a starved item can now
  // keep up to ~5% more size in crowded cells (the old ladder's 10% jumps
  // left feasible intermediate sizes on the table).
  const SCALE_FALLBACK_STEPS = [
    1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.3,
  ];
  const candidatesFor = (item: LayoutItem, index: number, placed: Placed[]): Placement[] => {
    const group = grouped.get(item.id);
    const baseScale =
      desired.get(item.id) ?? scaleFor(item, card, k, undefined, minSizePct);
    const placedBoxes = placed.map((p) => placedFootprint(p.placement, p.item, k));
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
        const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
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
        const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
        const rot = (rng() * 2 - 1) * 12;
        seeds.push({ x, y, jitter, rot });
      }
    }
    // Polar ring samples around the composition focus (placement freedom —
    // see the RING_* constant docs). Same hoisted-draw pattern as above:
    // angle-jitter, radius, scale-jitter and rotation draws in a fixed
    // order, one seed per ring slot, regardless of constraint outcomes.
    const fx = focalPoint?.x ?? card.w / 2;
    const fy = focalPoint?.y ?? card.h / 2;
    const minDim = Math.min(card.w, card.h);
    for (let r = 0; r < RING_SAMPLES; r++) {
      const angleDeg =
        r * GOLDEN_ANGLE_DEG + (rng() * 2 - 1) * RING_ANGLE_JITTER_DEG;
      const radius =
        (RING_RADIUS_MIN + rng() * (RING_RADIUS_MAX - RING_RADIUS_MIN)) * minDim;
      const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
      const rot =
        index === 0 && !hints ? 0 : (rng() * 2 - 1) * RING_ROT_JITTER_DEG;
      const rad = (angleDeg * Math.PI) / 180;
      seeds.push({
        x: clamp(fx + Math.cos(rad) * radius, ax1, ax2),
        y: clamp(fy + Math.sin(rad) * radius, ay1, ay2),
        jitter,
        rot,
      });
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

  /**
   * Scale-fidelity soft term (solver-internal, NOT part of scoreLayout): the
   * mean shortfall of the placed scales below their desired
   * (coverage-policy) scales. Without it the greedy pass drifts to undersized
   * candidates in "roomier" spots — the focal/spacing/edge terms do not
   * reward size, so the desired scale merely BOUNDS the outcome instead of
   * driving it (measured pre-v2: n=2 landed at ~0.42 width against a 0.55
   * desired — the "2nd sticker is small" complaint). With the term, growing
   * toward the desired scale wins the incremental comparison whenever the
   * hard constraints allow it, so few stickers fill the card. Hard-constraint
   * trimming (in-bounds, text zone, overlap cap) still wins over fidelity:
   * an infeasible desired scale falls back through the per-candidate steps
   * and the term simply bottoms out at the largest feasible scale.
   */
  const fidelity = (placements: Placement[]): number => {
    let s = 0;
    for (const p of placements) {
      const d = desired.get(p.itemId);
      if (d === undefined) continue;
      s += Math.max(0, 1 - p.scale / d);
    }
    // SUM, not mean: the per-item gradient (what the greedy/sweeps actually
    // compare between candidates) must not weaken as n grows, or items stop
    // reaching their desired scale exactly when the card gets busier.
    return s;
  };

  /** Incremental score of `cand` + `item` against the already-placed set. */
  const incremental = (cand: Placement, item: LayoutItem, placed: Placed[]): number => {
    const placements = [cand, ...placed.map((p) => p.placement)];
    const ids = new Set(placements.map((p) => p.itemId));
    const subset = items.filter((i) => ids.has(i.id));
    const sctx: ScoreContext = { card, k, focalPoint, clustered };
    return scoreLayout(placements, subset, sctx) + SCALE_FIDELITY_WEIGHT * fidelity(placements);
  };

  /**
   * GLOBAL objective (same terms as `incremental`) over a full placement set —
   * used by the coordinate-descent sweeps below, where one item's move must
   * be weighed against what it frees up for the others (the incremental view
   * cannot see that: when the first sticker takes the card center at its
   * desired scale, the second sticker's best feasible candidate starves at a
   * fraction of its desired scale, and no per-candidate score fixes that
   * retroactively).
   */
  const objective = (placements: Placement[]): number => {
    const ids = new Set(placements.map((p) => p.itemId));
    const subset = items.filter((i) => ids.has(i.id));
    const sctx: ScoreContext = { card, k, focalPoint, clustered };
    return scoreLayout(placements, subset, sctx) + SCALE_FIDELITY_WEIGHT * fidelity(placements);
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

  // Coordinate-descent sweeps: regenerate the FULL candidate set for each
  // item against the others and keep the re-placement only when it improves
  // the GLOBAL objective. This is what buys balanced "few big stickers"
  // layouts: the sequential greedy commits the first sticker to the focal
  // center (its own fidelity is already satisfied there), which starves the
  // next sticker; a sweep lets the first sticker step aside once the global
  // objective (including the others' fidelity) improves. Fixed item order →
  // deterministic; candidates are hard-constraint-checked as always.
  for (let sweep = 0; sweep < COORD_SWEEPS; sweep++) {
    let changed = false;
    for (let idx = 0; idx < placed.length; idx++) {
      const p = placed[idx]!;
      const others = placed.filter((_, i) => i !== idx);
      const currentObjective = objective([p.placement, ...others.map((o) => o.placement)]);
      const cands = candidatesFor(p.item, ordered.indexOf(p.item), others);
      let best = p.placement;
      let bestScore = currentObjective;
      for (const c of cands) {
        const s = objective([c, ...others.map((o) => o.placement)]);
        if (s < bestScore) {
          best = c;
          bestScore = s;
        }
      }
      if (best !== p.placement) {
        placed[idx] = { item: p.item, placement: best };
        changed = true;
      }
    }
    if (!changed) break;
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
    const placedBoxes: PlacedFootprint[] = others.map((o) =>
      placedFootprint(o.placement, o.item, k),
    );
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

  // ------------------------------------------------------------------------
  // Balanced-pair refinement (sizing-accuracy pass). The sequential greedy
  // gives the FIRST-placed item an advantage: it claims the prime spot at its
  // desired scale, later items starve in the leftovers (measured at the 10%
  // true-overlap cap: a pair of equal squares landed at widths [0.62, 0.27] —
  // the "sizes not equal or similar" complaint). The coordinate sweeps cannot
  // fix this: a single-item move never SHRINKS the wide item while re-growing
  // the starved one, and the starved item's best move is evaluated against
  // the wide item's oversized footprint. This pass rebalances the
  // widest/narrowest pair directly: shrink the widest along a concession
  // ladder, re-place the narrowest in the freed room (existing candidate
  // machinery, per-cell ladder included), and commit the compound move only
  // when the global objective improves. Deterministic; bounded rounds; only
  // runs for few-item layouts (large-n layouts have no dominant pair).
  // ------------------------------------------------------------------------
  if (placed.length >= 2 && placed.length <= REBALANCE_MAX_ITEMS) {
    const widthFrac = (p: Placed): number =>
      displayWidth(p.item, p.placement.scale, k) / card.w;
    for (let round = 0; round < REBALANCE_ROUNDS; round++) {
      let widest = 0;
      let narrowest = 0;
      for (let i = 1; i < placed.length; i++) {
        if (widthFrac(placed[i]!) > widthFrac(placed[widest]!)) widest = i;
        if (widthFrac(placed[i]!) < widthFrac(placed[narrowest]!)) narrowest = i;
      }
      const wMax = widthFrac(placed[widest]!);
      const wMin = widthFrac(placed[narrowest]!);
      // Trigger the refinement pass when the pair is IMBALANCED (ratio > cap)
      // OR when the narrow item sits ≥0.02 below its own desired width — a
      // balanced-but-undersized pair must also attempt co-replacement, else
      // it never grows back to its per-item width target.
      const narrowDesired = desired.get(placed[narrowest]!.item.id);
      const undersized =
        narrowDesired !== undefined &&
        wMin < narrowDesired - 0.02;
      if (widest === narrowest || (!undersized && wMax <= wMin * REBALANCE_RATIO + 1e-9)) break;
      const wideEntry = placed[widest]!;
      const narrowEntry = placed[narrowest]!;
      const others = placed.filter((_, i) => i !== widest && i !== narrowest);
      const currentObj = objective(placed.map((p) => p.placement));
      let best: { wide: Placement; narrow: Placement; obj: number } | null = null;
      for (const f of REBALANCE_LADDER) {
        const trialScale = scaleFor(
          wideEntry.item,
          card,
          k,
          wideEntry.placement.scale * f,
          minSizePct,
        );
        // Skip rungs that would GROW the wide item (the ladder only shrinks
        // or re-places at equal size); f = 1 stays — re-placing BOTH items at
        // full scale in fresh spots is the compound move that finds the
        // corner-bump arrangements pure single-item moves cannot reach (the
        // narrow item can only grow when the wide one steps aside).
        if (trialScale > wideEntry.placement.scale + 1e-12) continue;
        // Re-place the SHRUNKEN wide item too (not just shrink it in place):
        // on a few-item card the wide item often occupies the entire usable
        // band, so NO slot exists for a grown narrow item beside it — the
        // wide item must step aside as well. Its current spot (legal vs the
        // fixed others by construction) plus its full candidate set are
        // tried; the most promising few are expanded.
        const wideCands = candidatesFor(
          wideEntry.item,
          ordered.indexOf(wideEntry.item),
          others,
        );
        wideCands.push({ ...wideEntry.placement, scale: trialScale });
        const rankedWide = wideCands
          .map((c) => ({ c, s: incremental(c, wideEntry.item, others) }))
          .sort((a, b) => a.s - b.s)
          .slice(0, REBALANCE_WIDE_EXPAND)
          .map((e) => e.c);
        for (const wideCand of rankedWide) {
          const pool: Placed[] = [
            ...others,
            { item: wideEntry.item, placement: wideCand },
          ];
          // Re-place the narrowest from scratch in the freed room. Its
          // current spot stays legal (the wide item only shrank/moved within
          // what the constraints allow vs the others; vs the narrow item's
          // old spot it may now be closer, so the fallback is re-checked
          // below and only kept when legal).
          const cands = candidatesFor(
            narrowEntry.item,
            ordered.indexOf(narrowEntry.item),
            pool,
          );
          cands.push(narrowEntry.placement);
          let bestNarrow: Placement | null = null;
          let bestNarrowScore = Infinity;
          for (const c of cands) {
            if (
              checkItem(
                c,
                narrowEntry.item,
                { ...ctx, checkTextOverlap: textRuleApplies(narrowEntry.item) },
                pool.map((o) => placedFootprint(o.placement, o.item, k)),
              ).length !== 0
            ) {
              continue;
            }
            const s = incremental(c, narrowEntry.item, pool);
            if (s < bestNarrowScore) {
              bestNarrow = c;
              bestNarrowScore = s;
            }
          }
          if (bestNarrow === null) continue;
          const obj = objective([
            wideCand,
            bestNarrow,
            ...others.map((o) => o.placement),
          ]);
          if (best === null || obj < best.obj) {
            best = { wide: wideCand, narrow: bestNarrow, obj };
          }
        }
      }
      if (best !== null && best.obj < currentObj - 1e-12) {
        placed[widest] = { item: wideEntry.item, placement: best.wide };
        placed[narrowest] = { item: narrowEntry.item, placement: best.narrow };
        continue;
      }
      break;
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
