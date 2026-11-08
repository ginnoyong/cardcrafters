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
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";

import { DEFAULT_CARD_CONFIG, type MontageGrading, type StyleDerivation } from "@cardcrafters/shared";

import { drawMockSticker } from "../ai/mock-provider";
import { BASE_COVERAGE, REF_SIZE, cardBoxNormalized, baseFit, greetingZonePx } from "../../lib/canvas-geometry";
import { DEFAULT_CARD_WIDTH_PX, deriveGradingFromStyle, gradePoster, renderCardPng } from "./card-render";

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

// ---------------------------------------------------------------------------
// Step 5 (final montage pass): finalPass feathering + grading, and the
// style-pack → grading derivation.
// ---------------------------------------------------------------------------

/** One centered hero sticker — the smallest layout every variant renders. */
async function renderHero(
  storageDir: string,
  itemId: string,
  opts: { finalPass?: boolean; grading?: MontageGrading | null } = {},
): Promise<Buffer> {
  const hero = await writeSticker(storageDir, itemId, "red balloon");
  const card = cardBoxNormalized(RATIO_W, RATIO_H);
  const k = baseFit(card);
  const pxPerUnit = STAGE_W / card.w;
  const heroScale = (0.65 * STAGE_W) / (REF_SIZE * k * pxPerUnit);
  return renderCardPng(
    [hero],
    {
      placements: [
        { itemId: hero.itemId!, x: card.w / 2, y: 550, scale: heroScale, rotation: 0, zIndex: 0 },
      ],
    },
    "Happy Birthday, Sam!",
    { storageDir, ...opts },
  );
}

function countDifferingPixels(a: Buffer, b: Buffer): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      a[i] !== b[i] || a[i + 1] !== b[i + 1] ||
      a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]
    ) diff++;
  }
  return diff;
}

describe("renderCardPng finalPass (feathering + montage grading)", () => {
  it("(a) default (no finalPass) render output is unchanged: deterministic, pinned paper + sticker pixels", async () => {
    const storageDir = await newStorageDir();
    const a = await renderHero(storageDir, "pin-a");
    const b = await renderHero(storageDir, "pin-a");
    // Deterministic: identical inputs → byte-identical output (the crisp
    // default must stay byte-stable for the build-phase critique renders).
    expect(b.equals(a)).toBe(true);

    const meta = await sharp(a).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1120);
    expect(meta.format).toBe("png");

    // Pixel pins: pure paper at the corner, opaque, and a non-paper sticker
    // signature at the hero's center (the pre-montage renderer's exact look).
    const raw = await sharp(a).ensureAlpha().raw().toBuffer();
    const bg = pixelAt(raw, 10, 10, STAGE_W);
    expect(bg[3]).toBe(255);
    expect(isPaper(bg)).toBe(true);
    const heroInside = pixelAt(raw, Math.round(STAGE_W / 2), 550 * (STAGE_H / cardBoxNormalized(RATIO_W, RATIO_H).h), STAGE_W);
    expect(isPaper(heroInside)).toBe(false);
  });

  it("(b) finalPass output differs from crisp for identical input (feather + grade)", async () => {
    const storageDir = await newStorageDir();
    const crisp = await renderHero(storageDir, "diff-item");
    const graded = await renderHero(storageDir, "diff-item", {
      finalPass: true,
      grading: { temperature: 0.5, saturation: 1.1, contrast: 1.1, vignette: 0.25 },
    });
    // Byte-compare: the graded pass must not be byte-identical to crisp.
    expect(graded.equals(crisp)).toBe(false);
    // Not a metadata-only difference — a substantial share of pixels change
    // (temperature tint + saturate/contrast redraw + vignette).
    const crispRaw = await sharp(crisp).ensureAlpha().raw().toBuffer();
    const gradedRaw = await sharp(graded).ensureAlpha().raw().toBuffer();
    expect(crispRaw.length).toBe(gradedRaw.length);
    expect(countDifferingPixels(crispRaw, gradedRaw)).toBeGreaterThan(1000);
  });

  it("(b2) finalPass with NO grading still differs (feathered edges alone)", async () => {
    const storageDir = await newStorageDir();
    const crisp = await renderHero(storageDir, "feather-item");
    const feathered = await renderHero(storageDir, "feather-item", { finalPass: true, grading: null });
    expect(feathered.equals(crisp)).toBe(false);
    // Erase-bug regression pin: feathering must FADE edges, not erase the
    // whole sticker. The hero's placement bbox center must contain plenty of
    // non-paper pixels (the old 4×destination-in bug wiped them entirely).
    const raw = await sharp(feathered).ensureAlpha().raw().toBuffer();
    const heroY = Math.round(550 * (STAGE_H / cardBoxNormalized(RATIO_W, RATIO_H).h));
    let nonPaper = 0;
    for (let y = heroY - 100; y < heroY + 100; y++) {
      for (let x = Math.round(STAGE_W / 2) - 100; x < Math.round(STAGE_W / 2) + 100; x++) {
        const p = pixelAt(raw, x, y, STAGE_W);
        if (p[3] > 0 && !isPaper(p)) nonPaper++;
      }
    }
    expect(nonPaper).toBeGreaterThan(20_000);
  });

  it("(c) finalPass output still decodes via sharp with sane dimensions", async () => {
    const storageDir = await newStorageDir();
    const png = await renderHero(storageDir, "decode-item", {
      finalPass: true,
      grading: { temperature: 0.3, saturation: 1.05, contrast: 1.05, vignette: 0.2 },
    });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1120);
    // Full raw decode succeeds at the exact expected byte count (RGBA).
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    expect(raw.length).toBe(800 * 1120 * 4);
  });

  it("(d) grading extremes render without throwing and produce valid PNGs", async () => {
    const storageDir = await newStorageDir();
    const extremes: MontageGrading[] = [
      { temperature: 1, saturation: 1, contrast: 1, vignette: 0 },
      { temperature: -1, saturation: 1, contrast: 1, vignette: 0 },
      { temperature: 0, saturation: 1.5, contrast: 1, vignette: 0 },
      { temperature: 0, saturation: 0.5, contrast: 1, vignette: 0 },
      { temperature: 0, saturation: 1, contrast: 1.5, vignette: 0 },
      { temperature: 0, saturation: 1, contrast: 0.5, vignette: 0 },
      { temperature: 0, saturation: 1, contrast: 1, vignette: 1 },
      // All extremes at once — the worst case the schema allows.
      { temperature: -1, saturation: 1.5, contrast: 1.5, vignette: 1 },
    ];
    for (const grading of extremes) {
      const png = await renderHero(storageDir, "extreme-item", { finalPass: true, grading });
      const meta = await sharp(png).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(800);
      expect(meta.height).toBe(1120);
    }
  });
});

describe("deriveGradingFromStyle", () => {
  const style: StyleDerivation = {
    styleName: "Watercolor Storybook",
    palette: ["#ff8fa3", "#7bdff2"],
    lineWeight: "thin",
    mood: "playful",
    imagePromptSuffix: " soft watercolor storybook illustration",
  };

  it("is deterministic: same style + teamId → identical grading", () => {
    const a = deriveGradingFromStyle(style, "team-42");
    const b = deriveGradingFromStyle(style, "team-42");
    expect(b).toEqual(a);
  });

  it("different teamIds may differ, but every field stays in-band over many teams", () => {
    const gradings = Array.from({ length: 40 }, (_, i) =>
      deriveGradingFromStyle(style, `team-${i}`),
    );
    for (const g of gradings) {
      expect(g.temperature).toBeGreaterThanOrEqual(-1);
      expect(g.temperature).toBeLessThanOrEqual(1);
      expect(g.saturation).toBeGreaterThanOrEqual(0.85);
      expect(g.saturation).toBeLessThanOrEqual(1.15);
      expect(g.contrast).toBeGreaterThanOrEqual(0.85);
      expect(g.contrast).toBeLessThanOrEqual(1.15);
      expect(g.vignette).toBeGreaterThanOrEqual(0);
      expect(g.vignette).toBeLessThanOrEqual(0.35);
    }
    // With 40 hashed teamIds, the bands must not all collapse to one value
    // (proves teamId actually participates in the derivation).
    const unique = new Set(gradings.map((g) => JSON.stringify(g)));
    expect(unique.size).toBeGreaterThan(1);
  });

  it("null style → the neutral grading {0, 1, 1, 0.15}", () => {
    expect(deriveGradingFromStyle(null, "any-team")).toEqual({
      temperature: 0,
      saturation: 1,
      contrast: 1,
      vignette: 0.15,
    });
  });
});

// ---------------------------------------------------------------------------
// gradePoster (poster grading — runs in BOTH accumulator modes)
// ---------------------------------------------------------------------------

/** Synthetic flat-color poster PNG (the stand-in "raw AI output"). */
function flatPoster(w: number, h: number, color = "#2244cc"): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return canvas.toBuffer("image/png");
}

describe("gradePoster", () => {
  const NEUTRAL = { temperature: 0, saturation: 1, contrast: 1, vignette: 0 };

  it("non-neutral grading washes the poster; output decodes as a PNG at the native dimensions", async () => {
    const poster = flatPoster(200, 280);
    const out = await gradePoster(poster, {
      temperature: 0.8,
      saturation: 1,
      contrast: 1,
      vignette: 0,
    });

    // Graded output differs from the raw input bytes…
    expect(out.equals(poster)).toBe(false);
    // …decodes as a PNG at the poster's NATIVE dimensions.
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(280);

    // Pixel probe: the warm temperature tint washes the whole poster
    // (α ≈ 0.18·0.8) — warm tint #ff9a3c over #2244cc → red clearly rises.
    const raw = await sharp(out).ensureAlpha().raw().toBuffer();
    const px = pixelAt(raw, 100, 30, 200);
    expect(px[0]!).toBeGreaterThan(60);
    expect(px[2]!).toBeLessThan(204);
  });

  it("explicitly neutral grading {0,1,1,0} is pixel-identity — re-encoded PNG at the native dimensions with unchanged content", async () => {
    const poster = flatPoster(120, 120);
    const out = await gradePoster(poster, NEUTRAL);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(120);
    // Zero tint + identity filter + vignette 0 → every pixel survives
    // unchanged (the fresh encode only re-serializes the identical pixels).
    const raw = await sharp(out).ensureAlpha().raw().toBuffer();
    expect(pixelAt(raw, 60, 30, 120)).toEqual([34, 68, 204, 255]);
  });

  it("square poster + card ratio 5/7 → center-cropped to the card ratio (dims ≤ native, corners cut, center kept)", async () => {
    // Square synthetic poster with distinct corner/center markers: real
    // image models often return square, and the lower-third greeting title
    // treatment is CENTERED — a symmetric side crop must keep it.
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2244cc";
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20); // top-left marker — cropped away
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(90, 90, 20, 20); // center marker — survives
    const poster = canvas.toBuffer("image/png");

    const out = await gradePoster(poster, NEUTRAL, 5, 7);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    // Crop math: native aspect 1 > 5/7 → width crops to floor(200·5/7) =
    // 142, height stays 200. Never upscaled.
    expect(meta.width).toBe(142);
    expect(meta.height).toBe(200);
    // Output ratio ≈ 5/7 (within 2px of the exact box) and ≤ native dims.
    expect(Math.abs(meta.width! / meta.height! - 5 / 7)).toBeLessThan(2 / 200);
    expect(meta.width!).toBeLessThanOrEqual(200);
    expect(meta.height!).toBeLessThanOrEqual(200);
    // Pixel probes: the centered marker survives ((200−142)/2 = 29px cropped
    // per side → native x=100 lands at x=71); the corner marker is gone.
    const raw = await sharp(out).ensureAlpha().raw().toBuffer();
    expect(pixelAt(raw, 71, 100, 142)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(raw, 2, 2, 142)).toEqual([34, 68, 204, 255]);
  });

  it("poster already at the card ratio (200×280 = 5/7) → dims unchanged (crop is a no-op within tolerance)", async () => {
    const out = await gradePoster(flatPoster(200, 280), NEUTRAL, 5, 7);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(280);
  });

  it("cardRatioW/H undefined → native preserved (square stays square, no crop)", async () => {
    const out = await gradePoster(
      flatPoster(160, 160),
      { temperature: 0.8, saturation: 1, contrast: 1, vignette: 0 },
    );
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(160);
  });

  it("undecodable poster bytes → throws (the caller falls back to the raw bytes)", async () => {
    await expect(
      gradePoster(Buffer.from("definitely not a png"), NEUTRAL),
    ).rejects.toThrow();
  });
});
