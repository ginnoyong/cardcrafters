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

import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import sharp from "sharp";

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

  const canvas = createCanvas(width, height);
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
  for (const pl of placements) {
    const item = byId.get(pl.itemId);
    if (!item) {
      console.error(`[card-render] no item row for placement ${pl.itemId} — skipped`);
      continue;
    }
    let img: Image;
    try {
      img = await loadStickerImage(item, storageDir);
    } catch (err) {
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
    ctx.drawImage(img, -m.width / 2, -m.height / 2, m.width, m.height);
    ctx.restore();
  }

  return canvas.encode("png");
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
