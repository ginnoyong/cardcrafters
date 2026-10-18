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
 *   5. Relaxation: if not everything fits OR the placed union coverage falls
 *      outside the COVERAGE BAND (65–80% of the usable canvas), the
 *      deterministic degradation ladder escalates (max 17 relaxations, minSize
 *      −1% per step, floor 3%), in this ORDER:
 *      (a) RATIO-ADJUST — coverage > 80%: the support ratio is lowered to
 *          0.5×hero and the solve re-run ONCE (deterministic); coverage <
 *          65%: the support ratio is raised to 0.6×hero (the hero's emergent
 *          size follows from the ratio — bigger supports ⇒ smaller hero);
 *      (b) SPACE CHECK + REVERSED-ORDER RETRY (while coverage < 0.75 the card
 *          is not crowded, so the placement order is retried once with the
 *          non-hero order reversed — smaller-weight late arrivals get first
 *          pick of the empty space, hero still first);
 *      (c) HERO SHRINK (last resort for placement) — the emergent hero width
 *          drops in 0.05 steps to the 0.25 floor while the [0.5, 0.6]×hero
 *          support band holds RELATIVE to the shrunk hero (supports never go
 *          below half the hero; the hero is what gives);
 *      (d) DESIRED SHRINK — once the hero is at its minimum, supports'
 *          desired scales shrink toward the band floor (clamped AT 0.5×hero —
 *          never below);
 *      (e) as a last resort the text-overlap rule is dropped for items beyond
 *          the first 20 (with a warning).
 *      Out-of-bounds placements are NEVER emitted: bounds and
 *      minSize are hard constraints — an item that still cannot fit is simply
 *      omitted from the result (also warned).
 *
 * zIndex = the item's orderIndex (later submissions render on top), EXCEPT
 * the HERO (see the hero-montage policy block) which renders topmost.
 */

import type { LayoutComposition, LayoutItemHint, Placement } from "@cardcrafters/shared";
import {
  MIN_ITEM_SIZE_PCT,
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
  /**
   * Final-montage relaxation multiplier for BOTH overlap caps (the pairwise
   * cap above AND the hero tuck cap — see
   * ConstraintCtx.overlapCapFactor): effective cap = cap × overlapCapFactor.
   * Only the final montage pass sets it (MONTAGE_OVERLAP_RELAX_FACTOR = 1.8
   * when the AI opts in via relaxOverlap); default (undefined) is factor 1 —
   * byte-identical behavior to the strict build-phase caps.
   */
  overlapCapFactor?: number;
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
 * whenever it tucks against a support (measured: the hero settled ~15% under
 * its target at n = 2 in v2). ×3 makes a hero shrink strictly
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
/**
 * v4 relaxation-ladder budget (see solveLayout): 1 ratio-adjust + 1
 * reversed-order retry + up to 10 hero-shrink steps (0.05 width each, floor
 * HERO_MIN_WIDTH = 0.25) + up to 5 desiredShrink steps (1 → 0.35) = 17.
 */
const MAX_RELAXATIONS = 17;
/**
 * v4 degradation ladder (escalation ORDER — see solveLayout and the header
 * doc): RATIO-ADJUST (support ratio toward the band edge, first lever) →
 * REVERSED-ORDER RETRY (space check) → HERO SHRINK (last resort for
 * placement; the emergent hero width drops by HERO_SHRINK_STEP per step,
 * floored at HERO_MIN_WIDTH, while the support band holds RELATIVE to the
 * shrunk hero) → DESIRED SHRINK (clamped AT the band floor) → TEXT-RULE
 * DROP.
 */
const HERO_SHRINK_STEP = 0.05;
const HERO_SHRINK_MAX_STEPS = 10;
/**
 * v4 hero width clamp (fraction of card width): the hero's desired size is
 * EMERGENT — solved from the coverage budget (see the sizing-policy doc and
 * emergentHeroWidth) — so these are SAFETY BOUNDS only, not policy targets
 * (the fixed 0.60 hero-width rule is DROPPED). The degradation ladder shrinks
 * the hero toward the minimum; the max keeps a solo card from painting edge
 * to edge.
 */
const HERO_MIN_WIDTH = 0.25;
const HERO_MAX_WIDTH = 0.75;
/**
 * v4 support RATIO BAND (display-WIDTH ratio, support/hero — "size" reads as
 * the displayed WIDTH per the user rule "non-focal stickers are between 50%
 * and 60% of the focal sticker's size"; the AREAS interpretation (√0.5–√0.6
 * linear ≈ 0.71–0.775) was considered and rejected as less faithful to the
 * wording). Every support's desired width sits in [0.5, 0.6] × the hero's
 * width — the hero clearly dominates while the supports stay consistent
 * siblings of each other (max sibling ratio 0.6/0.5 = 1.2). Equal-weight
 * supports sit at the MID 0.55; hint importance shifts a support WITHIN the
 * band (see supportDesiredRatio). Enforced as a hard clamp in desiredScales,
 * the candidate generator, the local search and the rebalance pass (where
 * feasible — the degradation ladder shrinks the HERO so the band follows it;
 * beyond the feasible-n the band can no longer fit and supports resolve
 * below it only through hero growth drift, measured in the solver tests).
 */
const SUPPORT_RATIO_MIN = 0.45; // USER: "ratio of non-hero to hero can be 20% smaller"
const SUPPORT_RATIO_MAX = 0.6;
const SUPPORT_RATIO_MID = 0.55;
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
 * Sizing policy v4 (layout hierarchy v4 — EMERGENT hero + support ratio band
 * + total-canvas coverage band):
 *
 * The FIXED hero width target (v3's 0.60×card width) is DROPPED: the hero's
 * desired size EMERGES from the coverage budget. With "size" = display
 * WIDTH, the support band says supportWidth ∈ [0.5, 0.6] × heroWidth (mid
 * 0.55 for equal weights — see the ratio-band doc above), so the TOTAL area
 * equation
 *
 *   heroW²·heroAspect + Σ_j (r_j·heroW)²·supAspect_j
 *     ≈ CANVAS_COVERAGE_TARGET × usableArea
 *
 * solves for the hero directly:
 *
 *   heroW = √(targetArea) / (cardW · √(heroAspect + Σ_j r_j²·supAspect_j))
 *
 * clamped to [HERO_MIN_WIDTH, HERO_MAX_WIDTH] = [0.25, 0.75] card width.
 * The hero's size therefore scales with the sticker COUNT: n = 1 fills the
 * budget (≈ 0.75 card width for a square on the default 5:7 card — the
 * usable-canvas 80% target ≈ 0.53 of the card area with the greeting zone),
 * while more stickers shrink the hero and keep every support a consistent
 * 0.55×hero sibling.
 *
 * Desired areas (see desiredScales): the REMAINING budget
 * (CANVAS_COVERAGE_TARGET × usableArea − heroArea) is split across the
 * supports (EQUALIZE_FRAC blend of a flat equal split and the
 * visualWeight-weighted split, as in v2/v3 — heavier supports get modestly
 * more), and each support's desired display width is clamped into the ratio
 * band [0.5, 0.6] × the hero's desired width.
 *
 * COVERAGE BAND: after the solve, the placed AABB-union coverage of the
 * usable canvas must land in [COVERAGE_BAND_MIN, COVERAGE_BAND_MAX] =
 * [0.65, 0.80] (the user rule "all stickers together fill 65% to 80% of the
 * canvas"); outside the band the degradation ladder's FIRST lever is the
 * support RATIO (raise toward 0.6 when underfull / lower toward 0.5 when
 * overfull) — see solveLayout. Feasibility: packing + the 10% SAT cap keep
 * the reachable union below the area budget, so the band is pinned per-n in
 * the solver tests ([0.62, 0.82] window for n ≤ feasible-n; the measured
 * shortfall beyond is documented there).
 */
const WEIGHT_FLOOR = 0.05; // keeps zero-weight items from getting a zero share
/**
 * Total USABLE-canvas fraction ALL stickers chase together (v3/v4 — see the
 * sizing-policy doc above). The usable canvas is the paintable region: card
 * minus safe margins, below the (padded) greeting-text strip.
 */
const CANVAS_COVERAGE_TARGET = 0.8;
/**
 * v4 COVERAGE BAND for the PLACED AABB-union coverage of the usable canvas
 * (usableAreaCoverage — the same measure as the space check): the user rule
 * "all stickers together fill 65% to 80% of the canvas". Below the band the
 * ladder RAISES the support ratio toward 0.6 (then the placement levers);
 * above it the ladder LOWERS the ratio toward 0.5 (one deterministic retry).
 * Packing + tuck-overlap keep the reachable union below the area budget, so
 * the per-n measured windows are pinned in the solver tests.
 */
const COVERAGE_BAND_MIN = 0.65;
const COVERAGE_BAND_MAX = 0.8;
/**
 * Size-equalization blend (0..1): the fraction of the support pool that comes
 * from the FLAT equal split rather than the visualWeight-weighted
 * split (see the sizing-policy doc above; 0 = pure weight split). 0.5
 * keeps a visible size hierarchy for very different weights while similar
 * weights land within ~1.25× of each other (tested).
 */
const EQUALIZE_FRAC = 0.5;

// ---------------------------------------------------------------------------
// Hero-montage policy (dominant hero + orbiting supports)
// ---------------------------------------------------------------------------
/**
 * Hero-montage sizing (layout hierarchy v4): the card's TOP-RANKED sticker
 * (the HERO) is CENTERED and sized at its EMERGENT width — solved from the
 * coverage budget via emergentHeroWidth (the fixed 0.60 target is DROPPED),
 * clamped to [0.25, 0.75] card width; the remaining stickers (SUPPORTS) fill
 * the canvas AROUND the hero and may tuck BEHIND it (hero–support pairs get
 * the deeper HERO_TUCK_CAP overlap; the hero renders on top). RATIO BAND at
 * every item count: every support's display width sits in
 * [SUPPORT_RATIO_MIN, SUPPORT_RATIO_MAX] = [0.5, 0.6] × the hero's width —
 * enforced as a hard clamp in desiredScales, the candidate generator, the
 * local search and the rebalance pass. When the band cannot fit, the HERO
 * yields instead — see the degradation ladder in solveLayout — and the band
 * follows the shrunk hero (it is measured against the hero's ACTUAL placed
 * scale). Only when even the minimum hero cannot make room do supports'
 * desired scales shrink toward the band floor (never below it) and, last,
 * items are dropped (warned).
 *
 * TOTAL-CANVAS COVERAGE BAND: all stickers together must land in
 * [0.65, 0.80] of the usable canvas (see the sizing-policy v4 doc); the
 * degradation ladder's first lever outside the band is the support RATIO.
 *
 * SPACE-AWARE ORDER RETRY: the relaxation ladder step AFTER the ratio-adjust
 * (see solveLayout) is gated by a SPACE CHECK: the placed AABB-union coverage
 * of the USABLE area (below the padded text strip, inside the safe margin,
 * sampled on a fixed grid — usableAreaCoverage below). While coverage <
 * SPACE_CHECK_COVERAGE (0.75) the card is not crowded, so the placement
 * ORDER is retried once with the non-hero order REVERSED (smaller-weight
 * late arrivals get first pick of the empty space, hero still first) before
 * the hero is shrunk.
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
 * at n = 4 is 0.46–0.81 (the yielding supports land in corner slots instead
 * of wherever the below-floor ladder happened to fit).
 *
 * HERO DESIGNATION: a hint with role:"focal" (the layout AI's
 * layout_composition output) designates the hero; absent a focal hint the
 * highest visualWeight wins (stable tie-break by orderIndex). Ranking runs
 * EVERY solve from the current hints + weights, so when a new sticker
 * arrives and the hints designate a different focal, the new sticker takes
 * the hero size and the previous hero resizes as a support — the solver
 * re-solves the whole card on every arrival.
 *
 * LARGE n: at large item counts the supports sit at their 0.5×hero band
 * floor and the hero-shrink ladder (solveLayout) sizes the hero so the
 * floor-sized supports fit; supports shrink WITH the hero, keeping the 0.5×
 * ratio (the band is measured against the hero's ACTUAL placed scale). The
 * measured hero curve is pinned in the solver tests.
 */
/**
 * SPACE CHECK threshold (space-aware order retry, see solveLayout): the
 * placed AABB-union coverage of the USABLE area (below the padded text
 * strip, inside the safe margin). Below this the card is NOT crowded and
 * the relaxation ladder's first step is the reversed-order retry (not a
 * shrink). Raised 0.70 → 0.75 to match the v3 total-coverage target
 * (CANVAS_COVERAGE_TARGET = 0.80): the check now asks "is the canvas ≥ ¾
 * full".
 */
const SPACE_CHECK_COVERAGE = 0.75;
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
 * The paintable region: card inside the safe margins, below the (2%-padded)
 * greeting-text strip. Shared by the coverage budget (desiredScales) and the
 * SPACE CHECK (usableAreaCoverage) so both measure the same canvas.
 */
function usableAreaRect(card: CardBox, textZone: Rect | null): Rect {
  const m = safeMargin(card);
  const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
  const y1 = Math.max(m.y, textZone ? textZone.y + textZone.h + pad : 0);
  return {
    x: m.x,
    y: y1,
    w: card.w - 2 * m.x,
    h: card.h - m.y - y1,
  };
}

/**
 * Support-ratio mode for one solve attempt (v4 degradation ladder): "mid" is
 * the normal solve (equal-weight supports at 0.55, importance shifts within
 * the band); "max" RAISES every support toward 0.6×hero (underfull coverage
 * response); "min" LOWERS every support to 0.5×hero (overfull coverage
 * response). Deterministic — see solveLayout.
 */
type RatioMode = "mid" | "max" | "min";

/**
 * Desired support ratio (support/hero display-WIDTH ratio) for one support
 * under `mode`: "max"/"min" pin the band edges; "mid" starts at 0.55 and
 * shifts WITHIN the band with relative importance — t = eff/meanEff, shift =
 * clamp(t − 1, −1, 1), ratio = 0.55 + 0.05·shift (equal weights → exactly
 * the mid; a support at twice the mean importance → 0.6; at half → 0.5).
 */
function supportDesiredRatio(eff: number, meanEff: number, mode: RatioMode): number {
  if (mode === "max") return SUPPORT_RATIO_MAX;
  if (mode === "min") return SUPPORT_RATIO_MIN;
  const t = meanEff > 0 ? eff / meanEff : 1;
  const shift = Math.max(-1, Math.min(1, t - 1));
  return Math.min(
    SUPPORT_RATIO_MAX,
    Math.max(SUPPORT_RATIO_MIN, SUPPORT_RATIO_MID + 0.05 * shift),
  );
}

/** Clamp helper (solver-local, same semantics as the one in attemptSolve). */
function clampFrac(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * EMERGENT hero width (v4 — see the sizing-policy doc): the hero's desired
 * display width (as a fraction of card width) solved from the coverage
 * budget. With supports pinned to the ratio band (display-WIDTH ratios r_j),
 * the total area equation
 *   (heroW·cardW)²·heroAspect + Σ_j (r_j·heroW·cardW)²·supAspect_j
 *     = CANVAS_COVERAGE_TARGET × usableArea
 * gives heroW = √targetArea / (cardW·√(heroAspect + Σ_j r_j²·supAspect_j)),
 * clamped to [HERO_MIN_WIDTH, HERO_MAX_WIDTH] and reduced by the degradation
 * ladder's shrink steps (floored at HERO_MIN_WIDTH). n = 1 (no supports)
 * fills the budget alone — the former SOLO_ITEM_COVERAGE solo curve is
 * unified into this formula (the fixed hero target is dropped).
 */
function emergentHeroWidth(
  heroItem: LayoutItem,
  supports: readonly LayoutItem[],
  eff: readonly number[],
  card: CardBox,
  usableArea: number,
  mode: RatioMode,
  shrinkSteps: number,
): number {
  const targetArea = CANVAS_COVERAGE_TARGET * usableArea;
  const heroAspect = heroItem.imgH / heroItem.imgW;
  const meanEff =
    supports.length > 0
      ? eff.reduce((s, w) => s + w, 0) / supports.length
      : 1;
  let denom = heroAspect;
  supports.forEach((s, i) => {
    const r = supportDesiredRatio(eff[i] ?? 0, meanEff, mode);
    denom += r * r * (s.imgH / s.imgW);
  });
  const raw = Math.sqrt(targetArea) / (card.w * Math.sqrt(denom));
  const clamped = clampFrac(raw, HERO_MIN_WIDTH, HERO_MAX_WIDTH);
  return Math.max(HERO_MIN_WIDTH, clamped - shrinkSteps * HERO_SHRINK_STEP);
}

/**
 * Desired display scale per item under the v4 emergent-hero + ratio-band
 * policy (see the sizing-policy doc above). Returns itemId → scale (already
 * clamped to the size window) plus the attempt's emergent hero width
 * fraction (the caller reuses it for the desiredShrink band floor).
 */
function desiredScales(
  ordered: LayoutItem[],
  card: CardBox,
  k: number,
  minSizePct: number,
  /** Area of the usable canvas (see usableAreaRect) — the coverage budget's
   *  denominator. */
  usableArea: number,
  /** This attempt's support-ratio mode (see RatioMode) — the degradation
   *  ladder raises ("max") / lowers ("min") the band on coverage excursions. */
  ratioMode: RatioMode,
  /** This attempt's hero shrink steps (see emergentHeroWidth). */
  heroShrinkSteps: number,
  /** Optional itemId → importance (0..1 hint) overriding visualWeight in the
   *  support split — hint importance orders size WITHIN a group so the
   *  group's focal item gets the larger share (equalization blend unchanged). */
  weightOverride?: Map<string, number>,
): { scales: Map<string, number>; heroWidthFrac: number } {
  const n = ordered.length;
  const eff = ordered.map((i) => {
    const o = weightOverride?.get(i.id);
    return o !== undefined ? Math.max(o, 0) : Math.max(i.visualWeight, WEIGHT_FLOOR);
  });
  const map = new Map<string, number>();
  const heroItem = ordered[0]!;
  // EMERGENT hero width (v4): solved from the coverage budget given the
  // support ratio band — the hero's size is whatever makes the composition
  // fit the [0.65, 0.80] coverage band, not a fixed target.
  const heroWidthFrac = emergentHeroWidth(
    heroItem,
    ordered.slice(1),
    eff.slice(1),
    card,
    usableArea,
    ratioMode,
    heroShrinkSteps,
  );
  const heroDesiredWidth = heroWidthFrac * card.w;
  // Remaining canvas-coverage budget after the hero's committed area, split
  // across the supports (see the sizing-policy doc above).
  const heroDesiredArea =
    (heroDesiredWidth * heroDesiredWidth * heroItem.imgH) / heroItem.imgW;
  const supportPool = Math.max(
    0,
    CANVAS_COVERAGE_TARGET * usableArea - heroDesiredArea,
  );
  const nS = n - 1;
  const sumS = eff.slice(1).reduce((s, w) => s + w, 0);
  for (let i = 0; i < n; i++) {
    const item = ordered[i]!;
    if (i === 0) {
      // Rank 0 IS the hero (heroItemIdOf decides; `ordered` is already
      // re-ranked hero-first by the caller).
      map.set(
        item.id,
        scaleFor(item, card, k, heroDesiredWidth / (item.imgW * k), minSizePct),
      );
      continue;
    }
    // Size equalization: blend the visualWeight-weighted split 50/50 with a
    // flat equal split of the support pool (EQUALIZE_FRAC; WEIGHT_FLOOR
    // unchanged). Both splits spend the whole pool, so the blend preserves
    // the policy total — only its distribution changes.
    const share = EQUALIZE_FRAC / nS + (1 - EQUALIZE_FRAC) * (eff[i]! / sumS);
    const desiredArea = supportPool * share;
    let desiredWidth = Math.sqrt((desiredArea * item.imgW) / item.imgH);
    // v4 RATIO BAND: supports sit in [0.5, 0.6] × the hero's desired width —
    // clearly dominant hero, consistent siblings (see the ratio-band doc).
    desiredWidth = clampFrac(
      desiredWidth,
      SUPPORT_RATIO_MIN * heroDesiredWidth,
      SUPPORT_RATIO_MAX * heroDesiredWidth,
    );
    map.set(
      item.id,
      scaleFor(item, card, k, desiredWidth / (item.imgW * k), minSizePct),
    );
  }
  return { scales: map, heroWidthFrac };
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

interface Placed {
  item: LayoutItem;
  placement: Placement;
}

/**
 * SPACE CHECK (v3 — see the hero-montage policy block): placed AABB-union
 * coverage of the USABLE area, i.e. the card inside the safe margin and
 * BELOW the (2%-padded) greeting-text strip — the region the solver can
 * actually paint. Sampled on a fixed COVERAGE_GRID grid (pure +
 * deterministic; placement x/y ARE the centroids). Used by the relaxation
 * ladder to decide (a) whether the placement ORDER is retried (reversed)
 * before the hero shrinks and (b) whether the canvas is crowded; the
 * solver's coverage budget uses usableAreaRect directly.
 */
function usableAreaCoverage(
  placed: readonly Placed[],
  card: CardBox,
  k: number,
  textZone: Rect | null,
): number {
  if (placed.length === 0) return 0;
  const ua = usableAreaRect(card, textZone);
  const ux1 = ua.x;
  const ux2 = ua.x + ua.w;
  const uy1 = ua.y;
  const uy2 = ua.y + ua.h;
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
 * illegally). `desiredShrink` lowers supports' desired scales (clamped AT
 * the 0.5×hero band floor); `ratioMode` sets this attempt's support-ratio
 * position ("max"/"min" — the coverage-band lever) and `heroShrinkSteps`
 * the hero-shrink ladder depth (both feed the EMERGENT hero width — see
 * emergentHeroWidth).
 */
function attemptSolve(
  items: LayoutItem[],
  opts: SolveOptions,
  minSizePct: number,
  dropTextBeyond: number | null,
  desiredShrink = 1,
  reverseNonHero = false,
  ratioMode: RatioMode = "mid",
  heroShrinkSteps = 0,
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
    // Final montage pass only (undefined → factor 1, unchanged caps).
    overlapCapFactor: opts.overlapCapFactor,
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

  // v4 desired scales (sizing policy — see the block comment above). Seeds
  // the candidate scale jitter. Hint importance (when present) overrides
  // visualWeight in the support split. The coverage budget is measured on
  // the USABLE canvas (card minus margins, below the padded text strip); the
  // hero width EMERGES from it (fixed target dropped).
  const ua = usableAreaRect(card, opts.textZone);
  const usableArea = ua.w > 0 && ua.h > 0 ? ua.w * ua.h : card.w * card.h;
  const { scales: rawDesired, heroWidthFrac: heroWidthFracDesired } = desiredScales(
    ordered,
    card,
    k,
    minSizePct,
    usableArea,
    ratioMode,
    heroShrinkSteps,
    importanceOverride.size > 0 ? importanceOverride : undefined,
  );
  // Relaxation shrink: supports' desired scales shrink TOWARD the 0.5×hero
  // band floor, never below it (v4: the band holds at every stage — the HERO
  // is what yields, see solveLayout's ladder). The hero keeps its full
  // desired width. (heroId is already computed above from the same ordered
  // list + hints.)
  const bandFloorWidth = SUPPORT_RATIO_MIN * heroWidthFracDesired * card.w;
  const desired = new Map(
    [...rawDesired].map(([id, s]) => {
      if (id === heroId) return [id, s] as const;
      const it = ordered.find((o) => o.id === id);
      const floorScale = it ? bandFloorWidth / (it.imgW * k) : 0;
      return [id, Math.max(s * desiredShrink, floorScale)] as const;
    }),
  );

  const itemsById = new Map(items.map((i) => [i.id, i] as const));

  /**
   * v4 support RATIO BAND ([SUPPORT_RATIO_MIN, SUPPORT_RATIO_MAX] × the
   * hero's ACTUAL placed scale) as {min, max} SCALES for `item` — null when
   * the hero is not (yet) placed or `item` IS the hero. Enforced hard
   * everywhere: candidate generation, local search and the rebalance pass
   * (see the hero-montage policy block).
   */
  const bandScaleFor = (
    item: LayoutItem,
    placedSet: Placed[],
  ): { min: number; max: number } | null => {
    if (item.id === heroId) return null;
    const heroEntry = placedSet.find((p) => p.item.id === heroId);
    if (!heroEntry) return null;
    const heroW = displayWidth(heroEntry.item, heroEntry.placement.scale, k);
    const unit = item.imgW * k;
    return {
      min: (SUPPORT_RATIO_MIN * heroW) / unit,
      max: (SUPPORT_RATIO_MAX * heroW) / unit,
    };
  };

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

    // Hero-montage support RATIO BAND: a non-hero candidate's scale is
    // clamped INTO [0.5, 0.6] × the hero's ACTUAL placed scale (hard clamp —
    // see the policy doc; when no cell fits the floored scale the support
    // stays unplaced and the relaxation ladder shrinks the HERO instead;
    // the 0.6×hero CEILING keeps a support from outgrowing the band when the
    // hero placed below its desired width).
    const heroEntry = placed.find((p) => p.item.id === heroId);
    const supportBand = bandScaleFor(item, placed);

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
    // v4: the hero's scale is POLICY (the emergent desired width — the size
    // that makes the composition fit the coverage budget), so the per-seed
    // SCALE jitter is disabled for the hero (jitter 1; the draw still runs
    // to keep the seeded sequence per-candidate uniform). Without this, the
    // ±8% scale jitter placed the hero up to 8% above its desired width and
    // the support band (measured vs the hero's PLACED scale) drifted to
    // 0.46×hero (measured 0.450 at mixed n=10).
    if (index === 0) {
      const jitter0 = SCALE_JITTER_MIN + rng() * (SCALE_JITTER_MAX - SCALE_JITTER_MIN);
      seeds.push({ x: card.w / 2, y: card.h / 2, jitter: 1, rot: 0 });
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
    // support RATIO BAND (hero-montage) is applied as a HARD clamp: every
    // candidate is forced into [0.5, 0.6] × the hero's ACTUAL placed scale
    // (the former space-check-gated / n > 5 no-floor retry is retired): when
    // no cell fits the floored scale, the support stays unplaced and the
    // relaxation ladder shrinks the HERO instead — the band follows the
    // shrunk hero (it is measured against the hero's ACTUAL placed scale;
    // see solveLayout). Only in the final desiredShrink stage — after the
    // hero is already at its minimum — does the desired (and with it the
    // ladder's start point) drop TOWARD the band floor, and supports that
    // still cannot fit at the floor go to the drop path (warned).
    const runCells = (): Placement[] => {
      const out: Placement[] = [];
      // The ladder may fall all the way to the item's MIN-SIZE scale (not
      // just 0.7×desired): when the card is crowded (many supports around
      // the hero), a support's desired scale is unreachable and its ladder
      // must bottom out at the (already relaxed) minimum legible size —
      // otherwise crowded supports get DROPPED instead of shrunk (measured:
      // 12/16 placed at n=16 before this).
      const minScale = scaleWindow(item, card, k, minSizePct).min;
      for (const seed of seeds) {
        for (const step of SCALE_FALLBACK_STEPS) {
          const raw = Math.max(baseScale * step * seed.jitter, minScale);
          // v4 band clamp: into [0.5, 0.6] × hero placed (no-op while the
          // hero is not yet placed — band is null then).
          const s = supportBand
            ? Math.min(Math.max(raw, supportBand.min), supportBand.max)
            : raw;
          const cand = makeCand(
            seed.x,
            seed.y,
            s,
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
    return runCells();
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
    // Hero-montage: non-hero items also keep the [0.5, 0.6]×hero RATIO BAND
    // through the local search (measured against the hero's CURRENT scale) —
    // the floor lifts sub-band supports back toward the band and the CEILING
    // shrinks over-band ones (v4).
    let scaleCeil = Infinity;
    if (item.id !== heroId) {
      const band = bandScaleFor(item, placed);
      if (band) {
        scaleFloor = Math.max(scaleFloor, band.min);
        scaleCeil = Math.max(band.max, scaleFloor);
      }
    }
    const moved: Placement = {
      ...p.placement,
      x: p.placement.x + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.w,
      y: p.placement.y + (rng() * 2 - 1) * POS_NUDGE_FRAC * card.h,
      scale: Math.min(
        Math.max(
          scaleFloor,
          scaleFor(
            item,
            card,
            k,
            p.placement.scale * (1 + (rng() * 2 - 1) * SCALE_NUDGE_FRAC),
            minSizePct,
          ),
        ),
        scaleCeil,
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
      // v4: the pair is picked among SUPPORTS only — the hero is sized by the
      // coverage budget and yields only in solveLayout's ladder, never here.
      const supIdx: number[] = [];
      for (let i = 0; i < placed.length; i++) {
        if (placed[i]!.item.id !== heroId) supIdx.push(i);
      }
      if (supIdx.length < 2) break;
      let widest = supIdx[0]!;
      let narrowest = supIdx[0]!;
      for (const i of supIdx) {
        if (widthFrac(placed[i]!) > widthFrac(placed[widest]!)) widest = i;
        if (widthFrac(placed[i]!) < widthFrac(placed[narrowest]!)) narrowest = i;
      }
      const wMax = widthFrac(placed[widest]!);
      const wMin = widthFrac(placed[narrowest]!);
      // Trigger the refinement pass when the narrow item sits ≥0.02 below
      // its own desired WIDTH (a balanced-but-undersized pair must also
      // attempt co-replacement, else it never grows back to its per-item
      // width target), when a support sits OUTSIDE the ratio band (the
      // widest/narrowest repair now targets the BAND EDGES: an above-band
      // widest shrinks toward 0.6×hero, a below-band narrowest grows toward
      // 0.5×hero), or when the siblings are imbalanced.
      const narrowDesiredScale = desired.get(placed[narrowest]!.item.id);
      const narrowDesiredW =
        narrowDesiredScale !== undefined
          ? displayWidth(placed[narrowest]!.item, narrowDesiredScale, k) / card.w
          : undefined;
      const undersized =
        narrowDesiredW !== undefined && wMin < narrowDesiredW - 0.02;
      const heroEntryRb = placed.find((p) => p.item.id === heroId);
      const heroWfRb = heroEntryRb ? widthFrac(heroEntryRb) : null;
      const aboveBand =
        heroWfRb !== null && wMax / heroWfRb > SUPPORT_RATIO_MAX + 1e-9;
      const belowBand =
        heroWfRb !== null && wMin / heroWfRb < SUPPORT_RATIO_MIN - 1e-9;
      if (widest === narrowest) break;
      if (
        !undersized &&
        !aboveBand &&
        !belowBand &&
        wMax <= wMin * REBALANCE_RATIO + 1e-9
      ) {
        break;
      }
      const wideEntry = placed[widest]!;
      const narrowEntry = placed[narrowest]!;
      const others = placed.filter((_, i) => i !== widest && i !== narrowest);
      const currentObj = objective(placed.map((p) => p.placement));
      let best: { wide: Placement; narrow: Placement; obj: number } | null = null;
      for (const f of REBALANCE_LADDER) {
        const trialScaleBase = scaleFor(
          wideEntry.item,
          card,
          k,
          wideEntry.placement.scale * f,
          minSizePct,
        );
        // v4: a SUPPORT's trial scale is clamped INTO the [0.5, 0.6]×hero
        // band (measured vs the hero's ACTUAL placed scale — see the
        // hero-montage policy block). Clamping to the band CEILING is what
        // targets the band edge: an above-band widest support walks down to
        // 0.6×hero even at f = 1; the ladder's lower rungs keep exploring.
        const bandHere = bandScaleFor(wideEntry.item, placed);
        const trialScale = bandHere
          ? Math.min(Math.max(trialScaleBase, bandHere.min), bandHere.max)
          : trialScaleBase;
        // Skip rungs that would GROW the wide item (the ladder only shrinks
        // or re-places at equal size); f = 1 stays — re-placing BOTH items at
        // full scale in fresh spots is the compound move that finds the
        // corner-bump arrangements pure single-item moves cannot reach (the
        // narrow item can only grow when the wide one steps aside). The band
        // clamp may LOWER f = 1 below the current scale — that is exactly
        // the above-band repair and must NOT be skipped.
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
  // v4 ladder state (escalation ORDER — see the header doc and the policy
  // blocks): ratio-adjust → reversed-order retry → hero-shrink steps →
  // desiredShrink → text-rule drop.
  let ratioMode: RatioMode = "mid";
  let heroShrinkSteps = 0;
  let desiredShrink = 1;
  let reversedTried = false;
  let ratioRaised = false;
  let ratioLowered = false;
  let reverseNext = false;
  let result = attemptSolve(items, opts, minSizePct, null, desiredShrink, false, ratioMode, heroShrinkSteps);
  let relaxations = 0;
  // v4 DEGRADATION LADDER — drives BOTH the placement (unplaced items) and
  // the COVERAGE BAND ([0.65, 0.80] usable-union coverage; the user rule
  // "all stickers together fill 65% to 80% of the canvas"):
  //   1. RATIO-ADJUST (first lever): coverage > COVERAGE_BAND_MAX → the
  //      support ratio LOWERS to 0.5×hero and the solve re-runs ONCE
  //      (deterministic; the emergent hero compensates by growing — same
  //      budget, different split). coverage < COVERAGE_BAND_MIN → the
  //      support ratio RAISES to 0.6×hero (bigger supports pack better and
  //      the hero yields room).
  //   2. SPACE CHECK (usableAreaCoverage of the failed attempt's placed set):
  //      while coverage < SPACE_CHECK_COVERAGE the card is NOT crowded, so
  //      nothing shrinks; instead the placement ORDER is retried once
  //      (reverseNonHero — the smaller-weight late arrivals get FIRST pick of
  //      the empty space, the hero still first; one-shot, tracked by
  //      `reversedTried`).
  //   3. HERO SHRINK (last resort for placement): the emergent hero width
  //      drops by HERO_SHRINK_STEP per step down to HERO_MIN_WIDTH. The
  //      [0.5, 0.6]×hero support band holds RELATIVE to the shrunk hero (it
  //      is measured against the hero's ACTUAL placed scale), so supports
  //      never go below half the hero — the band is what HOLDS, the hero is
  //      what gives.
  //   4. DESIRED SHRINK (hero already at its minimum): supports' desired
  //      scales shrink toward the band floor (clamped AT 0.5×hero — never
  //      below it; the candidate clamp keeps every support ≥ 0.5×hero) and
  //      minSize keeps relaxing. Whatever still cannot fit at the floor goes
  //      to the drop path below.
  const heroItem = items.find((i) => i.id === heroItemIdOf(items, opts.hints ?? null));
  while (relaxations < MAX_RELAXATIONS) {
    const unplaced = result.unplaced.length > 0;
    const coverage = usableAreaCoverage(result.placed, card, k, opts.textZone ?? null);
    const heroPlaced = result.placed.find((p) => p.item.id === heroItem?.id);
    const heroWfrac =
      heroPlaced && heroItem
        ? displayWidth(heroItem, heroPlaced.placement.scale, k) / card.w
        : 0;
    if (coverage > COVERAGE_BAND_MAX + 1e-9 && !ratioLowered) {
      // Overfull canvas: lower the support ratio toward 0.5 (one retry).
      ratioLowered = true;
      ratioMode = "min";
    } else if (coverage < COVERAGE_BAND_MIN - 1e-9 && !ratioRaised) {
      // Underfull canvas: raise the support ratio toward 0.6.
      ratioRaised = true;
      ratioMode = "max";
    } else if (unplaced && coverage < SPACE_CHECK_COVERAGE && !reversedTried) {
      // Space exists — do NOT shrink; give the starved late arrivals first
      // pick of it (hero still first).
      reversedTried = true;
      reverseNext = true;
    } else if (
      unplaced &&
      heroShrinkSteps < HERO_SHRINK_MAX_STEPS &&
      heroWfrac > HERO_MIN_WIDTH + 1e-9
    ) {
      // The hero yields (progressive shrink); the band holds relative to the
      // shrunk hero.
      heroShrinkSteps++;
    } else if (unplaced && desiredShrink > 0.35 + 1e-9) {
      desiredShrink = Math.max(0.35, desiredShrink - 0.15);
    } else {
      break;
    }
    relaxations++;
    minSizePct = Math.max(MIN_SIZE_FLOOR_PCT, minSizePct - 1);
    result = attemptSolve(items, opts, minSizePct, null, desiredShrink, reverseNext, ratioMode, heroShrinkSteps);
    reverseNext = false;
  }
  if (relaxations > 0 && minSizePct < MIN_ITEM_SIZE_PCT) {
    warnings.push(`relaxed min item size to ${minSizePct}% of card width`);
  }
  if (heroShrinkSteps > 0) {
    const heroPlacedFinal = result.placed.find((p) => p.item.id === heroItem?.id);
    const heroWfracFinal =
      heroPlacedFinal && heroItem
        ? displayWidth(heroItem, heroPlacedFinal.placement.scale, k) / card.w
        : HERO_MIN_WIDTH;
    warnings.push(
      `hero width target relaxed to ${(heroWfracFinal * 100).toFixed(0)}% of card width`,
    );
  }

  // Last resort: drop the text-overlap rule for items beyond the first 20.
  if (result.unplaced.length > 0 && items.length > TEXT_RULE_DROP_LIMIT) {
    warnings.push(
      `text-overlap rule dropped for items beyond the first ${TEXT_RULE_DROP_LIMIT}`,
    );
    result = attemptSolve(items, opts, minSizePct, TEXT_RULE_DROP_LIMIT, desiredShrink, false, ratioMode, heroShrinkSteps);
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
