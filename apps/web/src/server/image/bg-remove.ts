/**
 * Best-effort background removal (build-phase step 2).
 *
 * HONEST LIMITATIONS — read before touching:
 *  - The AI prompt for item_image already asks for a transparent sticker;
 *    real models (gemini-3.1-flash-lite-image / gemini-3.1-flash-image) usually comply, and
 *    the mock provider always draws true alpha. This module is the FALLBACK
 *    for models that return an opaque image.
 *  - The algorithm is a CORNER-COLOR CHROMA KEY: the most common corner pixel
 *    color is keyed out within a fixed RGB distance threshold. It works well
 *    for uniform/solid backgrounds and will NOT handle gradients, textured
 *    or busy backgrounds (it either removes nothing or eats real subject
 *    pixels of similar color). No flood-fill, no ML matting — that is
 *    deliberately out of scope for a local party game.
 *  - Images routed through this path are downscaled to ≤512px on the long
 *    edge (already-transparent PNGs pass through untouched at full size).
 *  - Fail-open: any sharp error logs and returns the ORIGINAL buffer — a
 *    sticker with a background is better than a lost generation.
 */

import sharp from "sharp";

/** Sample roughly this many pixels when checking for existing transparency. */
const ALPHA_SAMPLE_TARGET = 1000;
/** Alpha below this counts as "transparent pixel" (leaves anti-aliasing headroom). */
const OPAQUE_ALPHA_MIN = 250;
/** Euclidean RGB distance to the corner color below which a pixel is keyed out. */
const CHROMA_THRESHOLD = 60;
/** Long-edge cap for images that go through the chroma-key path. */
const MAX_EDGE = 512;

export interface BgRemoveResult {
  buf: Buffer;
  /** Always "image/png" when changed; the input mime when passed through. */
  mime: string;
  changed: boolean;
}

/**
 * Ensure the buffer is a PNG with real transparency:
 *  - PNG that already HAS transparent pixels → returned byte-identical
 *    (mock stickers must pass through unchanged — tested).
 *  - PNG without alpha, or any non-PNG (jpeg/webp) → chroma-key path.
 */
export async function ensureTransparentPng(
  buf: Buffer,
  mime: string,
): Promise<BgRemoveResult> {
  try {
    if (mime === "image/png" && (await hasTransparentPixels(buf))) {
      return { buf, mime: "image/png", changed: false };
    }
    return await chromaKeyToPng(buf);
  } catch (err) {
    console.error(
      "[bg-remove] background removal failed — keeping original:",
      err instanceof Error ? err.message : err,
    );
    return { buf, mime, changed: false };
  }
}

/** True when any of ~1000 sampled pixels has alpha < OPAQUE_ALPHA_MIN. */
async function hasTransparentPixels(buf: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels < 4) return false;
  const total = info.width * info.height;
  const step = Math.max(1, Math.floor(total / ALPHA_SAMPLE_TARGET));
  for (let p = 0; p < total; p += step) {
    if (data[p * 4 + 3]! < OPAQUE_ALPHA_MIN) return true;
  }
  return false;
}

/** Downscale → key out the most common corner color → re-encode as PNG. */
async function chromaKeyToPng(buf: Buffer): Promise<BgRemoveResult> {
  const { data, info } = await sharp(buf)
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (info.channels < 4) throw new Error("expected RGBA raw buffer");

  // Corner colors (top-left, top-right, bottom-left, bottom-right).
  const corners: Array<[number, number, number]> = [
    0,
    width - 1,
    (height - 1) * width,
    width * height - 1,
  ].map((p) => [data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!]);

  // Most common corner color (quantized to /16 buckets so JPEG noise still groups).
  const counts = new Map<string, number>();
  for (const [r, g, b] of corners) {
    const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const bestKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const [br, bg, bb] = bestKey.split(":").map((v) => (Number(v) << 4) + 8);

  // Build the 1-channel alpha mask: key color → 0, everything else → 255.
  const mask = Buffer.alloc(width * height);
  for (let p = 0; p < width * height; p++) {
    const dr = data[p * 4]! - br!;
    const dg = data[p * 4 + 1]! - bg!;
    const db = data[p * 4 + 2]! - bb!;
    mask[p] = dr * dr + dg * dg + db * db < CHROMA_THRESHOLD * CHROMA_THRESHOLD ? 0 : 255;
  }

  // Manually strip the source alpha into an RGB buffer — sharp's removeAlpha()
  // is a NO-OP on raw 4-channel input (verified empirically), which made the
  // joinChannel mask become a discarded 5th channel. RGB+mask join is correct.
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgb[p * 3] = data[p * 4]!;
    rgb[p * 3 + 1] = data[p * 4 + 1]!;
    rgb[p * 3 + 2] = data[p * 4 + 2]!;
  }
  const out = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(mask, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return { buf: out, mime: "image/png", changed: true };
}