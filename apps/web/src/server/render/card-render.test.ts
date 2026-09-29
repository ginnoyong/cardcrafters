/**
 * Card-renderer tests (vision critique support) — the renderer must produce
 * the EXACT card the players see: paper background, wrapped greeting text in
 * the reserved text zone, and each READY sticker center-anchored at its
 * placement (mapped through the client geometry module).
 *
 * Real end-to-end render: two mock stickers (drawMockSticker → real PNG files
 * in a temp storage dir, addressed via their production imageUrl pattern
 * "/static/items/{itemId}.png") + a known layout (hero at 65% of the card
 * width, centered; one orbiting support) → decoded raw pixels verify
 * dimensions, background, sticker presence and the drawn greeting.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { drawMockSticker } from "../ai/mock-provider";
import { BASE_COVERAGE, REF_SIZE, cardBoxNormalized, baseFit, greetingZonePx } from "../../lib/canvas-geometry";
import { DEFAULT_CARD_WIDTH_PX, renderCardPng } from "./card-render";

const RATIO_W = DEFAULT_CARD_CONFIG.cardRatioW;
const RATIO_H = DEFAULT_CARD_CONFIG.cardRatioH;
const STAGE_W = DEFAULT_CARD_WIDTH_PX;
const STAGE_H = Math.round((STAGE_W * RATIO_H) / RATIO_W); // → 1120 (5:7)
/** Paper background color — must stay in sync with card-render.ts. */
const PAPER = { r: 0xfa, g: 0xf5, b: 0xec };

/** Fresh temp storage dir per test (pattern from flows/item-image.test.ts). */
const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function newStorageDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-render-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a real mock sticker PNG into the storage dir under its item id. */
async function writeSticker(storageDir: string, itemId: string, prompt: string) {
  const { base64 } = drawMockSticker(prompt);
  const file = path.join(storageDir, `${itemId}.png`);
  await writeFile(file, Buffer.from(base64, "base64"));
  return { itemId, imageUrl: `/static/items/${itemId}.png`, width: REF_SIZE, height: REF_SIZE };
}

/** RGBA pixel at (x, y) from a raw decode. */
function pixelAt(raw: Buffer, x: number, y: number, width: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!];
}

function isPaper([r, g, b]: [number, number, number, number]): boolean {
  return r === PAPER.r && g === PAPER.g && b === PAPER.b;
}

describe("renderCardPng (real render, mock stickers)", () => {
  it("renders hero (65% centered) + support + greeting into an opaque 800×1120 PNG", async () => {
    const storageDir = await newStorageDir();
    const hero = await writeSticker(storageDir, "hero-a", "red balloon");
    const support = await writeSticker(storageDir, "sup-b", "blue cake");

    // Known layout: hero at 65% of the card width, centered (the "fixed 65%
    // centered" montage policy); one orbiting support below-left. Scale is
    // derived from the same geometry the renderer maps through.
    const card = cardBoxNormalized(RATIO_W, RATIO_H);
    const k = baseFit(card);
    const pxPerUnit = STAGE_W / card.w;
    const heroDisplayPx = 0.65 * STAGE_W;
    const heroScale = heroDisplayPx / (REF_SIZE * k * pxPerUnit);
    // Card center in the fitted 0..1000 space (the card box is anchored at
    // the origin — see cardBoxNormalized) → 357.14 for the 5:7 card.
    const placements = [
      { itemId: hero.itemId!, x: card.w / 2, y: 550, scale: heroScale, rotation: 0, zIndex: 1 },
      { itemId: support.itemId!, x: 350, y: 850, scale: 0.5, rotation: 0, zIndex: 0 },
    ];

    const png = await renderCardPng(
      [hero, support],
      { placements },
      "Happy Birthday, Sam!",
      { storageDir },
    );

    // -- dimensions: 800×1120 (5:7) -----------------------------------------
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1120);
    expect(meta.format).toBe("png");

    // -- raw decode for pixel-level assertions ------------------------------
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();

    // -- background: (10,10) is paper AND fully opaque -----------------------
    const bg = pixelAt(raw, 10, 10, STAGE_W);
    expect(bg[3]).toBe(255);
    expect(isPaper(bg)).toBe(true);

    // -- stickers present: count non-background pixels around the placements.
    // The hero occupies ~65% × 0.65·(7/5)·800 px of the canvas — its filled
    // shape must leave a clear signature; the paper-only variant of the card
    // (no stickers) would count ZERO here.
    const nonPaper = (() => {
      let count = 0;
      for (let i = 0; i < raw.length; i += 4) {
        if (!isPaper([raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!])) count++;
      }
      return count;
    })();
    // (The mock stickers are outlined shapes + soft shadows, not solid
    // fills — measured coverage of the two-sticker card is ~4%.)
    expect(nonPaper).toBeGreaterThan(20_000);
    // Sample inside the hero's mapped box: definitely non-paper.
    const heroCx = Math.round(placements[0]!.x * pxPerUnit);
    const heroCy = Math.round(placements[0]!.y * (STAGE_H / card.h));
    expect(heroCx).toBe(Math.round(STAGE_W / 2)); // centered
    const heroInside = pixelAt(raw, heroCx, heroCy + 40, STAGE_W);
    expect(isPaper(heroInside)).toBe(false);

    // -- greeting text drawn: opaque, non-paper pixels inside the text zone --
    const zone = greetingZonePx(STAGE_W, STAGE_H, RATIO_W, RATIO_H);
    let textPixels = 0;
    for (let y = Math.ceil(zone.y); y < zone.y + zone.height; y++) {
      for (let x = Math.ceil(zone.x); x < zone.x + zone.width; x++) {
        const p = pixelAt(raw, x, y, STAGE_W);
        if (p[3] === 255 && !isPaper(p)) textPixels++;
      }
    }
    expect(textPixels).toBeGreaterThan(50);
  });

  it("empty greeting → still renders (background + stickers only)", async () => {
    const storageDir = await newStorageDir();
    const only = await writeSticker(storageDir, "solo", "green frog");
    const card = cardBoxNormalized(RATIO_W, RATIO_H);
    const k = baseFit(card);
    const pxPerUnit = STAGE_W / card.w;
    const png = await renderCardPng(
      [only],
      {
        placements: [
          { itemId: only.itemId!, x: card.w / 2, y: 600, scale: (0.65 * STAGE_W) / (REF_SIZE * k * pxPerUnit), rotation: 0, zIndex: 0 },
        ],
      },
      "   ",
      { storageDir },
    );
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    expect(pixelAt(raw, 10, 10, STAGE_W)[3]).toBe(255);
    const heroInside = pixelAt(raw, Math.round(STAGE_W / 2), 600 * (STAGE_H / card.h), STAGE_W);
    expect(isPaper(heroInside)).toBe(false);
  });

  it("fail-open: an unloadable sticker is skipped, the rest still renders", async () => {
    const storageDir = await newStorageDir();
    const ok = await writeSticker(storageDir, "ok-item", "red balloon");
    const errSpy = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const png = await renderCardPng(
        [ok, { itemId: "ghost", imageUrl: "/static/items/ghost.png", width: REF_SIZE, height: REF_SIZE }],
        {
          placements: [
            { itemId: "ok-item", x: 500, y: 500, scale: 1.5, rotation: 0, zIndex: 0 },
            { itemId: "ghost", x: 500, y: 500, scale: 1.5, rotation: 0, zIndex: 1 },
          ],
        },
        "Hello",
        { storageDir },
      );
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(800);
      expect(errors.some((a) => String(a).includes("ghost"))).toBe(true);
    } finally {
      console.error = errSpy;
    }
  });
});
