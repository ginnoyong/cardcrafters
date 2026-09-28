/**
 * Auto-padding post-process (build-phase step 2) — guarantees the die-cut
 * sticker look: subject centered with generous transparent padding, never a
 * full-bleed rectangle.
 *
 * Runs in the item-image worker AFTER ensureTransparentPng (chroma-key first —
 * padding must apply to the FINAL transparent artwork; padding an opaque
 * rectangle would be meaningless). Worker flow order:
 *   decode → ensureTransparentPng → ensureSubjectPadding → write.
 *
 * How it works:
 *  1. Trim fully-transparent margins with sharp().trim() using a transparent
 *     background (alpha-based trim) to find the content bounding box. The
 *     trim offsets (info.trimOffsetLeft/Top) locate the box inside the frame.
 *  2. If the content box is ≤ targetFrac (default 0.88) of the frame in BOTH
 *     dimensions AND touches no edge, the artwork already has ≥12% padding →
 *     return the ORIGINAL buffer unchanged (byte-identical pass-through —
 *     mock stickers rely on this: their content is 160/256 = 0.625 of the
 *     frame). Content TOUCHING an edge (trim is a no-op in that axis) always
 *     triggers padding — touching an edge means zero padding there.
 *  3. Otherwise resize the CONTENT so its long edge is 85% of the frame's
 *     long edge, then composite it CENTERED onto a fully transparent canvas
 *     of the ORIGINAL frame size — output dimensions never change.
 *
 * Fail-open: any sharp error logs a warning and returns the ORIGINAL buffer —
 * a full-bleed sticker is better than a lost generation (same policy as
 * bg-remove). A fully transparent image (degenerate) also passes through.
 */

import sharp from "sharp";

/** Content box may not exceed this fraction of the frame (per dimension). */
const DEFAULT_TARGET_FRAC = 0.88;
/** When padding is needed, the content long edge becomes this fraction of the frame's long edge. */
const CONTENT_FRAC = 0.85;

export interface SubjectPaddingOptions {
  /** Max allowed content-box fraction per dimension (default 0.88 → ≥12% padding). */
  targetFrac?: number;
}

export async function ensureSubjectPadding(
  buf: Buffer,
  opts: SubjectPaddingOptions = {},
): Promise<Buffer> {
  const targetFrac = opts.targetFrac ?? DEFAULT_TARGET_FRAC;
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return buf;
    const frameW = meta.width;
    const frameH = meta.height;

    // 1. Alpha-based trim: strip fully-transparent margins to get the content
    // bounding box. trim() with a transparent background is a no-op when the
    // content touches an edge (verified: it neither errors nor shrinks).
    const trimmed = await sharp(buf)
      .trim({ background: "rgba(0,0,0,0)" })
      .toBuffer({ resolveWithObject: true });
    if (!trimmed.info.width || !trimmed.info.height) return buf;

    // Degenerate: fully transparent content (nothing visible) → pass through.
    const stats = await sharp(trimmed.data).stats();
    if (stats.channels[3]?.max === 0) return buf;

    // 2. Already enough padding AND nothing touches an edge → byte-identical
    // pass-through. trimOffset* are NEGATIVE (pixels removed from that side),
    // so content-left = -trimOffsetLeft, content-top = -trimOffsetTop.
    const left = -(trimmed.info.trimOffsetLeft ?? 0);
    const top = -(trimmed.info.trimOffsetTop ?? 0);
    const touchesEdge =
      left === 0 || top === 0 || left + trimmed.info.width >= frameW || top + trimmed.info.height >= frameH;
    const contentFrac = Math.max(trimmed.info.width / frameW, trimmed.info.height / frameH);
    if (!touchesEdge && contentFrac <= targetFrac) return buf;

    // 3. Full-bleed: shrink the content to 85% of the frame's long edge and
    // composite it centered on a transparent canvas of the ORIGINAL size.
    const longEdge = Math.max(frameW, frameH);
    const target = Math.round(CONTENT_FRAC * longEdge);
    const content = await sharp(trimmed.data)
      .resize(target, target, { fit: "inside" })
      .png()
      .toBuffer();
    return await sharp({
      create: {
        width: frameW,
        height: frameH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: content, gravity: "centre" }])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn(
      "[pad] subject padding failed — keeping original:",
      err instanceof Error ? err.message : err,
    );
    return buf;
  }
}
