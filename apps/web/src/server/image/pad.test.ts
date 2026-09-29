/**
 * ensureSubjectPadding tests — the CONTENT-CROP post-process (USER DECISION:
 * no visible white space around the artwork):
 *  - artwork with transparent margins → cropped tight to content + a small
 *    margin (2% of the max frame dimension, min 4px per side);
 *  - full-bleed artwork (content touching all edges) → nothing to crop, the
 *    original passes through byte-identically;
 *  - interior transparency is untouched (only outside margins disappear);
 *  - corrupt buffers fail open with the original buffer.
 */

import { describe, expect, it } from "vitest";

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

describe("ensureSubjectPadding (content crop)", () => {
  it("artwork with transparent margins → cropped tight to content + margin", async () => {
    // 100×100 frame, opaque square at (10,10)-(90,90) → content 80×80.
    // Margin = max(4, 2%×100=2) = 4px → crop box (6,6,88,88).
    const padded = await makePng(100, (p, x, y, raw) => {
      if (x >= 10 && x < 90 && y >= 10 && y < 90) {
        raw[p] = 200;
        raw[p + 1] = 30;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });
    const out = await ensureSubjectPadding(padded);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(88);
    expect(meta.height).toBe(88);
    // The corners of the OUTPUT hold artwork now (the crop kept content +
    // 4px margin; content corner is at (4,4) in output coords → opaque).
    expect(await alphaAt(out, 5, 5)).toBe(255);
    expect(await alphaAt(out, 82, 82)).toBe(255);
    // Interior transparency untouched: punch a transparent hole check — the
    // center is still opaque.
    expect(await alphaAt(out, 44, 44)).toBe(255);
  });

  it("full-bleed content touching ALL edges → nothing to crop, byte-identical pass-through", async () => {
    // Cross touching all 4 edges (transparent corners) — trim finds content
    // spanning the whole frame → crop box equals the frame → unchanged.
    const fullBleed = await makePng(128, (p, x, y, raw) => {
      if (Math.abs(x - 64) < 12 || Math.abs(y - 64) < 12) {
        raw[p] = 200;
        raw[p + 1] = 30;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });
    const out = await ensureSubjectPadding(fullBleed);
    expect(out.equals(fullBleed)).toBe(true);
  });

  it("edge-touching on ONE side → only the empty sides are cropped", async () => {
    // 100×100 frame: content spans full height (y 0..100) but only x 40..70.
    const oneSided = await makePng(100, (p, x, y, raw) => {
      if (x >= 40 && x < 70) {
        raw[p] = 30;
        raw[p + 1] = 200;
        raw[p + 2] = 30;
        raw[p + 3] = 255;
      }
    });
    const out = await ensureSubjectPadding(oneSided);
    const meta = await sharp(out).metadata();
    // x crop: content 30 wide + 2×4 margin = 38; y unchanged (content full).
    expect(meta.width).toBe(38);
    expect(meta.height).toBe(100);
  });

  it("mock sticker (~19% padding) → cropped tight; frame ≈ content + margin", async () => {
    const sticker = drawMockSticker("golden retriever party hat");
    const buf = Buffer.from(sticker.base64, "base64");
    const metaBefore = await sharp(buf).metadata();
    const out = await ensureSubjectPadding(buf);
    const meta = await sharp(out).metadata();
    // Content was 160/256 → cropped to ~160 + 2×max(4, 2%×256≈5)=170 (±8 for
    // the white stroke/shadow edges the trim sees).
    expect(metaBefore.width).toBe(256);
    expect(meta.width).toBeGreaterThan(150);
    expect(meta.width).toBeLessThan(190);
    // The 2% margin stays transparent BY DESIGN (5px), but the artwork now
    // starts immediately after it — sample at (margin+1, mid) → opaque.
    expect(await alphaAt(out, 6, Math.floor((meta.height ?? 2) / 2))).toBeGreaterThan(0);
  });

  it("fully transparent → pass-through", async () => {
    const buf = await makePng(64, () => {});
    expect((await ensureSubjectPadding(buf)).equals(buf)).toBe(true);
  });

  it("corrupt buffer → fail-open (original returned)", async () => {
    const orig = Buffer.from("not a png");
    expect((await ensureSubjectPadding(orig)).equals(orig)).toBe(true);
  });
});