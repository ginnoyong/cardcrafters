/**
 * ensureSubjectPadding tests — the die-cut post-process guarantee:
 * full-bleed artwork gains transparent padding on all sides; already-padded
 * artwork (incl. mock stickers) passes through byte-identically; corrupt
 * buffers fail open with the original buffer.
 */

import { describe, expect, it, vi } from "vitest";

import { drawMockSticker } from "../ai/mock-provider";
import { ensureSubjectPadding } from "./pad";

const sharp = (await import("sharp")).default;

/** Raw RGBA helper: build a PNG from a paint callback over a transparent canvas. */
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

async function alphaAt(buf: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3]!;
}

describe("ensureSubjectPadding (die-cut auto-padding)", () => {
  it("full-bleed content touching all 4 edges → padding on all sides, content centered, dims unchanged", async () => {
    // Transparent 128×128 canvas with an opaque cross (thick columns/rows)
    // touching all four edges but with transparent corners.
    const fullBleed = await makePng(128, (p, x, y, raw) => {
      if (Math.abs(x - 64) < 12 || Math.abs(y - 64) < 12) {
        raw[p] = 200;
        raw[p + 1] = 30;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });

    const out = await ensureSubjectPadding(fullBleed);

    // Frame size unchanged (output is composited onto the original canvas).
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);

    // Transparent padding on all sides (content shrank to 85%).
    expect(await alphaAt(out, 0, 0)).toBe(0);
    expect(await alphaAt(out, 127, 0)).toBe(0);
    expect(await alphaAt(out, 0, 127)).toBe(0);
    expect(await alphaAt(out, 127, 127)).toBe(0);
    expect(await alphaAt(out, 64, 0)).toBe(0); // edge midpoints too
    expect(await alphaAt(out, 0, 64)).toBe(0);
    expect(await alphaAt(out, 127, 64)).toBe(0);
    expect(await alphaAt(out, 64, 127)).toBe(0);
    // Content is still there, centered.
    expect(await alphaAt(out, 64, 64)).toBe(255);
  });

  it("content on one edge only → padded on that side", async () => {
    // Opaque block touching only the TOP edge (centered horizontally).
    const topTouch = await makePng(100, (p, x, y, raw) => {
      if (y < 40 && x >= 20 && x < 80) {
        raw[p] = 30;
        raw[p + 1] = 90;
        raw[p + 2] = 200;
        raw[p + 3] = 255;
      }
    });

    const out = await ensureSubjectPadding(topTouch);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);

    // Top edge now transparent (was content before).
    expect(await alphaAt(out, 50, 0)).toBe(0);
    expect(await alphaAt(out, 50, 4)).toBe(0);
    // Content is centered vertically now (block was 40 tall → 85 becomes 34 tall → top ≈ 33).
    expect(await alphaAt(out, 50, 33)).toBe(255);
    // Other sides were already padded and stay padded.
    expect(await alphaAt(out, 5, 50)).toBe(0);
    expect(await alphaAt(out, 94, 50)).toBe(0);
  });

  it("already-padded input → byte-identical pass-through", async () => {
    // Content centered at 60% of the frame (≤ targetFrac 0.88).
    const padded = await makePng(100, (p, x, y, raw) => {
      if (Math.abs(x - 50) < 30 && Math.abs(y - 50) < 30) {
        raw[p] = 200;
        raw[p + 1] = 30;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });

    const out = await ensureSubjectPadding(padded);
    expect(out.equals(padded)).toBe(true);
  });

  it("mock stickers (already padded ~19%) pass through byte-identically", async () => {
    const { base64 } = drawMockSticker("a red balloon dog");
    const buf = Buffer.from(base64, "base64");
    const out = await ensureSubjectPadding(buf);
    expect(out.equals(buf)).toBe(true);
  });

  it("mock sticker through the FULL worker pipeline shape (ensureTransparentPng → pad) is unchanged", async () => {
    const { base64 } = drawMockSticker("a snowman with a scarf");
    const buf = Buffer.from(base64, "base64");
    const { ensureTransparentPng } = await import("./bg-remove");
    const keyed = await ensureTransparentPng(buf, "image/png");
    expect(keyed.changed).toBe(false);
    const out = await ensureSubjectPadding(keyed.buf);
    expect(out.equals(buf)).toBe(true);
  });

  it("fully transparent (degenerate) input → pass-through", async () => {
    const empty = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await ensureSubjectPadding(empty);
    expect(out.equals(empty)).toBe(true);
  });

  it("corrupt buffer → fail-open with the ORIGINAL buffer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const corrupt = Buffer.from("this is definitely not a png");
    const out = await ensureSubjectPadding(corrupt);
    expect(out.equals(corrupt)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[pad]");
  });

  it("respects a custom targetFrac (0.5 pads content that occupies >50% of the frame)", async () => {
    // Content occupies 80/100 of the frame → >0.5 → padded to 85%.
    const mostlyFull = await makePng(100, (p, x, y, raw) => {
      if (x >= 10 && x < 90 && y >= 10 && y < 90) {
        raw[p] = 200;
        raw[p + 1] = 30;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });
    const out = await ensureSubjectPadding(mostlyFull, { targetFrac: 0.5 });
    // Content was resized to 85% of the frame's long edge (85px) and centered:
    // it now spans ~7..92, so (10,10) is INSIDE the content, (2,2) is padding.
    const t = await sharp(out).trim({ background: "rgba(0,0,0,0)" }).toBuffer({ resolveWithObject: true });
    expect(t.info.width).toBe(85);
    expect(t.info.height).toBe(85);
    expect(await alphaAt(out, 2, 2)).toBe(0);
    expect(await alphaAt(out, 50, 50)).toBe(255);
    // Default targetFrac (0.88) would pass this through untouched.
    const untouched = await ensureSubjectPadding(mostlyFull);
    expect(untouched.equals(mostlyFull)).toBe(true);
  });
});
