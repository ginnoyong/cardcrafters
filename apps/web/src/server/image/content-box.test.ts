/**
 * Tests for extractContentBox (image/content-box.ts) — the visible-artwork
 * bounding box within a sticker's transparent frame. Uses the makePng helper
 * pattern from pad.test.ts.
 */

import { describe, expect, it } from "vitest";

import { extractContentBox } from "./content-box";

/** Build a size×size RGBA PNG via a per-pixel paint callback (alpha 0–255). */
async function makePng(
  size: number,
  paint: (p: number, x: number, y: number, buf: Buffer) => void,
): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      paint((y * size + x) * 4, x, y, raw);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

// sharp must be imported AFTER makePng's raw buffer math — same import as pad.test.ts.
import sharp from "sharp";

describe("extractContentBox", () => {
  it("centered opaque square → box around the square", async () => {
    // 256×256, opaque 160×160 square centered → box {48,48,160,160}.
    const buf = await makePng(256, (p, x, y, rgba) => {
      if (x >= 48 && x < 208 && y >= 48 && y < 208) {
        rgba[p] = 30;
        rgba[p + 1] = 90;
        rgba[p + 2] = 220;
        rgba[p + 3] = 255;
      } else {
        rgba[p + 3] = 0;
      }
    });
    const box = await extractContentBox(buf);
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(46);
    expect(box!.x).toBeLessThanOrEqual(50);
    expect(box!.y).toBeGreaterThanOrEqual(46);
    expect(box!.w).toBeGreaterThanOrEqual(158);
    expect(box!.w).toBeLessThanOrEqual(164);
  });

  it("off-center content → box offset matches content", async () => {
    const size = 128;
    const buf = await makePng(64, (p, x, y, rgba) => {
      if (x >= 40 && x < 64 && y >= 8 && y < 40) {
        rgba[p] = 30;
        rgba[p + 1] = 90;
        rgba[p + 2] = 220;
        rgba[p + 3] = 255;
      }
    });
    const box = await extractContentBox(buf);
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(38);
    expect(box!.x).toBeLessThanOrEqual(42);
    expect(box!.y).toBeGreaterThanOrEqual(6);
    expect(box!.y).toBeLessThanOrEqual(10);
    expect(box!.w).toBeLessThanOrEqual(26);
    expect(box!.h).toBeGreaterThanOrEqual(30);
  });

  it("full-bleed opaque → box equals the frame", async () => {
    const buf = await makePng(64, (p, _x, _y, rgba) => {
      rgba[p + 3] = 255;
    });
    const box = await extractContentBox(buf);
    expect(box).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it("fully transparent → null", async () => {
    const buf = await makePng(64, () => {});
    expect(await extractContentBox(buf)).toBeNull();
  });

  it("corrupt buffer → null (fail-open)", async () => {
    expect(await extractContentBox(Buffer.from("not a png"))).toBeNull();
  });
});
