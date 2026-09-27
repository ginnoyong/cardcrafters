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
 * order (drives zIndex + deterministic tie-breaks).
 */
export interface LayoutItem {
  id: string;
  imgW: number;
  imgH: number;
  visualWeight: number;
  orderIndex: number;
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
 * AABB of a rotated rect overestimates the visual footprint — that is
 * intentional (collision-safe for both text avoidance and overlap caps).
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

/** (d) Pairwise overlap cap: intersection ≤ MAX_PAIRWISE_OVERLAP × min(areaA, areaB). */
export function overlapCapOk(a: Aabb, b: Aabb): boolean {
  const inter = boxArea(boxIntersection(a, b));
  return inter <= MAX_PAIRWISE_OVERLAP * Math.min(boxArea(a), boxArea(b)) + 1e-9;
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
}

/** Check ONE placement against bounds + size + text zone (+ overlap vs already-placed boxes). */
export function checkItem(
  placement: Placement,
  item: LayoutItem,
  ctx: ConstraintCtx,
  placedBoxes: Array<{ itemId: string; box: Aabb }> = [],
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
  for (const other of placedBoxes) {
    if (!overlapCapOk(box, other.box)) {
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
  const boxes: Array<{ itemId: string; box: Aabb }> = [];
  for (const p of placements) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    violations.push(...checkItem(p, item, ctx, boxes));
    boxes.push({ itemId: p.itemId, box: placedBox(p, item, ctx.k) });
  }
  return { ok: violations.length === 0, violations };
}

/** Convenience: the full coordinate space as dims for cardBox. */
export const COORD_DIMS = { width: CARD_COORD_SPACE, height: CARD_COORD_SPACE };
