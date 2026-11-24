/**
 * Canvas geometry — the CLIENT mirror of the server's layout constraints
 * (apps/web/src/server/layout/constraints.ts). The server is the single
 * source of truth for placement semantics; this module must match it exactly
 * (canvas-geometry.test.ts cross-checks mapPlacement against
 * constraints.placedBox).
 *
 * Server semantics being mirrored:
 *  - Placements live in a normalized 0..1000 coordinate space (x right, y
 *    down). The card itself is fitted into that 0..1000 × 0..1000 square
 *    preserving its aspect ratio, anchored at the ORIGIN (cardBox).
 *  - placement.x/y is the CENTER of the item (placedBox subtracts half-extents).
 *  - An item's display size is (imgW, imgH) × scale × k, where
 *    k = (BASE_COVERAGE × min(card.w, card.h)) / REF_SIZE.
 *
 * This file converts those normalized units into STAGE PIXELS for rendering.
 */

import { CARD_COORD_SPACE } from "@cardcrafters/shared";

/** Reference sticker size in source px (mirror of constraints.REF_SIZE). */
export const REF_SIZE = 256;
/** Fraction of the card's min dimension a REF_SIZE sticker covers at scale 1. */
export const BASE_COVERAGE = 0.25;

/** A card fitted into the coordinate space: {w, h} normalized units. */
export interface NormalizedCardBox {
  w: number;
  h: number;
}

/** Placement slice used for mapping (mirrors shared Placement). */
export interface PlacementLike {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** Item's source-image pixel dimensions (Item.width/height). */
export interface ItemSize {
  width: number;
  height: number;
}

/**
 * Fit a ratioW:ratioH card into the 0..1000 coordinate space, anchored at
 * (0,0) — mirror of constraints.cardBox({width:1000, height:1000}, rw, rh).
 * For the default 3:4 card: {w: 750, h: 1000}.
 */
export function cardBoxNormalized(ratioW: number, ratioH: number): NormalizedCardBox {
  if (!(ratioW > 0) || !(ratioH > 0)) {
    throw new Error(`cardBoxNormalized: invalid ratio ${ratioW}:${ratioH}`);
  }
  const s = Math.min(CARD_COORD_SPACE / ratioW, CARD_COORD_SPACE / ratioH);
  return { w: ratioW * s, h: ratioH * s };
}

/** Default k — mirror of constraints.baseFit(card). */
export function baseFit(card: NormalizedCardBox): number {
  return (BASE_COVERAGE * Math.min(card.w, card.h)) / REF_SIZE;
}

/** Mapped item geometry in stage pixels, CENTER-anchored. */
export interface MappedPlacement {
  /** Center x in stage px. */
  x: number;
  /** Center y in stage px. */
  y: number;
  /** Unrotated display width in stage px. */
  width: number;
  /** Unrotated display height in stage px. */
  height: number;
  /** Degrees (passthrough). */
  rotation: number;
}

/**
 * Map a server placement (+ item source size) onto stage pixels.
 *
 * The card box (see cardBoxNormalized) occupies the TOP-LEFT portion of the
 * normalized square, so x maps with stageW/card.w and y with stageH/card.h.
 * When the stage has exactly the card's aspect ratio (which CardCanvas
 * guarantees) the two factors are equal and the mapping is a uniform scale.
 */
export function mapPlacement(
  placement: PlacementLike,
  item: ItemSize,
  stageW: number,
  stageH: number,
  ratioW: number,
  ratioH: number,
): MappedPlacement {
  const card = cardBoxNormalized(ratioW, ratioH);
  const k = baseFit(card);
  const pxPerUnitX = stageW / card.w;
  const pxPerUnitY = stageH / card.h;
  return {
    x: placement.x * pxPerUnitX,
    y: placement.y * pxPerUnitY,
    width: item.width * placement.scale * k * pxPerUnitX,
    height: item.height * placement.scale * k * pxPerUnitY,
    rotation: placement.rotation,
  };
}

/**
 * The FIXED reserved greeting text zone in stage pixels — top of the card,
 * {x: 10%, y: 6%, w: 80%, h: 16%} of the card's normalized width/height
 * (mirror of engine.defaultTextZone over the fitted cardBox).
 */
export function greetingZonePx(
  stageW: number,
  stageH: number,
  ratioW: number,
  ratioH: number,
): { x: number; y: number; width: number; height: number } {
  const card = cardBoxNormalized(ratioW, ratioH);
  return {
    x: 0.1 * card.w * (stageW / card.w),
    y: 0.06 * card.h * (stageH / card.h),
    width: 0.8 * card.w * (stageW / card.w),
    height: 0.16 * card.h * (stageH / card.h),
  };
}