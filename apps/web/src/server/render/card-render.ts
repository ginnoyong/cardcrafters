/**
 * Card renderer (vision critique support) — draws the CURRENT card as a PNG
 * so the layout-critique task can judge the composition visually.
 *
 * Geometry is NOT re-implemented here: it maps server placements through the
 * CLIENT geometry module (lib/canvas-geometry.ts mapPlacement / greetingZonePx)
 * which is test-cross-checked against the server's constraints.placedBox —
 * the renderer therefore draws exactly what players see.
 *
 * Semantics mirrored from canvas-geometry (which mirrors layout/constraints):
 *  - placement.x/y is the CENTER of the item in the normalized 0..1000 space;
 *  - display size = item.w/h × scale × k, mapped into stage pixels;
 *  - the greeting lives in the fixed reserved zone {10%, 6%, 80%, 16%}.
 *
 * Fail-open contract: a sticker whose image cannot be loaded is SKIPPED (with
 * a console.error) — a critique of a partially rendered card beats no
 * critique at all. Only a total failure (canvas/text crash) rejects.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCanvas,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import sharp from "sharp";

import {
  MONTAGE_FEATHER_FRACTION,
  type MontageGrading,
  type StyleDerivation,
} from "@cardcrafters/shared";

import { greetingZonePx, mapPlacement } from "../../lib/canvas-geometry";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/server/render

/** Default sticker storage dir — the image worker writes
 *  apps/web/public/static/items/{itemId}.png (see flows/item-image.ts). */
export const DEFAULT_ITEMS_DIR = path.resolve(here, "../../../public/static/items");

/** Default render width; the card keeps its 5:7 ratio (→ 800×1120). */
export const DEFAULT_CARD_WIDTH_PX = 800;
/** Default card ratio (matches DEFAULT_CARD_CONFIG). */
const DEFAULT_RATIO_W = 5;
const DEFAULT_RATIO_H = 7;
/** Paper background color — warm off-white "cardstock". */
const PAPER_COLOR = "#faf5ec";
/** Greeting font size as a fraction of the render width (~4.5% → 36px @800). */
const GREETING_FONT_FRACTION = 0.045;
/** Warm-tint alpha at |temperature| = 1 (the montage grading overlay scale). */
const TEMPERATURE_TINT_MAX_ALPHA = 0.18;
/** Warm/cool tint colors for the temperature overlay (temperature > 0 / < 0). */
const WARM_TINT = "#ff9a3c";
const COOL_TINT = "#3c9aff";
/** Radial-gradient start radius (fraction of the half-diagonal): inside this
 *  radius the vignette overlay is fully transparent, then ramps to black at
 *  the corners. */
const VIGNETTE_INNER_FRACTION = 0.55;
// -- Poster greeting compositing (composeGreetingOnPoster) -----------------
/** Soft readability band height as a fraction of the poster height: the
 *  montage_prompt template tells the image model to leave the LOWER THIRD
 *  open ("do NOT render it in the image"), so the composited band covers the
 *  same proportion. */
const POSTER_BAND_FRACTION = 1 / 3;
/** Band opacity — the same translucent paper tone family the sticker cards
 *  use for their greeting zone (PAPER_COLOR at alpha). */
const POSTER_BAND_ALPHA = 0.85;
/** Horizontal inset of the rounded band rect (fraction of poster width). */
const POSTER_BAND_INSET_FRACTION = 0.04;
/** Rounded-corner radius of the band rect (fraction of poster width). */
const POSTER_BAND_RADIUS_FRACTION = 0.025;
/** Text max-width margin (fraction of poster width, per side) inside the
 *  band — a little wider than the band inset so text never hugs the curve. */
const POSTER_TEXT_INSET_FRACTION = 0.08;
/** Greeting font sizing for the poster band, mirroring the mock's baked
 *  lower-third text (mockMontageImageResult): start at 56/800 ≈ 0.07 of the
 *  width, shrink 4/800 per step until the wrapped block fits, floor 18/800. */
const POSTER_FONT_START_FRACTION = 0.07;
const POSTER_FONT_MIN_FRACTION = 0.0225;
const POSTER_FONT_STEP_FRACTION = 0.005;
/** Vertical padding fraction the wrapped text block must fit inside the
 *  band (mock: bandH − 40 of an 1120-tall poster ≈ bandH × 0.9). */
const POSTER_TEXT_MAX_BAND_FRACTION = 0.9;
/** Neutral grading when no style pack exists (identity-ish: untouched color,
 *  the same faint edge darkening every montage card gets). */
const NEUTRAL_GRADING: MontageGrading = {
  temperature: 0,
  saturation: 1,
  contrast: 1,
  vignette: 0.15,
};

/** Minimal item slice the renderer needs (repo rows / event payloads fit). */
export interface RenderableItem {
  itemId?: string;
  /** Client-facing URL, e.g. "/static/items/{itemId}.png" or a data URL. */
  imageUrl?: string | null;
  /** Direct fs path — wins over imageUrl when present (tests, previews). */
  imagePath?: string;
  /** Source-image pixel dimensions (REQUIRED — they drive the placement map). */
  width: number;
  height: number;
}

/** Placement slice (mirrors shared Placement; rotation is currently 0). */
export interface RenderablePlacement {
  itemId: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
}

export interface RenderCardOptions {
  /** Rendered width in px; height = width × ratioH/ratioW. Default 800. */
  width?: number;
  cardRatioW?: number;
  cardRatioH?: number;
  /** Sticker storage dir for "/static/items/…" URLs. Default DEFAULT_ITEMS_DIR. */
  storageDir?: string;
  /**
   * Final montage pass: feather each sticker's edges (alpha fade of
   * MONTAGE_FEATHER_FRACTION × drawn width per edge) and apply the montage
   * grading after the stickers. Default false — crisp die-cut edges and NO
   * grading, byte-identical to the pre-montage renderer for existing callers
   * (build-phase critique renders).
   */
  finalPass?: boolean;
  /** Montage grading (style-pack derived — see deriveGradingFromStyle);
   *  applied ONLY when finalPass is true. Default null (no grading). */
  grading?: MontageGrading | null;
}

/**
 * Deterministic style-pack → montage-grading derivation (final pass).
 *
 * Bands (all derived from one FNV-1a hash, re-hashed per band so the four
 * fields decorrelate; uniform over each band):
 *   - temperature ∈ [−1, 1]  — warm/cool cast of the whole card
 *   - saturation  ∈ [0.85, 1.15] — subtle (schema bound is [0.5, 1.5])
 *   - contrast    ∈ [0.85, 1.15] — subtle (schema bound is [0.5, 1.5])
 *   - vignette    ∈ [0, 0.35]  — gentle edge darkening only
 *
 * Inputs: the style pack's styleName + mood + the teamId (so two teams with
 * the same style still grade differently). Null/missing style → the neutral
 * default (temperature 0, saturation 1, contrast 1, vignette 0.15).
 */
export function deriveGradingFromStyle(
  style: StyleDerivation | null,
  teamId: string,
): MontageGrading {
  if (!style) return { ...NEUTRAL_GRADING };
  const band = (i: number): number => hashString(`${i}:${style.styleName}\u0000${style.mood}\u0000${teamId}`);
  const unit = (i: number): number => band(i) / 0x100000000; // [0, 1)
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  // round(…, 4) keeps the derived numbers stable through JSON round-trips.
  const r4 = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    temperature: r4(clamp(unit(0) * 2 - 1, -1, 1)),
    saturation: r4(clamp(0.85 + unit(1) * 0.3, 0.5, 1.5)),
    contrast: r4(clamp(0.85 + unit(2) * 0.3, 0.5, 1.5)),
    vignette: r4(clamp(unit(3) * 0.35, 0, 1)),
  };
}

/** FNV-1a 32-bit (same construction as layout/solver's hashString). */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Render one card to a PNG buffer: paper background, wrapped greeting text in
 * the text zone, then each READY item drawn center-anchored at its placement
 * (rotation applied, currently always 0) in zIndex order.
 */
export async function renderCardPng(
  items: RenderableItem[],
  layout: { placements: RenderablePlacement[] },
  greeting: string,
  opts: RenderCardOptions = {},
): Promise<Buffer> {
  const width = Math.max(1, Math.round(opts.width ?? DEFAULT_CARD_WIDTH_PX));
  const ratioW = opts.cardRatioW ?? DEFAULT_RATIO_W;
  const ratioH = opts.cardRatioH ?? DEFAULT_RATIO_H;
  const height = Math.round((width * ratioH) / ratioW);
  const storageDir = opts.storageDir ?? DEFAULT_ITEMS_DIR;
  const finalPass = opts.finalPass ?? false;
  const grading = opts.grading ?? null;

  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // -- paper background ------------------------------------------------------
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);

  // -- greeting text (reserved zone, wrapped, centered) ----------------------
  const zone = greetingZonePx(width, height, ratioW, ratioH);
  const fontSize = Math.max(8, Math.round(width * GREETING_FONT_FRACTION));
  const text = greeting.trim();
  if (text) {
    ctx.fillStyle = "#3a3230";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    const lines = wrapText(ctx, text, zone.width);
    const lineHeight = fontSize * 1.25;
    const blockH = lines.length * lineHeight;
    const y0 = zone.y + Math.max(0, (zone.height - blockH) / 2);
    lines.forEach((line, i) => {
      ctx.fillText(line, zone.x + zone.width / 2, y0 + i * lineHeight, zone.width);
    });
  }

  // -- stickers (zIndex order; center-anchored, scaled, rotated) -------------
  const byId = new Map(items.map((i) => [i.itemId ?? i.imageUrl ?? "", i] as const));
  const placements = [...layout.placements].sort((a, b) => a.zIndex - b.zIndex);
  // Step-2 diagnosability: silent "no item row for placement" skips used to
  // be indistinguishable from an empty layout (the blank scoring-card bug).
  // Count both skip classes and log a summary after the loop.
  let skippedNoItem = 0;
  let skippedLoadFailed = 0;
  for (const pl of placements) {
    const item = byId.get(pl.itemId);
    if (!item) {
      skippedNoItem++;
      console.error(`[card-render] no item row for placement ${pl.itemId} — skipped`);
      continue;
    }
    let img: Image;
    try {
      img = await loadStickerImage(item, storageDir);
    } catch (err) {
      skippedLoadFailed++;
      console.error(
        `[card-render] failed to load image for item ${pl.itemId} — skipped:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const m = mapPlacement(pl, { width: item.width, height: item.height }, width, height, ratioW, ratioH);
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate((m.rotation * Math.PI) / 180);
    if (finalPass) {
      // Feathered blending: draw the sticker into a scratch canvas of its
      // mapped size, fade the alpha out over MONTAGE_FEATHER_FRACTION ×
      // drawn width per edge (destination-in with linear gradients), then
      // composite — overlapping stickers blend like a collage instead of
      // hard-edge pasting. Crisp die-cut edges stay the DEFAULT (no
      // finalPass) so build-phase renders are byte-identical.
      const feathered = featherSticker(img, m.width, m.height);
      ctx.drawImage(feathered, -m.width / 2, -m.height / 2, m.width, m.height);
    } else {
      ctx.drawImage(img, -m.width / 2, -m.height / 2, m.width, m.height);
    }
    ctx.restore();
  }

  // Step-2 diagnosability: summarize the silent skips so a blank/partial card
  // render is immediately attributable to missing item rows vs. unloadable
  // sticker images (and never mistaken for an intentionally empty layout).
  if (skippedNoItem > 0 || skippedLoadFailed > 0) {
    console.warn(
      `[card-render] placement summary: ${placements.length} requested, ` +
        `${placements.length - skippedNoItem - skippedLoadFailed} drawn, ` +
        `${skippedNoItem} skipped (no item row), ${skippedLoadFailed} skipped (load failed) ` +
        `— items supplied: ${items.length}`,
    );
  }

  // -- final-montage grading (finalPass only; see RenderCardOptions) --------
  if (finalPass) applyGrading(canvas, ctx, grading ?? null);

  return canvas.encode("png");
}

/** Options for {@link composeGreetingOnPoster}. */
export interface ComposeGreetingOnPosterOptions {
  /** Montage grading applied AFTER the band + text (style-pack derived —
   *  see deriveGradingFromStyle). Default null (no grading). */
  grading?: MontageGrading | null;
}

/**
 * Composite the greeting onto a full-bleed montage POSTER (AI-generated).
 *
 * Why this exists: the montage_prompt template deliberately tells the image
 * model to leave the lower third of the poster open and to NOT render the
 * greeting ("Greeting text (to leave room for, do NOT render it in the
 * image)") — the raw generated image therefore ships without the card's
 * message unless something draws it. This helper is that something: it loads
 * the poster at its NATIVE size, draws a soft translucent paper-tone band
 * across the lower third (the same tone family as the sticker card's
 * greeting zone), then draws the greeting centered in that band using the
 * same font conventions as renderCardPng's greeting text (Georgia serif,
 * dark #3a3230, centered) with the mock poster's auto-shrink-to-fit sizing
 * (start 0.07 × width, shrink until the wrapped block fits the band).
 *
 * Guards (fail-safe, never fail the poster):
 *  - empty/whitespace greeting → the poster is returned UNCHANGED
 *    (byte-identical) unless grading is supplied, in which case the poster
 *    is re-encoded through the grading pass only;
 *  - undecodable poster bytes → throws (the caller falls back to persisting
 *    the raw bytes).
 *
 * The output is always a fresh PNG encode at the poster's native dimensions
 * (input bytes are normalized through sharp first, so any decodable format
 * works as input).
 */
export async function composeGreetingOnPoster(
  posterPng: Buffer,
  greeting: string,
  opts: ComposeGreetingOnPosterOptions = {},
): Promise<Buffer> {
  const text = greeting.trim();
  if (!text && !opts.grading) return posterPng;

  // Normalize through sharp so any decodable input (png/jpeg/webp) becomes a
  // PNG @napi-rs/canvas can draw (same normalization as loadStickerImage).
  const png = await sharp(posterPng).png().toBuffer();
  const img = await loadImage(png);
  const width = img.width;
  const height = img.height;
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  if (text) {
    const bandH = Math.max(1, Math.round(height * POSTER_BAND_FRACTION));
    const bandY = height - bandH;
    const inset = Math.round(width * POSTER_BAND_INSET_FRACTION);
    const radius = Math.round(width * POSTER_BAND_RADIUS_FRACTION);

    // Soft readability band: translucent rounded rect in the lower third,
    // paper tone (PAPER_COLOR family) so dark greeting text reads over any
    // artwork — the poster equivalent of the sticker card's paper band.
    ctx.save();
    ctx.fillStyle = `rgba(250, 245, 236, ${POSTER_BAND_ALPHA})`;
    ctx.beginPath();
    ctx.roundRect(inset, bandY, width - 2 * inset, bandH, radius);
    ctx.fill();
    ctx.restore();

    // Greeting text: renderCardPng's conventions (Georgia serif, dark
    // #3a3230, centered) with the mock's auto-shrink-to-fit sizing loop.
    ctx.fillStyle = "#3a3230";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const maxTextWidth = width - 2 * Math.round(width * POSTER_TEXT_INSET_FRACTION);
    const minSize = Math.max(8, Math.round(width * POSTER_FONT_MIN_FRACTION));
    const step = Math.max(1, Math.round(width * POSTER_FONT_STEP_FRACTION));
    let fontSize = Math.max(8, Math.round(width * POSTER_FONT_START_FRACTION));
    let lines: string[];
    for (;;) {
      ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
      lines = wrapText(ctx, text, maxTextWidth);
      if (
        lines.length * fontSize * 1.25 <= bandH * POSTER_TEXT_MAX_BAND_FRACTION ||
        fontSize <= minSize
      ) {
        break;
      }
      fontSize -= step;
    }
    const lineH = fontSize * 1.25;
    const startY = bandY + bandH / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, width / 2, startY + i * lineH, maxTextWidth);
    });
  }

  // Grading LAST — the same order as renderCardPng's finalPass (grade the
  // finished composite, text included, so the whole poster reads as one).
  if (opts.grading) applyGrading(canvas, ctx, opts.grading);

  return canvas.encode("png");
}

/**
 * Draw `img` at the given mapped size into a scratch canvas and fade its
 * alpha to 0 over MONTAGE_FEATHER_FRACTION × drawn width per edge via
 * destination-in linear gradients (color is irrelevant — only the gradient's
 * alpha reaches the destination-in mask). Edge bands are ≥ 1px so
 * sub-pixel stickers still blend. Returns the scratch canvas to composite.
 */
function featherSticker(
  img: Image,
  width: number,
  height: number,
): Canvas {
  const scratch: Canvas = createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  const sctx = scratch.getContext("2d");
  sctx.drawImage(img, 0, 0, scratch.width, scratch.height);
  const w = scratch.width;
  const h = scratch.height;
  const fx = Math.max(1, Math.round(w * MONTAGE_FEATHER_FRACTION));
  const fy = Math.max(1, Math.round(h * MONTAGE_FEATHER_FRACTION));

  // BUG-FIX (2026 step): the previous implementation applied
  // `destination-in` FOUR times — once per edge band. Each pass ERASED
  // everything outside its own band, so after four passes the entire
  // scratch canvas was fully transparent (every feathered finalPass
  // sticker rendered zero pixels). Fix: build a single feather MASK
  // (opaque center rect + semi-transparent edge gradients painted
  // source-over onto transparency), then apply destination-in ONCE.

  // Guards: no feathering requested, or the feather bands already cover
  // the whole canvas (sub-2×feather tiny stickers) → return as-is.
  if (MONTAGE_FEATHER_FRACTION <= 0) return scratch;
  if (fx * 2 >= w || fy * 2 >= h) return scratch;

  const mask: Canvas = createCanvas(w, h);
  const mctx = mask.getContext("2d");

  // Center region: fully opaque white (color irrelevant — only alpha
  // feeds destination-in). Must NOT be filled across the whole mask:
  // the semi-transparent edge gradients are painted source-over onto
  // transparency below, so a full opaque base would make every edge
  // opaque too and kill the feather.
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(fx, fy, w - 2 * fx, h - 2 * fy);

  const edge = (
    gx0: number, gy0: number, gx1: number, gy1: number,
    a0: number, a1: number,
    rx: number, ry: number, rw: number, rh: number,
  ): void => {
    const g = mctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, `rgba(255, 255, 255, ${a0})`);
    g.addColorStop(1, `rgba(255, 255, 255, ${a1})`);
    mctx.fillStyle = g;
    mctx.fillRect(rx, ry, rw, rh);
  };
  edge(0, 0, fx, 0, 0, 1, 0, 0, fx, h); // left: transparent → opaque
  edge(w - fx, 0, w, 0, 1, 0, w - fx, 0, fx, h); // right: opaque → transparent
  edge(0, 0, 0, fy, 0, 1, 0, 0, w, fy); // top: transparent → opaque
  edge(0, h - fy, 0, h, 1, 0, 0, h - fy, w, h); // bottom: opaque → transparent

  // Single destination-in pass with the composed feather mask.
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(mask, 0, 0);
  sctx.globalCompositeOperation = "source-over";
  return scratch;
}

/**
 * Final-montage color grading, in order: temperature tint overlay (warm /
 * cool), saturation + contrast, radial vignette. Saturation/contrast use
 * `ctx.filter` — CHOICE DOCUMENTED: @napi-rs/canvas implements ctx.filter
 * (CanvasFilters in its typings; runtime-verified that saturate/contrast
 * reach drawn pixels), so no sharp post-processing pass is needed — the
 * whole grade stays inside the single canvas encode.
 */
function applyGrading(
  canvas: Canvas,
  ctx: SKRSContext2D,
  grading: MontageGrading | null,
): void {
  if (!grading) return;
  const { width, height } = canvas;
  // (1) Temperature tint: translucent warm/cool wash over the whole card.
  if (grading.temperature !== 0) {
    ctx.save();
    ctx.globalAlpha = TEMPERATURE_TINT_MAX_ALPHA * Math.abs(grading.temperature);
    ctx.fillStyle = grading.temperature > 0 ? WARM_TINT : COOL_TINT;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
  // (2) Saturation + contrast via ctx.filter: redraw a snapshot of the card
  // onto itself through the filter (an opaque full-cover draw replaces the
  // pixels 1:1). Skipped entirely at the identity values.
  if (grading.saturation !== 1 || grading.contrast !== 1) {
    const snap: Canvas = createCanvas(width, height);
    snap.getContext("2d").drawImage(canvas, 0, 0);
    ctx.filter = `saturate(${grading.saturation}) contrast(${grading.contrast})`;
    ctx.drawImage(snap, 0, 0);
    ctx.filter = "none";
  }
  // (3) Vignette: radial gradient (transparent inside, black at the
  // corners) with globalAlpha = vignette strength.
  if (grading.vignette > 0) {
    const r = Math.hypot(width, height) / 2;
    const g = ctx.createRadialGradient(
      width / 2, height / 2, r * VIGNETTE_INNER_FRACTION,
      width / 2, height / 2, r,
    );
    g.addColorStop(0, "rgba(0, 0, 0, 0)");
    g.addColorStop(1, "rgba(0, 0, 0, 1)");
    ctx.save();
    ctx.globalAlpha = grading.vignette;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Greedy word wrap; a single over-long word overflows (never splits words). */
function wrapText(
  ctx: { measureText(text: string): { width: number } },
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const STATIC_ITEM_PATTERN = /^\/static\/items\/([\w-]+)\.png$/;

/**
 * Resolve + decode one sticker image.
 *  1. imagePath → direct fs read (tests, tools).
 *  2. imageUrl "/static/items/{itemId}.png" → direct fs read from the storage
 *     dir (NO HTTP round-trip — the file is local by construction).
 *  3. data URL → in-memory decode.
 * Anything else (remote http URLs…) is rejected — production item rows always
 * match (2) or (3).
 */
async function loadStickerImage(
  item: RenderableItem,
  storageDir: string,
): Promise<Image> {
  let raw: Buffer | null = null;
  if (item.imagePath) {
    raw = await readFile(item.imagePath);
  } else if (typeof item.imageUrl === "string") {
    const staticMatch = STATIC_ITEM_PATTERN.exec(item.imageUrl);
    if (staticMatch) {
      // (\w-) ids are guarded at submission time — safe to interpolate.
      raw = await readFile(path.join(storageDir, `${staticMatch[1]}.png`));
    } else {
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(item.imageUrl);
      if (dataUrl) raw = Buffer.from(dataUrl[2]!, "base64");
    }
  }
  if (!raw) {
    throw new Error(
      `unsupported image reference${item.imageUrl ? ` "${item.imageUrl.slice(0, 80)}"` : " (none)"}`,
    );
  }
  // Normalize through sharp so any decodable input (webp/jpeg/png) becomes a
  // PNG @napi-rs/canvas can draw; alpha (die-cut transparency) is preserved.
  const png = await sharp(raw).png().toBuffer();
  return loadImage(png);
}
