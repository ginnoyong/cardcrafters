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
 *      relaxed by −1% steps (floor 3%, max 5 relaxations). Each step first
 *      runs a SPACE CHECK (placed AABB-union coverage of the usable area):
 *      while coverage < 0.70 the card is not crowded, so desired scales are
 *      NOT shrunk — instead the placement order is retried once with the
 *      non-hero order REVERSED (smaller-weight late arrivals get first pick
 *      of the empty space, hero still first). Only when coverage ≥ 0.70 or
 *      the reversed retry still leaves items unplaced do supports' desired
 *      scales shrink (desiredShrink, floor 0.35); as a last resort the
 *      text-overlap rule is dropped for items beyond the first 20 (with a
 *      warning). Out-of-bounds placements are NEVER emitted: bounds and
 *      minSize are hard constraints — an item that still cannot fit is simply
 *      omitted from the result (also warned).
 *
 * zIndex = the item's orderIndex (later submissions render on top), EXCEPT
 * the HERO (see the hero-montage policy block) which renders topmost.
 */

import type { LayoutComposition, LayoutItemHint, Placement } from "@cardcrafters/shared";
import {
  MIN_ITEM_SIZE_PCT,
  SOLO_ITEM_COVERAGE,
  TOTAL_COVERAGE_TARGET,
} from "@cardcrafters/shared";

import {
  baseFit,
  checkItem,
  displayHeight,
  displayWidth,
  HERO_TUCK_CAP,
  overlapCapFor,
  placedBox,
  placedFootprint,
  scaleFor,
  scaleWindow,
  safeMargin,
  TEXT_ZONE_PAD_FRAC,
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
 * Hero-montage: the HERO's scale shortfall counts this many times more in
 * the fidelity term than a support's (see `fidelity`). Without the boost the
 * soft spacing term (score.ts `space`, weight 0.25) rewards a SMALLER hero
 * whenever it tucks against a support — the hero would settle ~15% under its
 * 0.65 target (measured 0.543 at n = 2). ×3 makes a hero shrink strictly
 * more expensive than any positioning gain while hard constraints still
 * force genuine fallbacks (the term bottoms out at the largest feasible
 * scale, as before).
 */
const HERO_FIDELITY_WEIGHT = 3.0;
/**
 * Group-cohesion soft terms (semantic-grouping pass — solver-internal, NOT
 * part of scoreLayout, same mechanism as `fidelity`).
 *
 * COHESION: pairs of items in the SAME hint group are pulled together to a
 * target center distance of COHESION_TOUCH_FACTOR × (halfA + halfB), where
 * half = the mean half-extent ((displayW + displayH) / 4) of the placed
 * sticker — "near-touching" for the pair (for two equal squares: 1.15 × side).
 * Items in DIFFERENT hint groups get breathing room: centers closer than
 * COHESION_SEPARATION_FACTOR × (halfA + halfB) are penalized proportionally.
 * Both penalties are normalized per pair and SUMMED (gradient does not decay
 * with n). Pairs where either item has no group are neutral (no info).
 *
 * Weight (1.0) — chosen so cohesion dominates the positioning preferences it
 * must beat, measured on the default 5:7 card (two equal 256×256 squares,
 * width target 0.55, halfA+halfB ≈ 393): with W = 1.0 the same-group pair
 * equilibrates AT the 1.15× target (≈ 452 units, ratio 1.15 — the spacing
 * term's comfort distance ≈ 513 is weaker: moving d from 452 → 513 costs
 * cohesion (513−452)/452 ≈ 0.135 vs the spacing term's 0.25 × (513−d)/513
 * gain ≈ 0.03), and the different-group pair is pushed to the largest
 * jointly-feasible distance (≈ 587 = 1.49× at desired scale — fidelity's
 * shrink cost 0.09 > the residual cohesion gain 0.067, so stickers do NOT
 * undersize to satisfy separation; the hard 10% SAT cap still wins over both).
 * With W = 0.5 the same-group pair drifted to ≈ 1.5× (too loose).
 *
 * ORIENTATION: per-item tilt hints. An item with a resolvable tiltToward
 * target (another PLACED item's center, or its group center when the group
 * has ≥2 members) is penalized for the angular deviation between its
 * rotation and the direction toward the target (saturating at 30°). The
 * interpretation here is "stickers with an interaction hint FACE their
 * target": the brief's test spec demands the rotation within ±20° of the
 * angle toward the target, so the hinted angle is applied in full (candidate
 * rotations at the hinted angle ± HINT_TILT_JITTER_DEG) rather than capped at
 * the ±8–15° a few-degrees-only reading would allow. Subtlety is preserved
 * where it matters: NON-hinted rotations keep the existing ±12° policy, and
 * the hinted rotation is jittered so perfect facing is not forced.
 */
const COHESION_WEIGHT = 1.0;
const COHESION_TOUCH_FACTOR = 1.15;
const COHESION_SEPARATION_FACTOR = 1.6;
const ORIENTATION_WEIGHT = 0; // USER DECISION: orientation disabled
const ORIENT_TOLERANCE_DEG = 30;
const HINT_TILT_JITTER_DEG = 8;
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
/** Extra candidates whose rotation faces the tilt target (see ORIENTATION). */
const ORIENT_SAMPLES = 6;
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

// ---------------------------------------------------------------------------
// Hero-montage policy (dominant hero + orbiting supports)
// ---------------------------------------------------------------------------
/**
 * Hero-montage sizing: the card's TOP-RANKED sticker (the HERO) is sized
 * dominantly at HERO_WIDTH_TARGET = 0.65 of the card width; the remaining
 * stickers (SUPPORTS) fill the whitespace AROUND the hero and may tuck
 * BEHIND it (hero–support pairs get the deeper HERO_TUCK_CAP overlap; the
 * hero renders on top). Hard floor: every support's display width is at
 * least SUPPORT_HERO_FLOOR × the hero's width — enforced as a HARD clamp in
 * the candidate generator (a candidate below the floor is re-clamped UP to
 * the floor; if even the floor cannot fit the hard constraints in any cell,
 * the per-cell fallback ladder resolves downward, documented in
 * candidatesFor — the floor yields to the hard in-bounds/overlap/minSize
 * constraints, never the other way around).
 *
 * SPACE-AWARE FLOOR RESOLUTION (top-corner utilization pass): the floor's
 * soft resolution (the no-floor retry in candidatesFor) used to run
 * unconditionally whenever no cell fit the floored scale — supports shrank
 * below 0.5×hero even when the card still had room. Now the yield is gated
 * by a SPACE CHECK: the placed AABB-union coverage of the USABLE area (below
 * the padded text strip, inside the safe margin, sampled on a fixed grid —
 * usableAreaCoverage below). While coverage < SPACE_CHECK_COVERAGE (0.70)
 * the floor stays HARD for few-item layouts (n ≤ 5): supports keep ≥ 0.5×hero
 * and fill the roomy bottom band / lower corner-tuck slots; only when the
 * card is actually crowded (coverage ≥ 0.70), or once the relaxation regime
 * has engaged (desiredShrink < 1 — every space-preserving option is
 * exhausted, see solveLayout), does the floor yield as before. Large-n
 * layouts (n > 5) keep the UNCONDITIONAL yield: there the floor is a pure
 * safety net over the legacy per-item share curve and gating it would
 * starve/drop supports (measured 18/25 placed at n = 25 with a hard floor).
 *
 * HERO TOP CORNERS: the hero is centered, so its top corners (x flanks at
 * hero top, y between the text-strip bottom and the hero's top edge) are
 * prime empty space the polar ring under-samples. candidatesFor adds
 * corner-anchor seeds there for the first few supports (see
 * CORNER_SEED_MAX_SUPPORT_RANK): positions at (heroX ± (heroHalfW +
 * supportHalfW) × CORNER_SEED_TUCK, textZoneBottom + pad + supportHalfH),
 * i.e. tucked up beside the hero's top half, plus one fully-outward anchor
 * per side (tuck 1.0) that the per-cell ladder can resolve at sub-desired
 * scales against the outer margin. Measured (equal squares, seeds 1–5):
 * top-corner region coverage (x ∈ [0, 0.25] ∪ [0.75, 1], y ∈ [0.24, 0.45])
 * at n = 4 rises from 0.31–0.52 to ≈ 0.5–0.62 (the yielding supports now
 * land in OPTIMAL corner slots instead of wherever the below-floor ladder
 * happened to fit).
 *
 * HERO DESIGNATION: a hint with role:"focal" (the layout AI's
 * layout_composition output) designates the hero; absent a focal hint the
 * highest visualWeight wins (stable tie-break by orderIndex). Ranking runs
 * EVERY solve from the current hints + weights, so when a new sticker
 * arrives and the hints designate a different focal, the new sticker takes
 * the hero size and the previous hero resizes as a support — the solver
 * re-solves the whole card on every arrival.
 *
 * LARGE n: at large item counts the per-item share curve (perItemShare,
 * legacy TOTAL_COVERAGE_TARGET/n split) shrinks the hero like everyone
 * else; supports shrink with it and the 0.5× floor is maintained by the
 * same desired-scale floor + hard clamp (with equal-ish weights the shares
 * are near-equal, so the floor rarely binds — it is a safety net).
 */
/** Hero (rank 0) display-width target: fraction of the card width. */
const HERO_WIDTH_TARGET = 0.65;
/** Hard floor: any non-hero sticker's width ≥ this fraction of the hero's. */
const SUPPORT_HERO_FLOOR = 0.5;
/**
 * SPACE CHECK threshold (space-aware support floor, see the block below):
 * the placed AABB-union coverage of the USABLE area (below the padded text
 * strip, inside the safe margin). Below this the card is NOT crowded and the
 * 0.5×hero floor must NOT soft-resolve; at/above it the card is crowded and
 * the floor may yield (per-cell ladder below the floor) so late supports can
 * still be placed instead of dropped.
 */
const SPACE_CHECK_COVERAGE = 0.7;
/**
 * Hero-corner anchor seeds (top-corner utilization, see candidatesFor): only
 * the FIRST FEW SUPPORTS get the corner anchors — by the time later supports
 * are placed, coverage has picked up and the corners are contested anyway
 * ("until coverage picks up" is implemented as BOTH a rank cap and the same
 * SPACE_CHECK_COVERAGE gate used by the floor resolution).
 */
const CORNER_SEED_MAX_SUPPORT_RANK = 4;
/**
 * Corner-anchor x tuck factor: the anchor sits at heroX ± (heroHalfW +
 * supportHalfW) × this fraction of the summed half-widths — tucked up beside
 * the hero's top half, partially BEHIND its edge (hero renders topmost and
 * hero–support pairs ride the deeper HERO_TUCK_CAP). A second anchor per
 * side at tuck 1.0 (box edge at the hero's edge) gives the ladder a feasible
 * slot once the scale steps below the desired scale.
 */
const CORNER_SEED_TUCK = 0.55;
/**
 * Fallback text-strip bottom (fraction of card height) for the corner-anchor
 * y when NO text zone is reserved: the greeting strip's policy position
 * (6%–22% of the card height) — the anchors still target the band under it.
 */
const TEXT_ZONE_FALLBACK_BOTTOM_FRAC = 0.22;
/** Sample grid resolution for usableAreaCoverage (deterministic, pure). */
const COVERAGE_GRID = 48;
/**
 * Corner-fill region: the hero's TOP-corner band spans from the (padded)
 * text-strip bottom down to this fraction of the card height (the brief's
 * measurement region y ∈ [0.24, 0.45]); its x extent is the ACTUAL flanks
 * beside the placed hero's box (inside the safe margin).
 */
const CORNER_REGION_Y2_FRAC = 0.45;
/**
 * Weight of the solver-internal CORNER FILL term (see `cornerFill` in
 * attemptSolve). Tuned so the term reorders SUB-floor candidates toward the
 * hero's top corners (a corner slot covers ≈ 0.3–0.4 of the corner region
 * vs ≈ 0.05 for the centre-hugging lower-flank slot the focal/spacing terms
 * prefer → 0.25 × 0.3 ≈ 0.08 beats their combined ≈ 0.02 preference), while
 * the scale-fidelity gradient still dominates ACROSS floor boundaries (a
 * floor-scale bottom-band slot costs ≈ 0.19 less fidelity shortfall than a
 * ~0.3×hero corner slot → fidelity wins and the floor is honoured first).
 * Hard constraints always win over both (only feasible candidates score).
 */
const CORNER_FILL_WEIGHT = 0.25;

/**
 * Hero designation (hero-montage policy — see the block above). Deterministic:
 * a hint with role:"focal" wins (earliest orderIndex among focal-hinted
 * items); otherwise the highest visualWeight (earliest orderIndex on ties).
 * Returns null for an empty item list.
 */
export function heroItemIdOf(
  items: LayoutItem[],
  hints?: LayoutComposition | null,
): string | null {
  if (items.length === 0) return null;
  let hero: LayoutItem | null = null;
  for (const h of hints?.hints ?? []) {
    if (h.role !== "focal") continue;
    const item = items.find((i) => i.id === h.itemId);
    if (item && (hero === null || item.orderIndex < hero.orderIndex)) hero = item;
  }
  if (hero === null) {
    // USER DECISION: without focal hints, the FIRST sticker (earliest
    // orderIndex) is the hero — "similar size as the first sticker"; the
    // layout AI may re-designate a later sticker via role:"focal" (above).
    // (Previous rule — highest visualWeight — made the hero unpredictable
    // from the player's perspective.)
    hero = items.reduce((a, b) => (b.orderIndex < a.orderIndex ? b : a));
  }
  return hero!.id;
}

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
  /** Optional itemId → importance (0..1 hint) overriding visualWeight in the
   *  share split — hint importance orders size WITHIN a group so the group's
   *  focal item gets the larger share (equalization blend unchanged). */
  weightOverride?: Map<string, number>,
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
  const eff = ordered.map((i) => {
    const o = weightOverride?.get(i.id);
    return o !== undefined ? Math.max(o, 0) : Math.max(i.visualWeight, WEIGHT_FLOOR);
  });
  const sum = eff.reduce((s, w) => s + w, 0);
  const map = new Map<string, number>();
  // Few-item width policy for 2 ≤ n ≤ 5 (see PER_ITEM_WIDTH_TARGET); the
  // area-share curve keeps driving n = 1 (solo) and n ≥ 6 (legacy split).
  const widthTarget = PER_ITEM_WIDTH_TARGET[n];
  // Hero-montage: rank 0 IS the hero (heroItemIdOf decides; `ordered` is
  // already re-ranked hero-first by the caller). Its desired width is the
  // policy-fixed HERO_WIDTH_TARGET (few-item mode) or the area-share width
  // (legacy mode); every support's desired width is floored at
  // SUPPORT_HERO_FLOOR × the hero's desired width.
  const heroItem = ordered[0]!;
  // USER DECISION (hero-montage v2): the hero stays at HERO_WIDTH_TARGET
  // (0.65 × card width) for ALL item counts — no legacy-curve shrink at
  // n ≥ 6. The hero only yields if physically infeasible (per-cell fallback
  // ladder trims; hard constraints always win).
  const heroDesiredWidth = HERO_WIDTH_TARGET * card.w;
  const supportFloorWidth = SUPPORT_HERO_FLOOR * heroDesiredWidth;
  for (let i = 0; i < n; i++) {
    const item = ordered[i]!;
    // Size equalization: blend the visualWeight-weighted split 50/50 with a
    // flat equal split (EQUALIZE_FRAC; WEIGHT_FLOOR unchanged). Both splits
    // normalize to the same total (n × perItemShare for areas, n ×
    // widthTarget for widths), so the blend preserves the policy total —
    // only its distribution changes.
    const weightedShare = (n * eff[i]!) / sum;
    const share = EQUALIZE_FRAC * 1 + (1 - EQUALIZE_FRAC) * weightedShare;
    // USER DECISION: the 0.5×hero support floor applies only in the few-item
    // range (n ≤ 5) where geometry allows it alongside a 0.65 hero — beyond
    // that the floor's sheer area demand (n × 0.106 card areas) exceeds the
    // card and starves/DROPS supports (measured: 18/25 placed at n=25). The
    // floor remains a goal via the candidate-level clamp's soft resolution.
    const floorApplies = supportFloorWidth > 0 && n <= 5;
    if (widthTarget !== undefined) {
      // Few-item width policy: the hero takes the policy-fixed hero width;
      // supports take the table target × share, floored at the hero floor.
      const desiredWidth =
        i === 0
          ? heroDesiredWidth
          : Math.max(
              widthTarget * share * card.w,
              floorApplies ? supportFloorWidth : 0,
            );
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
    // Supports are floored at SUPPORT_HERO_FLOOR × the hero's desired width
    // (the hero can shrink with the curve, but supports shrink WITH it).
    // USER DECISION: rank 0 (hero) is ALWAYS heroDesiredWidth (0.65 × card
    // width) in every mode; only supports follow the share curve here.
    const desiredWidth =
      i === 0
        ? heroDesiredWidth
        : Math.max(
            Math.sqrt((desiredArea * item.imgW) / item.imgH),
            floorApplies ? supportFloorWidth : 0,
          );
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
 * SPACE CHECK (space-aware support floor — see the hero-montage policy
 * block): placed AABB-union coverage of the USABLE area, i.e. the card
 * inside the safe margin and BELOW the (2%-padded) greeting-text strip —
 * the region the solver can actually paint. Sampled on a fixed COVERAGE_GRID
 * grid (pure + deterministic; placement x/y ARE the centroids). Used to
 * decide (a) whether the 0.5×hero support floor may soft-resolve in
 * candidatesFor and (b) whether the relaxation loop may shrink desired
 * scales or must first retry the placement order (solveLayout).
 */
function usableAreaCoverage(
  placed: readonly Placed[],
  card: CardBox,
  k: number,
  textZone: Rect | null,
): number {
  if (placed.length === 0) return 0;
  const m = safeMargin(card);
  const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
  const ux1 = m.x;
  const ux2 = card.w - m.x;
  const uy1 = Math.max(
    m.y,
    textZone ? textZone.y + textZone.h + pad : 0,
  );
  const uy2 = card.h - m.y;
  if (!(ux2 > ux1) || !(uy2 > uy1)) return 1; // degenerate usable area → crowded
  const N = COVERAGE_GRID;
  let covered = 0;
  for (let gy = 0; gy < N; gy++) {
    const cy = uy1 + ((gy + 0.5) * (uy2 - uy1)) / N;
    for (let gx = 0; gx < N; gx++) {
      const cx = ux1 + ((gx + 0.5) * (ux2 - ux1)) / N;
      for (const p of placed) {
        const b = placedBox(p.placement, p.item, k);
        if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) {
          covered++;
          break;
        }
      }
    }
  }
  return covered / (N * N);
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
  desiredShrink = 1,
  reverseNonHero = false,
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

  // Hint lookup: itemId → group (identity is SHARED between a group's members
  // so same-group pairs are a reference-equality test). Plus the per-item
  // hint map (role/tiltToward/importance — the optional semantic-grouping
  // contract) and the importance→weight override for the sizing policy.
  type LayoutGroup = LayoutComposition["groups"][number];
  const grouped = new Map<string, LayoutGroup>();
  const groupSizeOf = new Map<string, number>();
  for (const g of hints?.groups ?? []) {
    for (const id of g.itemIds) {
      grouped.set(id, g);
      groupSizeOf.set(id, g.itemIds.length);
    }
  }
  const hintByItem = new Map<string, LayoutItemHint>();
  for (const h of hints?.hints ?? []) hintByItem.set(h.itemId, h);
  const importanceOverride = new Map<string, number>();
  for (const h of hints?.hints ?? []) {
    if (typeof h.importance === "number") importanceOverride.set(h.itemId, h.importance);
  }

  // Sort: visualWeight desc, stable tie-break by orderIndex — then re-rank
  // so the HERO (hint role:"focal", else highest visualWeight — see
  // heroItemIdOf) is processed FIRST and claims the dominant spot.
  const ranked = [...items].sort(
    (a, b) => b.visualWeight - a.visualWeight || a.orderIndex - b.orderIndex,
  );
  const heroId = heroItemIdOf(items, hints);
  const heroIdx = ranked.findIndex((i) => i.id === heroId);
  if (heroIdx > 0) ranked.unshift(...ranked.splice(heroIdx, 1));
  // SPACE-AWARE ORDER RETRY (see solveLayout): when the greedy starves late
  // arrivals on a NOT-yet-crowded card, the retry pass re-runs the solve with
  // the non-hero order REVERSED — the SMALLER-weight (later) items get first
  // pick of the empty space while the hero still claims its spot first. The
  // greedy's first pick is the biggest feasible slot, so reversed order lets
  // the starved supports grow instead of resigning to desiredShrink.
  const ordered =
    reverseNonHero && ranked.length > 1
      ? [ranked[0]!, ...ranked.slice(1).reverse()]
      : ranked;

  const ctx: ConstraintCtx = {
    card,
    k,
    textZone: opts.textZone,
    minSizePct,
    overlapCap,
    heroItemId: heroId ?? undefined,
    heroOverlapCap: HERO_TUCK_CAP,
  };
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
  // block comment above). Seeds the candidate scale jitter. Hint importance
  // (when present) overrides visualWeight in the share split.
  const rawDesired = desiredScales(
    ordered,
    card,
    k,
    minSizePct,
    importanceOverride.size > 0 ? importanceOverride : undefined,
  );
  // Relaxation shrink: supports' desired scales shrink toward the floor; the
  // HERO keeps its full desired width (user rule: hero stays ~0.65).
  // (heroId is already computed above from the same ordered list + hints.)
  const desired = new Map(
    [...rawDesired].map(([id, s]) => [
      id,
      id === heroId ? s : s * desiredShrink,
    ]),
  );

  const itemsById = new Map(items.map((i) => [i.id, i] as const));

  /** Normalize an angle to (−180, 180]. */
  const norm180 = (deg: number): number => {
    const a = ((deg % 360) + 360) % 360;
    return a > 180 ? a - 360 : a;
  };
  /** Direction from `from` to `to` in degrees (y-down screen space). */
  const angleDeg = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): number => norm180((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);

  /** Resolve a tilt hint's target center against the CURRENT placements.
   *  group_center → the item's own group center, but only when the group has
   *  other members (a solo item sits ON the center — no meaningful angle,
   *  and forcing a rotation would regress the solo hint path). */
  const tiltTargetFor = (
    itemId: string,
    placements: Placement[],
  ): { x: number; y: number } | null => {
    const h = hintByItem.get(itemId);
    if (!h?.tiltToward) return null;
    if (h.tiltToward === "group_center") {
      if ((groupSizeOf.get(itemId) ?? 1) < 2) return null;
      const g = grouped.get(itemId);
      return g ? { x: g.cx, y: g.cy } : null;
    }
    if (h.tiltToward === itemId) return null;
    const q = placements.find((p) => p.itemId === h.tiltToward);
    return q ? { x: q.x, y: q.y } : null;
  };

  /** Half "reach" of a placed sticker: mean of its rotated-shape half-extents
   *  ((displayW + displayH) / 4) — the radius used by the cohesion targets. */
  const halfExtentOf = (p: Placement): number => {
    const item = itemsById.get(p.itemId);
    if (!item) return 0;
    return (displayWidth(item, p.scale, k) + displayHeight(item, p.scale, k)) / 4;
  };

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

    // Hero-montage support floor: a non-hero candidate's scale is clamped UP
    // to SUPPORT_HERO_FLOOR × the hero's ACTUAL placed scale (hard clamp —
    // see the policy doc). If even the floored scale cannot fit the hard
    // constraints anywhere, the whole pass is retried WITHOUT the floor: the
    // ladder then resolves below the floor rather than emitting nothing (the
    // hard in-bounds/overlap/minSize constraints always win over the floor).
    const heroEntry = placed.find((p) => p.item.id === heroId);
    const supportFloorScale =
      item.id !== heroId && heroEntry
        ? (displayWidth(heroEntry.item, heroEntry.placement.scale, k) /
            (heroEntry.item.imgW * k)) *
          SUPPORT_HERO_FLOOR
        : 0;

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
    const seeds: Array<{ x: number; y: number; jitter: number; rot: number; rotLocked?: boolean }> = [];
    // USER DECISION: the HERO is CENTERED in the canvas — its ONLY seed is
    // the exact card center (no jitter). Supports then orbit it.
    if (index === 0) {
      const jitter0 = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
      seeds.push({ x: card.w / 2, y: card.h / 2, jitter: jitter0, rot: 0 });
    } else {
    // Grid positions (6×6) with seeded jitter.
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const jx = (rng() - 0.5) * 2 * JITTER_FRAC * cellX;
        const jy = (rng() - 0.5) * 2 * JITTER_FRAC * cellY;
        const x = clamp(ax1 + gx * cellX + jx, ax1, ax2);
        const y = clamp(ay1 + gy * cellY + jy, ay1, ay2);
        const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
        // USER DECISION: all stickers at 0 degrees (orientation disabled).
        const rot = 0;
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
    // Orientation-biased samples (semantic-grouping pass): when the item has
    // a tiltToward hint, extra samples near the group center (or focus)
    // FACE the tilt target — rotation = the angle from this seed's position
    // to the target center, jittered ±HINT_TILT_JITTER_DEG, NOT multiplied by
    // the scale-fallback step (rotLocked). When the target is not (yet)
    // resolvable — e.g. the target item is placed later in the greedy order —
    // the same fixed draw count runs with a plain ±12° rotation so the hoisted
    // draw sequence stays deterministic; the soft orientation term + sweeps
    // enforce the tilt once the target exists.
    if (hintByItem.get(item.id)?.tiltToward) {
      const tiltTarget = tiltTargetFor(
        item.id,
        placed.map((p) => p.placement),
      );
      const orientBase = group ?? {
        cx: focalPoint?.x ?? card.w / 2,
        cy: focalPoint?.y ?? card.h / 2,
        spread: 0.12 * Math.min(card.w, card.h),
      };
      for (let s = 0; s < ORIENT_SAMPLES; s++) {
        const x = clamp(orientBase.cx + (rng() * 2 - 1) * orientBase.spread, ax1, ax2);
        const y = clamp(orientBase.cy + (rng() * 2 - 1) * orientBase.spread, ay1, ay2);
        const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
        // USER DECISION: orientation/tilt disabled — hint samples rotate 0.
        seeds.push({ x, y, jitter, rot: 0 });
      }
    }
    // Polar ring samples. Hero-montage: for NON-hero items with the hero
    // already placed, the ring is centered on the HERO's center (not the
    // composition focus) and the radius range starts at the hero's half
    // extent + a small gap, so supports HUG the hero's edge and fill the
    // whitespace around it (tucking partially behind is allowed via the
    // hero–tuck cap; the scoring picks the exact offset). The hero itself
    // (and any item before the hero is placed) keeps the composition-focus
    // ring. Same hoisted-draw pattern as above: angle-jitter, radius,
    // scale-jitter and rotation draws in a fixed order, one seed per ring
    // slot, regardless of constraint outcomes.
    const fx = focalPoint?.x ?? card.w / 2;
    const fy = focalPoint?.y ?? card.h / 2;
    const minDim = Math.min(card.w, card.h);
    const heroRing = item.id !== heroId ? heroEntry : undefined;
    const ringCx = heroRing ? heroRing.placement.x : fx;
    const ringCy = heroRing ? heroRing.placement.y : fy;
    const ringBase = heroRing ? halfExtentOf(heroRing.placement) : 0;
    for (let r = 0; r < RING_SAMPLES; r++) {
      const angleDeg =
        r * GOLDEN_ANGLE_DEG + (rng() * 2 - 1) * RING_ANGLE_JITTER_DEG;
      const radius = heroRing
        ? ringBase +
          (RING_RADIUS_MIN * 0.5 + rng() * (RING_RADIUS_MAX - RING_RADIUS_MIN)) * minDim
        : (RING_RADIUS_MIN + rng() * (RING_RADIUS_MAX - RING_RADIUS_MIN)) * minDim;
      const jitter = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
      // USER DECISION: all stickers at 0 degrees (orientation disabled).
      const rot = 0;
      const rad = (angleDeg * Math.PI) / 180;
      seeds.push({
        x: clamp(ringCx + Math.cos(rad) * radius, ax1, ax2),
        y: clamp(ringCy + Math.sin(rad) * radius, ay1, ay2),
        jitter,
        rot,
      });
    }
    // Hero-corner anchor seeds (top-corner utilization pass — see the
    // hero-montage policy block): for the FIRST FEW SUPPORTS, add fixed
    // anchors tucked into the hero's TOP CORNERS: x flanks the hero's top
    // half at CORNER_SEED_TUCK × the summed half-widths, y sits just under
    // the (padded) greeting-text strip with the support's top edge at it
    // (textZoneBottom + pad + supportHalfH — smaller ladder steps then only
    // move the box's top edge FURTHER from the strip, so the anchor stays
    // text-safe as it shrinks). One anchor per side at the brief's 0.55 tuck
    // (partially behind the hero edge, which renders on top) plus one
    // fully-outward anchor per side (tuck 1.0) that the per-cell ladder
    // resolves against the outer margin — measured, that second anchor is
    // the one that catches the largest feasible corner support. The polar
    // ring is radial and under-samples exactly this band; without these
    // anchors the hero's top corners stayed empty.
    // NOTE — deliberately NOT gated on the SPACE CHECK coverage (an earlier
    // draft gated them "until coverage picks up"): measured, the corner
    // slots are filled by the LATE, yielding supports (the early supports
    // place at their desired scale ≥ the floor in the roomy bottom band,
    // pushing coverage past SPACE_CHECK_COVERAGE before any support needs
    // the corners) — a coverage gate switched the anchors off exactly when
    // they were needed and measurably changed nothing. The rank cap is the
    // deterministic "first few supports" proxy.
    if (heroEntry && index <= CORNER_SEED_MAX_SUPPORT_RANK) {
      const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
      const stripBottom = opts.textZone
        ? opts.textZone.y + opts.textZone.h
        : TEXT_ZONE_FALLBACK_BOTTOM_FRAC * card.h;
      const heroHalfW =
        displayWidth(heroEntry.item, heroEntry.placement.scale, k) / 2;
      const supHalfW = displayWidth(item, baseScale, k) / 2;
      const supHalfH = displayHeight(item, baseScale, k) / 2;
      const cornerY = clamp(stripBottom + pad + supHalfH, ay1, ay2);
      for (const side of [-1, 1] as const) {
        for (const tuck of [CORNER_SEED_TUCK, 1] as const) {
          seeds.push({
            x: clamp(
              heroEntry.placement.x + side * (heroHalfW + supHalfW) * tuck,
              ax1,
              ax2,
            ),
            y: cornerY,
            jitter: 1,
            rot: 0,
          });
        }
      }
    }
    } // end else (non-hero candidates; hero has only the center seed)

    // Per cell: try scale fallback steps largest→smallest inside the cell;
    // the first (largest) scale whose candidate passes the hard constraints
    // (bounds + size + text rule + pairwise overlap) wins that cell. The
    // support floor (hero-montage) is applied as a hard clamp first; only
    // when NO cell yields a floored candidate does the retry without the
    // floor run (documented ladder resolution) — and, for few-item layouts,
    // ONLY when the SPACE CHECK says the card is actually crowded (coverage
    // ≥ SPACE_CHECK_COVERAGE) or the relaxation regime has already engaged
    // (desiredShrink < 1): while empty space remains the floor stays hard
    // (supports keep ≥ 0.5×hero; unplaceable-at-floor supports go to the
    // solveLayout relaxation which retries the ORDER before shrinking).
    // Large-n layouts (n > 5) keep the unconditional yield — there the floor
    // is a pure safety net (see the policy block).
    const runCells = (withFloor: boolean): Placement[] => {
      const out: Placement[] = [];
      // The ladder may fall all the way to the item's MIN-SIZE scale (not
      // just 0.7×desired): when the card is crowded (many supports around a
      // 0.65 hero), a support's desired scale is unreachable and its ladder
      // must bottom out at the (already relaxed) minimum legible size —
      // otherwise crowded supports get DROPPED instead of shrunk (measured:
      // 12/16 placed at n=16 before this).
      const minScale = scaleWindow(item, card, k, minSizePct).min;
      for (const seed of seeds) {
        for (const step of SCALE_FALLBACK_STEPS) {
          const raw = Math.max(baseScale * step * seed.jitter, minScale);
          const cand = makeCand(
            seed.x,
            seed.y,
            withFloor ? Math.max(raw, supportFloorScale) : raw,
            seed.rotLocked ? seed.rot : seed.rot * step,
          );
          if (ok(cand)) {
            out.push(cand);
            break;
          }
        }
      }
      return out;
    };
    let cands = runCells(true);
    if (cands.length === 0 && supportFloorScale > 0) {
      const floorMayYield =
        items.length > 5 ||
        desiredShrink < 1 ||
        usableAreaCoverage(placed, card, k, opts.textZone) >=
          SPACE_CHECK_COVERAGE;
      if (floorMayYield) cands = runCells(false);
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
      const shortfall = Math.max(0, 1 - p.scale / d);
      // Hero-montage: the hero's shortfall is weighted ×HERO_FIDELITY_WEIGHT
      // so the soft spacing term can never buy a smaller hero.
      s += p.itemId === heroId ? HERO_FIDELITY_WEIGHT * shortfall : shortfall;
    }
    // SUM, not mean: the per-item gradient (what the greedy/sweeps actually
    // compare between candidates) must not weaken as n grows, or items stop
    // reaching their desired scale exactly when the card gets busier.
    return s;
  };

  /**
   * Group-cohesion soft term (semantic-grouping pass — see the COHESION
   * weight doc above): same-group pairs pulled to near-touching
   * (1.15 × halfA+halfB), different-group pairs pushed apart beyond
   * 1.6 × halfA+halfB. Inactive without hints (no grouping info → the term
   * must not perturb the hint-less baseline layouts). "Cohesion pulls, the
   * constraint stops": whenever the pressure would push a pair past the 10%
   * SAT overlap cap, checkItem rejects the candidate and the cap wins.
   */
  const cohesion = (placements: Placement[]): number => {
    if (!hints || hints.groups.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i]!;
        const b = placements[j]!;
        const ga = grouped.get(a.itemId);
        const gb = grouped.get(b.itemId);
        if (!ga || !gb) continue; // no grouping info for this pair
        const rSum = halfExtentOf(a) + halfExtentOf(b);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (ga === gb) {
          const target = rSum * COHESION_TOUCH_FACTOR;
          if (d > target) s += (d - target) / target;
        } else {
          const sep = rSum * COHESION_SEPARATION_FACTOR;
          if (d < sep) s += (sep - d) / sep;
        }
      }
    }
    return s;
  };

  /**
   * Orientation-alignment soft term (semantic-grouping pass — see the
   * ORIENTATION weight doc above): each placed item with a resolvable
   * tiltToward target is penalized for the deviation between its rotation
   * and the direction toward the target (saturating at 30°). Evaluated over
   * the WHOLE placement set, so a hint whose target is placed later is still
   * enforced by the coordinate sweeps / objective.
   */
  const orientation = (placements: Placement[]): number => {
    if (!hints || (hints.hints?.length ?? 0) === 0) return 0;
    let s = 0;
    for (const p of placements) {
      const target = tiltTargetFor(p.itemId, placements);
      if (!target) continue;
      if (Math.hypot(target.x - p.x, target.y - p.y) < 1) continue; // on top of it
      const dev = Math.abs(norm180(p.rotation - angleDeg(p, target)));
      s += Math.min(1, dev / ORIENT_TOLERANCE_DEG);
    }
    return s;
  };

  /**
   * CORNER FILL soft term (top-corner utilization pass — solver-internal,
   * NOT part of scoreLayout, same mechanism as `fidelity`): the hero is
   * CENTERED, so its top corners — the x flanks beside the hero's top half,
   * y between the (padded) greeting-text strip and ≈ 45% of the card — are
   * prime empty space that the scoreLayout terms actively pull AWAY from
   * (focal pulls toward the composition centre, spacing prefers
   * centre-hugging placements). This term REWARDS placements whose AABB
   * covers corner-region area: the fraction of the flank region (left +
   * right of the placed hero's box, inside the safe margin, from the strip
   * bottom down to CORNER_REGION_Y2_FRAC × card height) covered by support
   * AABBs. Inactive until the hero is placed (always first in the greedy).
   * Weight tuned in CORNER_FILL_WEIGHT's doc: reorders sub-floor candidates
   * toward the corners without ever overriding the floor (fidelity wins
   * across floor boundaries) or the hard constraints (only feasible
   * candidates are ever scored).
   */
  const cornerFill = (placements: Placement[]): number => {
    const heroP = placements.find((p) => p.itemId === heroId);
    const heroItem = heroP ? itemsById.get(heroP.itemId) : undefined;
    if (!heroP || !heroItem) return 0;
    const hb = placedBox(heroP, heroItem, k);
    const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
    const stripBottom = opts.textZone
      ? opts.textZone.y + opts.textZone.h + pad
      : TEXT_ZONE_FALLBACK_BOTTOM_FRAC * card.h;
    const ry1 = Math.min(stripBottom, CORNER_REGION_Y2_FRAC * card.h);
    const ry2 = Math.max(stripBottom, CORNER_REGION_Y2_FRAC * card.h);
    const regionH = ry2 - ry1;
    if (!(regionH > 0)) return 0;
    const flankL = Math.max(0, hb.x1 - ax1);
    const flankR = Math.max(0, ax2 - hb.x2);
    const regionArea = (flankL + flankR) * regionH;
    if (!(regionArea > 0)) return 0;
    let covered = 0;
    for (const p of placements) {
      if (p.itemId === heroId) continue;
      const item = itemsById.get(p.itemId);
      if (!item) continue;
      const b = placedBox(p, item, k);
      const iy1 = Math.max(b.y1, ry1);
      const iy2 = Math.min(b.y2, ry2);
      if (!(iy2 > iy1)) continue;
      const ly = iy2 - iy1;
      covered +=
        Math.max(0, Math.min(b.x2, hb.x1) - Math.max(b.x1, ax1)) * ly +
        Math.max(0, Math.min(b.x2, ax2) - Math.max(b.x1, hb.x2)) * ly;
    }
    return Math.min(1, covered / regionArea);
  };

  /** Incremental score of `cand` + `item` against the already-placed set. */
  const incremental = (cand: Placement, item: LayoutItem, placed: Placed[]): number => {
    const placements = [cand, ...placed.map((p) => p.placement)];
    const ids = new Set(placements.map((p) => p.itemId));
    const subset = items.filter((i) => ids.has(i.id));
    const sctx: ScoreContext = { card, k, focalPoint, clustered };
    return (
      scoreLayout(placements, subset, sctx) +
      SCALE_FIDELITY_WEIGHT * fidelity(placements) +
      COHESION_WEIGHT * cohesion(placements) +
      ORIENTATION_WEIGHT * orientation(placements) -
      CORNER_FILL_WEIGHT * cornerFill(placements)
    );
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
    return (
      scoreLayout(placements, subset, sctx) +
      SCALE_FIDELITY_WEIGHT * fidelity(placements) +
      COHESION_WEIGHT * cohesion(placements) +
      ORIENTATION_WEIGHT * orientation(placements) -
      CORNER_FILL_WEIGHT * cornerFill(placements)
    );
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
    let scaleFloor =
      desiredScale !== undefined
        ? Math.min(p.placement.scale, desiredScale)
        : 0;
    // Hero-montage: non-hero items also keep the 0.5×hero floor through the
    // local search (measured against the hero's CURRENT scale).
    if (item.id !== heroId) {
      const heroEntry = placed.find((e) => e.item.id === heroId);
      if (heroEntry) {
        scaleFloor = Math.max(
          scaleFloor,
          (displayWidth(heroEntry.item, heroEntry.placement.scale, k) /
            (heroEntry.item.imgW * k)) *
            SUPPORT_HERO_FLOOR,
        );
      }
    }
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
      // USER DECISION: orientation disabled — nudge never rotates.
      rotation: 0,
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
      if (widest === narrowest) break;
      // Hero-montage: when the widest item IS the hero and every support
      // already clears the 0.5×hero floor, the width imbalance is INTENDED
      // (dominant hero) — do not shrink the hero to equalize. The undersized
      // trigger still fires so a starved support can grow.
      const heroIsWidest = placed[widest]!.item.id === heroId;
      const floorOk = wMin >= wMax * SUPPORT_HERO_FLOOR - 1e-9;
      if (
        !undersized &&
        (heroIsWidest ? floorOk : wMax <= wMin * REBALANCE_RATIO + 1e-9)
      ) {
        break;
      }
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
  const card = opts.cardDims;
  const k = opts.k ?? baseFit(card);
  let result = attemptSolve(items, opts, minSizePct, null);
  let relaxations = 0;
  // On retry, ALSO shrink supports' DESIRED scales (not just minSize):
  // lowering minSize alone doesn't help when the greedy commits early
  // supports at near-desired size and the card fills up — the stragglers
  // then find no room at ANY scale ≥ min (measured: 12/16 placed at n=16
  // before this). The hero keeps its full desired width (user rule).
  //
  // SPACE-AWARE FLOOR RESOLUTION (top-corner utilization pass): shrinking
  // used to kick in on EVERY retry — supports went below 0.5×hero even when
  // empty space remained. Now each relaxation step first runs a SPACE CHECK
  // (usableAreaCoverage of the failed attempt's placed set): while coverage
  // < SPACE_CHECK_COVERAGE the card is NOT crowded, so desired scales are
  // NOT shrunk; instead the placement ORDER is retried (reverseNonHero —
  // the smaller-weight late arrivals get FIRST pick of the empty space, the
  // hero still first; a one-shot pass, tracked by `reversedTried`). Only
  // when coverage ≥ SPACE_CHECK_COVERAGE (card actually crowded) OR the
  // reversed retry still leaves items unplaced does desiredShrink engage as
  // before (which also unlocks the floor's soft resolution in
  // candidatesFor — every space-preserving option is exhausted at that
  // point, so the hard constraints win as always).
  let desiredShrink = 1;
  let reversedTried = false;
  while (result.unplaced.length > 0 && relaxations < MAX_RELAXATIONS) {
    relaxations++;
    minSizePct = Math.max(MIN_SIZE_FLOOR_PCT, minSizePct - 1);
    const coverage = usableAreaCoverage(result.placed, card, k, opts.textZone ?? null);
    if (coverage < SPACE_CHECK_COVERAGE && !reversedTried) {
      // Space exists — do NOT shrink; give the starved late arrivals first
      // pick of it (hero still first).
      reversedTried = true;
      result = attemptSolve(items, opts, minSizePct, null, desiredShrink, true);
    } else {
      desiredShrink = Math.max(0.35, desiredShrink - 0.15);
      result = attemptSolve(items, opts, minSizePct, null, desiredShrink);
    }
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

  // Hero-montage zIndex: the hero renders TOPMOST (max orderIndex + 1);
  // supports keep their orderIndex (later submissions render above earlier
  // supports, always below the hero).
  const heroId = heroItemIdOf(items, opts.hints ?? null);
  const maxOrder = items.reduce((m, i) => Math.max(m, i.orderIndex), 0);
  const placements = result.placed
    .map((p) => ({
      ...p.placement,
      zIndex: p.item.id === heroId ? maxOrder + 1 : p.item.orderIndex,
    }))
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
