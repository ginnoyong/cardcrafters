/**
 * Visual weight heuristic (build-phase step 2) — a deterministic 0..1 score
 * the layout engine (step 3) uses to balance sticker placement.
 *
 * Definition: coverage × mean saturation, where
 *  - coverage = fraction of pixels with alpha > 128 (non-transparent), and
 *  - mean saturation = average HSV-style saturation (max-min)/max of the
 *    OPAQUE pixels only (0 for grays/white/black, 1 for pure colors).
 *
 * So: a fully transparent sticker → 0; a small pale sticker scores low; a
 * large vivid sticker scores high. Deterministic (pure pixel math), cheap
 * (one raw decode), independent of image scale.
 */

import sharp from "sharp";

export async function computeVisualWeight(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  if (info.channels < 4 || total === 0) return 0;

  let opaque = 0;
  let satSum = 0;
  for (let p = 0; p < total; p++) {
    if (data[p * 4 + 3]! <= 128) continue;
    opaque++;
    const r = data[p * 4]! / 255;
    const g = data[p * 4 + 1]! / 255;
    const b = data[p * 4 + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    satSum += max === 0 ? 0 : (max - min) / max;
  }
  if (opaque === 0) return 0;
  const weight = (opaque / total) * (satSum / opaque);
  // Round to 4 decimals: stable across sharp versions and easy to persist.
  return Math.min(1, Math.round(weight * 10_000) / 10_000);
}