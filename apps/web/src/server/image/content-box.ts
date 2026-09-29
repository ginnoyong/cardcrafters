/**
 * Content-box extraction (build-phase step 2) — the axis-aligned bounding box
 * of the VISIBLE artwork inside a sticker's transparent frame, in frame pixel
 * coordinates (same space as Item.width/height).
 *
 * Stickers are die-cut PNGs: the artwork floats inside a larger transparent
 * canvas (padding added by image/pad.ts), so the frame's box overestimates the
 * visual footprint. The layout solver uses the content box for tighter
 * collision; clients only render the frame.
 *
 * Pure pixel math over one raw decode (same pattern as image/weight.ts):
 * full scan for the min/max x/y of any pixel whose alpha exceeds
 * ALPHA_THRESHOLD. Fails OPEN: any error (corrupt buffer, fully transparent
 * frame, degenerate image) returns null and the caller falls back to the
 * frame box.
 */

import type { ContentBox } from "@cardcrafters/shared";

import sharp from "sharp";

/** Minimum alpha (0–255) for a pixel to count as visible artwork. */
const ALPHA_THRESHOLD = 10;

export async function extractContentBox(buf: Buffer): Promise<ContentBox | null> {
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (width <= 0 || height <= 0 || channels < 4) return null;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      const row = y * width * channels;
      for (let x = 0; x < width; x++) {
        if (data[row + x * channels + 3]! > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null; // fully transparent — no visible artwork
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch {
    return null; // fail-open: corrupt/undecodable buffer → caller uses frame dims
  }
}
