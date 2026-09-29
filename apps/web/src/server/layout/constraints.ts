/**
 * Layout constraints (build-phase step 3) — PURE geometry over the normalized
 * card coordinate space (see CARD_COORD_SPACE = 1000 in shared constants).
 *
 * Space: x grows right, y grows down. Every placement (Placement in types.ts)
 * is the CENTER of the item in the normalized space; the card itself is fitted
 * into the 0..1000 × 0..1000 square preserving its aspect ratio, anchored at
 * the origin (see cardBox). All sizes below are in these normalized units.
 *
 * Sizing model: an item's DISPLAY size is (imgW, imgH) × scale × k where
 *   k = (BASE_COVERAGE × min(card.w, card.h)) / REF_SIZE
 * so that a 256px reference sticker (REF_SIZE) at scale 1 covers ~25% of the
 * card's min dimension. k is a parameter everywhere (`baseFit` computes the
 * default) so tests and future UI can retune the global sticker size without
 * touching the solver.
 *
 * Everything here is deterministic and side-effect free — the solver, scorer
 * and tests all sit on these primitives.
 */

import {
  CARD_COORD_SPACE,
  MAX_ITEM_SIZE_PCT,
  MAX_PAIRWISE_OVERLAP,
  MIN_ITEM_SIZE_PCT,
  SAFE_MARGIN_PCT,
  type Placement,
  type ContentBox,
} from "@cardcrafters/shared";

/** A card fitted into the coordinate space: {w, h} normalized units. */
export interface CardBox {
  w: number;
  h: number;
}

/** Axis-aligned rectangle (top-left + size) in normalized units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned bounding box (corners) in normalized units. */
export interface Aabb {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The layout-relevant slice of an item row. `imgW/imgH` are the SOURCE image
 * pixel dimensions (Item.width/height); `visualWeight` is the 0..1 heuristic
 * from image/weight.ts; `orderIndex` is the item's position in createdAt
 * order (drives zIndex + deterministic tie-breaks); `subject` is the
 * normalized_subject from prompt validation (semantic grouping input —
 * forwarded to the layout_composition AI task by the engine, unused by the
 * pure solver).
 */
export interface LayoutItem {
  id: string;
  imgW: number;
  imgH: number;
  visualWeight: number;
  orderIndex: number;
  subject?: string;
  /** Visible-artwork bbox in frame px (optional; for tighter collision). */
  contentBox?: ContentBox;
}

// ---------------------------------------------------------------------------
// Sizing model
// ---------------------------------------------------------------------------

/** Reference sticker size in source px (a 256px mock sticker at scale 1). */
export const REF_SIZE = 256;
/** Fraction of the card's min dimension a REF_SIZE sticker covers at scale 1. */
export const BASE_COVERAGE = 0.25;

/**
 * Fit a card with aspect ratio ratioW:ratioH into a dims×dims-ish canvas
 * (the caller passes the coordinate space), preserving aspect, anchored at
 * (0,0). For the default 5:7 card: {w: 714.28…, h: 1000}.
 */
export function cardBox(
  dims: { width: number; height: number },
  ratioW: number,
  ratioH: number,
): CardBox {
  if (!(ratioW > 0) || !(ratioH > 0)) {
    throw new Error(`cardBox: invalid ratio ${ratioW}:${ratioH}`);
  }
  const s = Math.min(dims.width / ratioW, dims.height / ratioH);
  return { w: ratioW * s, h: ratioH * s };
}

/** Default k for a card (see module doc): BASE_COVERAGE × minDim / REF_SIZE. */
export function baseFit(card: CardBox): number {
  return (BASE_COVERAGE * Math.min(card.w, card.h)) / REF_SIZE;
}

/** Unrotated display width of an item at the given scale (normalized units). */
export function displayWidth(item: LayoutItem, scale: number, k: number): number {
  return item.imgW * scale * k;
}

/** Unrotated display height of an item at the given scale (normalized units). */
export function displayHeight(item: LayoutItem, scale: number, k: number): number {
  return item.imgH * scale * k;
}

/**
 * Axis-aligned bounding box of the ROTATED item. `rotation` is in degrees;
 * the item's unrotated box is centered at (placement.x, placement.y). The
 * AABB of a rotated rect OVERESTIMATES the visual footprint — that is
 * intentional (collision-safe) for bounds and text avoidance, which must
 * never clip. Pairwise OVERLAP, however, is measured on the true rotated
 * rectangles (see rotatedRectOverlapArea): with an AABB measure, two
 * rotated stickers punish each other for corner-bounding-box area that
 * does not actually intersect, which used to force them much smaller than
 * the card allows.
 */
export function placedBox(
  placement: Pick<Placement, "x" | "y" | "rotation" | "scale">,
  item: LayoutItem,
  k: number,
): Aabb {
  const w = displayWidth(item, placement.scale, k) / 2;
  const h = displayHeight(item, placement.scale, k) / 2;
  const rad = (placement.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  // Half-extents of the rotated rect's AABB.
  const hx = w * c + h * s;
  const hy = w * s + h * c;
  return {
    x1: placement.x - hx,
    y1: placement.y - hy,
    x2: placement.x + hx,
    y2: placement.y + hy,
  };
}

/** Center of an AABB (used as the placement centroid by the scorer). */
export function boxCenter(box: Aabb): { x: number; y: number } {
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
}

/** Area of an AABB. */
export function boxArea(box: Aabb): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

/** Intersection of two AABBs (empty → zero area, never negative). */
export function boxIntersection(a: Aabb, b: Aabb): Aabb {
  return {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
}

// ---------------------------------------------------------------------------
// Margins + size windows
// ---------------------------------------------------------------------------

/** Safe margin (normalized units) per axis: SAFE_MARGIN_PCT% of that axis. */
export function safeMargin(card: CardBox): { x: number; y: number } {
  return {
    x: (SAFE_MARGIN_PCT / 100) * card.w,
    y: (SAFE_MARGIN_PCT / 100) * card.h,
  };
}

/**
 * Scale window [min, max] that keeps the item's UNROTATED display width
 * within [minSizePct, MAX_ITEM_SIZE_PCT]% of the card width.
 */
export function scaleWindow(
  item: LayoutItem,
  card: CardBox,
  k: number,
  minSizePct: number = MIN_ITEM_SIZE_PCT,
): { min: number; max: number } {
  const unit = item.imgW * k;
  if (!(unit > 0)) return { min: 1, max: 1 };
  return {
    min: ((minSizePct / 100) * card.w) / unit,
    max: ((MAX_ITEM_SIZE_PCT / 100) * card.w) / unit,
  };
}

/**
 * Clamp a scale (or pick the geometric middle of the window when omitted) so
 * the item's display width satisfies the min/max size constraints.
 */
export function scaleFor(
  item: LayoutItem,
  card: CardBox,
  k: number,
  scale?: number,
  minSizePct: number = MIN_ITEM_SIZE_PCT,
): number {
  const { min, max } = scaleWindow(item, card, k, minSizePct);
  if (scale === undefined) return Math.sqrt(min * max);
  return Math.min(max, Math.max(min, scale));
}

// ---------------------------------------------------------------------------
// Individual predicates
// ---------------------------------------------------------------------------

/** (a) Is an AABB inside the card minus the safe margin (per axis)? */
export function inBoundsOk(box: Aabb, card: CardBox): boolean {
  const m = safeMargin(card);
  return (
    box.x1 >= m.x &&
    box.y1 >= m.y &&
    box.x2 <= card.w - m.x &&
    box.y2 <= card.h - m.y
  );
}

/** (b) Unrotated display width within [minSizePct, MAX_ITEM_SIZE_PCT]% of card width. */
export function sizeOk(
  item: LayoutItem,
  scale: number,
  card: CardBox,
  k: number,
  minSizePct: number = MIN_ITEM_SIZE_PCT,
): boolean {
  const w = displayWidth(item, scale, k);
  return (
    w >= (minSizePct / 100) * card.w - 1e-9 &&
    w <= (MAX_ITEM_SIZE_PCT / 100) * card.w + 1e-9
  );
}

/** Padding around the text zone: 2% of the card's min dimension, per side. */
export const TEXT_ZONE_PAD_FRAC = 0.02;

/** Inflate a rect by `pad` on every side. */
export function inflate(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** (c) AABB must not intersect the (2%-inflated) greeting text zone. */
export function textOverlapOk(box: Aabb, textZone: Rect | null, card: CardBox): boolean {
  if (!textZone) return true;
  const pad = TEXT_ZONE_PAD_FRAC * Math.min(card.w, card.h);
  const zone = inflate(textZone, pad);
  const asRect: Rect = { x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 };
  return !rectsIntersect(asRect, zone);
}

// ---------------------------------------------------------------------------
// True rotated-rect overlap (SAT + exact intersection-polygon area)
// ---------------------------------------------------------------------------

/** A 2D point / corner. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * The 4 corners of the item's ACTUAL rotated rectangle around the placement
 * center (the AABB in placedBox is a bounding superset of this). Corner order
 * is local (−w,−h) → (+w,−h) → (+w,+h) → (−w,+h) rotated by `rotation`
 * degrees — counterclockwise in the math sense (positive shoelace area),
 * the winding clipConvex requires. Rotation uses the same canvas convention
 * as the renderer (ctx.rotate: x' = x·cosθ − y·sinθ, y' = x·sinθ + y·cosθ
 * in y-down screen space).
 */
export function rotatedRectCorners(
  placement: Pick<Placement, "x" | "y" | "rotation" | "scale">,
  item: LayoutItem,
  k: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const hw = displayWidth(item, placement.scale, k) / 2;
  const hh = displayHeight(item, placement.scale, k) / 2;
  const rad = (placement.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(
    ([lx, ly]) => ({
      x: placement.x + lx * c - ly * s,
      y: placement.y + lx * s + ly * c,
    }),
  ) as [Vec2, Vec2, Vec2, Vec2];
}

/** Signed shoelace area of a simple polygon (CCW-positive). */
export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Unsigned area of a rotated-rect corner set (== unrotated w × h). */
export function rotatedRectArea(rect: Vec2[]): number {
  return Math.abs(polygonArea(rect));
}

/** Cross-product z component of (b−a) × (p−a) — the edge side test. */
function crossZ(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * Convex polygon clipping (Sutherland–Hodgman): clip `subject` against every
 * edge half-plane of convex `clip`. Both polygons must be CCW (math sense),
 * which rotatedRectCorners guarantees. Exact for two convex polygons: the
 * output IS the intersection polygon — empty (or < 3 points) when the rects
 * are disjoint, INCLUDING the rotated case where their bounding boxes
 * intersect but the rectangles themselves do not (the implicit
 * separating-axis test). Deterministic, ~40 lines, no allocations beyond
 * the vertex lists.
 */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clip.length; i++) {
    if (out.length === 0) break;
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!;
      const q = input[(j + 1) % input.length]!;
      const dp = crossZ(a.x, a.y, b.x, b.y, p.x, p.y);
      const dq = crossZ(a.x, a.y, b.x, b.y, q.x, q.y);
      const pIn = dp >= 0;
      const qIn = dq >= 0;
      if (pIn) out.push(p);
      if (pIn !== qIn) {
        const t = dp / (dp - dq);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return out;
}

/**
 * Exact area of the intersection of two rotated rectangles (corner sets from
 * rotatedRectCorners). Cheap AABB early-out first (a necessary condition for
 * any intersection), then the exact clipped-polygon area.
 */
export function rotatedRectOverlapArea(a: Vec2[], b: Vec2[]): number {
  let aMinX = Infinity;
  let aMinY = Infinity;
  let aMaxX = -Infinity;
  let aMaxY = -Infinity;
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (const p of a) {
    aMinX = Math.min(aMinX, p.x);
    aMaxX = Math.max(aMaxX, p.x);
    aMinY = Math.min(aMinY, p.y);
    aMaxY = Math.max(aMaxY, p.y);
  }
  for (const p of b) {
    bMinX = Math.min(bMinX, p.x);
    bMaxX = Math.max(bMaxX, p.x);
    bMinY = Math.min(bMinY, p.y);
    bMaxY = Math.max(bMaxY, p.y);
  }
  if (aMaxX <= bMinX || bMaxX <= aMinX || aMaxY <= bMinY || bMaxY <= aMinY) {
    return 0;
  }
  const poly = clipConvex(a, b);
  return poly.length < 3 ? 0 : Math.abs(polygonArea(poly));
}

/**
 * True pairwise overlap RATIO of two rotated rects: intersection area /
 * min(areaA, areaB) — the smaller sticker's visible footprint is the
 * denominator, matching the product rule "≤ 10% OF A STICKER may be tucked
 * behind another".
 */
export function overlapRatio(a: Vec2[], b: Vec2[]): number {
  const denom = Math.min(rotatedRectArea(a), rotatedRectArea(b));
  if (!(denom > 0)) return 0;
  return rotatedRectOverlapArea(a, b) / denom;
}

/**
 * Hero–support tuck cap (hero-montage policy): the user explicitly asked for
 * supports to tuck BEHIND the hero ("allow more overlapping (behind the hero
 * sticker)"), so a pair involving the HERO may overlap up to this ratio
 * (true rotated-rect measure). The hero renders ON TOP (zIndex), so the
 * hidden part of a tucked support reads as "behind the hero". Support–
 * support pairs keep MAX_PAIRWISE_OVERLAP (0.10).
 */
export const HERO_TUCK_CAP = 0.25;

/**
 * (d) Pairwise overlap cap — TRUE rotated-rect measure. `a`/`b` are corner
 * sets from rotatedRectCorners; passes when the true intersection ≤
 * `cap` × min(areaA, areaB). `cap` defaults to MAX_PAIRWISE_OVERLAP (the
 * single 10% user tolerance for every item count — see overlapCapFor).
 */
export function overlapCapOk(
  a: Vec2[],
  b: Vec2[],
  cap: number = MAX_PAIRWISE_OVERLAP,
): boolean {
  return overlapRatio(a, b) <= cap + 1e-9;
}

/**
 * @deprecated Legacy AABB-based pair check — kept only for measurement/
 * regression comparisons. The AABB of a rotated rect overestimates its
 * footprint, so this REJECTS legal placements (two 45°-rotated stickers
 * whose bounding boxes brush measure ~40% "overlap" here while their true
 * rotated intersection is 0). Use overlapCapOk on rotatedRectCorners output.
 */
export function aabbOverlapCapOk(
  a: Aabb,
  b: Aabb,
  cap: number = MAX_PAIRWISE_OVERLAP,
): boolean {
  const inter = boxArea(boxIntersection(a, b));
  return inter <= cap * Math.min(boxArea(a), boxArea(b)) + 1e-9;
}

/**
 * Effective pairwise-overlap cap for an n-item layout.
 *
 * USER DECISION (sizing-accuracy pass): ONE tolerance — MAX_PAIRWISE_OVERLAP
 * = 0.10 — for EVERY item count. The former small-count relaxation
 * (SMALL_N_OVERLAP_CAP = 0.35 for n ≤ 3) is retired: few-sticker cards now
 * fill the card through the coverage-proportional size targets plus the true
 * rotated-rect overlap measure (bounding-box corners that don't actually
 * intersect no longer count as overlap), not through a looser cap. Kept as
 * a function so the solver and tests keep a single policy entry point.
 */
export function overlapCapFor(n: number): number {
  void n;
  return MAX_PAIRWISE_OVERLAP;
}

// ---------------------------------------------------------------------------
// Combined check
// ---------------------------------------------------------------------------

/** Machine-readable violation codes (one entry per broken rule instance). */
export type ViolationCode =
  | "out_of_bounds"
  | "too_small"
  | "too_large"
  | "text_overlap"
  | "overlap_cap";

export interface Violation {
  itemId: string;
  code: ViolationCode;
  otherItemId?: string;
}

export interface ConstraintCtx {
  card: CardBox;
  k: number;
  /** Reserved greeting-text zone (engine passes the fixed top-third zone). */
  textZone: Rect | null;
  /** Relaxed minimum size (% of card width); defaults to MIN_ITEM_SIZE_PCT. */
  minSizePct?: number;
  /** When false the text-overlap rule is skipped (only for overflow items). */
  checkTextOverlap?: boolean;
  /**
   * Pairwise-overlap cap (0–1); defaults to MAX_PAIRWISE_OVERLAP — the
   * single 10% user tolerance for every item count (see overlapCapFor).
   */
  overlapCap?: number;
  /**
   * Hero-montage policy: the id of the layout's HERO item. When set, pairs
   * involving the hero measure against `heroOverlapCap` instead of
   * `overlapCap` — supports may TUCK BEHIND the hero (the hero renders on
   * top), so a hero–support pair allows a deeper overlap (HERO_TUCK_CAP =
   * 0.25) than the 10% support–support tolerance.
   */
  heroItemId?: string;
  /** Pairwise-overlap cap for hero–support pairs (see heroItemId). */
  heroOverlapCap?: number;
}

/** A placed item's footprint for the pairwise overlap check (true corners). */
export interface PlacedFootprint {
  itemId: string;
  /** Bounding AABB (bounds/text checks + cheap rejection). */
  box: Aabb;
  /** Exact rotated-rect corners (true overlap check). */
  corners: [Vec2, Vec2, Vec2, Vec2];
}

/** Footprint (AABB + true corners) of one placement. */
export function placedFootprint(
  placement: Placement,
  item: LayoutItem,
  k: number,
): PlacedFootprint {
  return {
    itemId: item.id,
    box: placedBox(placement, item, k),
    corners: rotatedRectCorners(placement, item, k),
  };
}

/** Check ONE placement against bounds + size + text zone (+ overlap vs already-placed boxes). */
export function checkItem(
  placement: Placement,
  item: LayoutItem,
  ctx: ConstraintCtx,
  placedBoxes: Array<{ itemId: string; box: Aabb; corners?: [Vec2, Vec2, Vec2, Vec2] }> = [],
): Violation[] {
  const violations: Violation[] = [];
  const box = placedBox(placement, item, ctx.k);
  if (!inBoundsOk(box, ctx.card)) violations.push({ itemId: item.id, code: "out_of_bounds" });
  const w = displayWidth(item, placement.scale, ctx.k);
  const minPct = ctx.minSizePct ?? MIN_ITEM_SIZE_PCT;
  if (w < (minPct / 100) * ctx.card.w - 1e-9) violations.push({ itemId: item.id, code: "too_small" });
  if (w > (MAX_ITEM_SIZE_PCT / 100) * ctx.card.w + 1e-9) {
    violations.push({ itemId: item.id, code: "too_large" });
  }
  if ((ctx.checkTextOverlap ?? true) && !textOverlapOk(box, ctx.textZone, ctx.card)) {
    violations.push({ itemId: item.id, code: "text_overlap" });
  }
  const cap = ctx.overlapCap ?? MAX_PAIRWISE_OVERLAP;
  const corners = rotatedRectCorners(placement, item, ctx.k);
  for (const other of placedBoxes) {
    // Cheap AABB pre-filter: disjoint bounding boxes can never have true
    // rotated intersection, skip the exact measure. (Same corner order as
    // placedFootprint — [Vec2, Vec2, Vec2, Vec2] as a plain Vec2 array.)
    if (!(
      box.x2 > other.box.x1 &&
      other.box.x2 > box.x1 &&
      box.y2 > other.box.y1 &&
      other.box.y2 > box.y1
    )) {
      continue;
    }
    const otherCorners = other.corners ?? [];
    // Hero–tuck cap: pairs involving the HERO use the deeper tuck tolerance
    // (supports may sit partially behind the hero; hero renders on top).
    const pairCap =
      ctx.heroItemId !== undefined &&
      ctx.heroOverlapCap !== undefined &&
      (ctx.heroItemId === item.id || ctx.heroItemId === other.itemId)
        ? ctx.heroOverlapCap
        : cap;
    if (!overlapCapOk(corners, otherCorners as Vec2[], pairCap)) {
      violations.push({
        itemId: item.id,
        code: "overlap_cap",
        otherItemId: other.itemId,
      });
    }
  }
  return violations;
}

/**
 * Full-layout check: per-item (a)(b)(c) for every placement + pairwise (d).
 * Returns {ok, violations}; deterministic order (items in input order, pairs
 * i<j). This is the single source of truth the solver and tests rely on.
 */
export function checkLayout(
  placements: Placement[],
  items: LayoutItem[],
  ctx: ConstraintCtx,
): { ok: boolean; violations: Violation[] } {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const violations: Violation[] = [];
  const footprints: Array<{ itemId: string; box: Aabb; corners: [Vec2, Vec2, Vec2, Vec2] }> = [];
  for (const p of placements) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    violations.push(...checkItem(p, item, ctx, footprints));
    footprints.push({
      itemId: p.itemId,
      box: placedBox(p, item, ctx.k),
      corners: rotatedRectCorners(p, item, ctx.k),
    });
  }
  return { ok: violations.length === 0, violations };
}

/** Convenience: the full coordinate space as dims for cardBox. */
export const COORD_DIMS = { width: CARD_COORD_SPACE, height: CARD_COORD_SPACE };
