/**
 * Content-crop post-process (USER DECISION: "no white space around the image"
 * — the visible cutout/border of a sticker must not be obvious). Replaces the
 * earlier die-cut padding pass: instead of guaranteeing padding, the sticker
 * PNG is CROPPED to its visible content box plus a small safety margin, so
 * what the solver/client treat as the "frame" is essentially the artwork.
 *
 * Runs in the item-image worker AFTER ensureTransparentPng (chroma-key first —
 * cropping must apply to the FINAL transparent artwork). Worker flow order:
 *   decode → ensureTransparentPng → ensureSubjectPadding(crop) → write.
 *
 * How it works:
 *  1. Alpha-based trim (sharp().trim() with a transparent background) finds
 *     the content bounding box; trim offsets (info.trimOffsetLeft/Top,
 *     NEGATIVE pixels removed) locate it inside the frame.
 *  2. Crop the frame to content + margin = 2% of the max frame dimension
 *     (min 4px per side), clamped to the frame bounds.
 *  3. Interior transparency of the artwork is untouched — only the outside
 *     transparent margins disappear.
 *
 * Fail-open: any sharp error logs a warning and returns the ORIGINAL buffer
 * (same policy as bg-remove). A fully transparent (degenerate) image also
 * passes through.
 */

import sharp from "sharp";

/** Crop margin as a fraction of the larger frame dimension. */
const CROP_MARGIN_FRAC = 0.02;
/** Minimum crop margin in pixels (per side). */
const MIN_CROP_MARGIN = 4;

export async function ensureSubjectPadding(buf: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return buf;
    const frameW = meta.width;
    const frameH = meta.height;

    // 1. Alpha-based trim: strip fully-transparent margins to get the content
    // bounding box (no-op when content touches an edge — verified).
    const trimmed = await sharp(buf)
      .trim({ background: "rgba(0,0,0,0)" })
      .toBuffer({ resolveWithObject: true });
    if (!trimmed.info.width || !trimmed.info.height) return buf;

    // Degenerate: fully transparent content (nothing visible) → pass through.
    const stats = await sharp(trimmed.data).stats();
    if (stats.channels[3]?.max === 0) return buf;

    // 2. Crop to content + small margin. trimOffset* are NEGATIVE (pixels
    // removed from that side), so content-left = -trimOffsetLeft.
    const left = Math.max(
      0,
      -(trimmed.info.trimOffsetLeft ?? 0) - marginFor(frameW, frameH),
    );
    const top = Math.max(
      0,
      -(trimmed.info.trimOffsetTop ?? 0) - marginFor(frameW, frameH),
    );
    const width = Math.min(
      frameW - left,
      trimmed.info.width + 2 * marginFor(frameW, frameH),
    );
    const height = Math.min(
      frameH - top,
      trimmed.info.height + 2 * marginFor(frameW, frameH),
    );
    if (width === frameW && height === frameH && left === 0 && top === 0) {
      return buf; // content already fills the frame → nothing to crop
    }
    return sharp(buf).extract({ left, top, width, height }).png().toBuffer();
  } catch (err) {
    console.warn(
      "[pad] content crop failed — keeping original:",
      err instanceof Error ? err.message : err,
    );
    return buf;
  }
}

function marginFor(frameW: number, frameH: number): number {
  return Math.max(MIN_CROP_MARGIN, Math.round(CROP_MARGIN_FRAC * Math.max(frameW, frameH)));
}