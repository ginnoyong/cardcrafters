/**
 * Mock AI provider (Step 4) — first-class, deterministic-ish heuristics so the
 * FULL game runs with zero API keys and zero network.
 *
 * Design notes:
 *  - Every structured output is validated against the SAME zod schema the
 *    real provider must satisfy (item_image is exempt — binary output), so
 *    downstream game flow can trust result shapes in either mode.
 *  - Results are deterministic per input (hash-seeded) except where noted,
 *    which keeps tests and demos reproducible.
 *  - A small artificial latency (MOCK_AI_DELAY_MS, default 25) exercises the
 *    async paths the real provider has.
 *  - Mock calls cost $0 and never count against the per-game AI budget.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

import {
  CARD_COORD_SPACE,
  MAX_PROMPT_WORDS,
  countWords,
  greetingVariationsSchema,
  layoutCompositionSchema,
  moderationSchema,
  promptValidationSchema,
  styleDerivationSchema,
} from "@cardcrafters/shared";

import { AiTaskError } from "./errors";
import type { AiCallResult, AiProvider, AiTaskName, TaskConfig } from "./provider";

/** Re-exported for router typing convenience. */
export type { AiProvider };

/** Abstract-word / mood blocklist: single words match on word boundaries,
 *  multi-word phrases match as substrings of the whole prompt (case-insensitive). */
const ABSTRACT_BLOCKLIST: readonly string[] = [
  "happiness",
  "happy vibes",
  "joy",
  "joyful",
  "love",
  "warmth",
  "serenity",
  "serene",
  "nostalgia",
  "nostalgic",
  "elegance",
  "make it elegant",
  "bliss",
  "melancholy",
  "cozy vibes",
  "cozy feeling",
  "romantic atmosphere",
  "festive feeling",
  "christmas spirit",
  "holiday cheer",
  "good vibes",
  "spooky vibes",
  "dreamy atmosphere",
  "magical feeling",
  "positive energy",
  "inner peace",
  "peaceful feeling",
  "warm feelings",
];

/** Concrete, visible example fixes offered when a prompt is rejected. */
const EXAMPLE_FIXES: readonly string[] = [
  "a golden retriever wearing a party hat",
  "a birthday cake with candles",
  "a red balloon dog",
  "a snowman with a scarf",
  "a smiling sunflower",
  "a paper boat on waves",
];

export interface MockProviderOptions {
  env?: NodeJS.ProcessEnv;
}

export class MockProvider implements AiProvider {
  private readonly delayMs: number;

  constructor(opts: MockProviderOptions = {}) {
    const env = opts.env ?? process.env;
    const parsed = Number(env.MOCK_AI_DELAY_MS);
    this.delayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 25;
  }

  async run(
    task: AiTaskName,
    input: Record<string, unknown>,
    cfg: TaskConfig,
  ): Promise<AiCallResult> {
    const started = Date.now();
    if (this.delayMs > 0) await sleep(this.delayMs);
    const latencyMs = Date.now() - started;
    const model = `mock/${task}`;
    if (task === "item_image") {
      // Binary output: return the full AiCallResult (imageBase64 etc.), not { data }.
      const img = mockImageResult(input);
      return { ...img, model, latencyMs: img.latencyMs + latencyMs };
    }
    const data = this.compute(task, input);
    return { data, model, latencyMs };
  }

  /** Dispatch + schema validation. Internal so tests can call it synchronously. */
  private compute(task: AiTaskName, input: Record<string, unknown>): unknown {
    let data: unknown;
    switch (task) {
      case "prompt_validation":
        data = mockPromptValidation(input);
        break;
      case "moderation":
        data = mockModeration(input);
        break;
      case "greeting_variations":
        data = mockGreetingVariations(input);
        break;
      case "style_derivation":
        data = mockStyleDerivation(input);
        break;
      case "layout_composition":
        data = mockLayoutComposition(input);
        break;
      case "layout_critique":
        throw new AiTaskError({
          task,
          model: `mock/${task}`,
          retryable: false,
          message: "layout_critique is disabled in config/ai-tasks.json",
        });
      case "item_image":
        // Handled in run() (binary output path); unreachable here.
        throw new AiTaskError({
          task,
          model: `mock/${task}`,
          retryable: false,
          message: "item_image is handled by the binary path in run()",
        });
      default: {
        const never: never = task;
        throw new AiTaskError({
          task: String(never),
          retryable: false,
          message: "unknown task",
        });
      }
    }
    // Validate against the task's zod schema before returning (image exempt).
    const schemaFor: Partial<Record<AiTaskName, ZodLike>> = {
      prompt_validation: promptValidationSchema,
      moderation: moderationSchema,
      greeting_variations: greetingVariationsSchema,
      style_derivation: styleDerivationSchema,
      layout_composition: layoutCompositionSchema,
    };
    const schema = schemaFor[task];
    if (schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new AiTaskError({
          task,
          model: `mock/${task}`,
          retryable: false,
          message: `mock provider produced schema-invalid output: ${parsed.error?.message ?? "unknown"}`,
        });
      }
      return parsed.data;
    }
    return data;
  }
}

type ZodLike = { safeParse(data: unknown): { success: boolean; data?: unknown; error?: { message: string } } };

// ---------------------------------------------------------------------------
// Task implementations
// ---------------------------------------------------------------------------

function mockPromptValidation(input: Record<string, unknown>): unknown {
  const prompt = String(input.prompt ?? "").trim();
  const words = countWords(prompt);

  if (words === 0) {
    return promptValidationSchema.parse({
      valid: false,
      reason: "The prompt is empty — describe something visible you want as a sticker.",
      normalized_subject: "a sticker",
      example_fix: EXAMPLE_FIXES[0],
    });
  }
  if (words > MAX_PROMPT_WORDS) {
    return promptValidationSchema.parse({
      valid: false,
      reason: `Prompts are limited to ${MAX_PROMPT_WORDS} words (yours has ${words}). Keep the visible subject and drop extra words.`,
      normalized_subject: prompt.toLowerCase(),
    });
  }

  const lower = prompt.toLowerCase();
  const hit = ABSTRACT_BLOCKLIST.find((entry) =>
    entry.includes(" ")
      ? prompt.toLowerCase().includes(entry)
      : new RegExp(`\\b${escapeRegex(entry)}\\b`, "i").test(prompt),
  );
  if (hit) {
    const fix = EXAMPLE_FIXES[hashString(`${prompt}:${hit}`) % EXAMPLE_FIXES.length];
    return promptValidationSchema.parse({
      valid: false,
      reason: `"${hit}" is a feeling or mood — stickers need something visible to draw.`,
      normalized_subject: prompt.toLowerCase(),
      example_fix: fix,
    });
  }

  return promptValidationSchema.parse({
    valid: true,
    reason: "",
    normalized_subject: prompt.toLowerCase(),
  });
}

function mockModeration(input: Record<string, unknown>): unknown {
  const prompt = String(input.prompt ?? "");
  if (prompt.toLowerCase().includes("unsafe test")) {
    return moderationSchema.parse({
      safe: false,
      category: "other",
      reason: "Mock moderation: prompt contains the 'unsafe test' sentinel.",
    });
  }
  return moderationSchema.parse({
    safe: true,
    category: "none",
    reason: "Mock moderation: nothing flagged by the heuristic.",
  });
}

/** Greeting patterns; rotation by (theme, teamIndex) keeps per-team variety
 *  deterministic while guaranteeing distinct outputs for a fixed theme. */
const GREETING_PATTERNS: readonly ((theme: string) => string)[] = [
  (t) => `Happy ${t}!`,
  (t) => `Best ${t} wishes!`,
  (t) => `Cheers to ${t}!`,
  (t) => `A wonderful ${t}!`,
  (t) => `Sending ${t} smiles`,
  (t) => `Warmest ${t} thoughts`,
  (t) => `Here's to ${t}!`,
  (t) => `Sweetest ${t} ever`,
  (t) => `Celebrate the ${t}!`,
  (t) => `Joyful ${t} to you`,
];

function mockGreetingVariations(input: Record<string, unknown>): unknown {
  const theme = String(input.theme ?? "").trim() || "the occasion";
  const teamIndex = Number(input.teamIndex ?? 0) || 0;
  const requested = Number(input.count);
  const count = Math.min(10, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : 5));

  const seed = hashString(`${theme}:${teamIndex}`);
  const rotated = [
    ...GREETING_PATTERNS.slice(seed % GREETING_PATTERNS.length),
    ...GREETING_PATTERNS.slice(0, seed % GREETING_PATTERNS.length),
  ];
  const seen = new Set<string>();
  const variations: string[] = [];
  for (const pattern of rotated) {
    const text = pattern(theme).replace(/\s+/g, " ").trim();
    if (seen.has(text)) continue;
    seen.add(text);
    variations.push(text);
    if (variations.length === count) break;
  }
  // Defensive pad (patterns are distinct, so this never triggers in practice).
  let i = 2;
  while (variations.length < count) {
    variations.push(`${theme} — wish #${i++}`);
  }
  return greetingVariationsSchema.parse({ variations });
}

const STYLE_ADJECTIVES = [
  "Retro", "Soft", "Bold", "Playful", "Sunny", "Frosted", "Vintage", "Neon", "Pastel", "Doodle",
] as const;
const STYLE_NOUNS = [
  "Crayon Pop", "Paper Cutout", "Sticker Workshop", "Confetti Lab", "Candy Banner", "Storybook",
  "Felt Patch", "Comic Dot", "Watercolor Postcard", "Marker Sketch",
] as const;
const STYLE_MOODS = [
  "cheerful and bright", "warm and cozy", "playful and energetic", "calm and sweet",
  "festive and fun", "dreamy and soft",
] as const;

function mockStyleDerivation(input: Record<string, unknown>): unknown {
  const theme = String(input.theme ?? "").trim() || "a greeting card";
  const h = hashString(theme);
  const hue = h % 360;
  const styleName = `${STYLE_ADJECTIVES[h % STYLE_ADJECTIVES.length]} ${STYLE_NOUNS[(h >> 3) % STYLE_NOUNS.length]}`;
  return styleDerivationSchema.parse({
    styleName,
    palette: [
      hslToHex(hue, 70, 62),
      hslToHex((hue + 40) % 360, 65, 55),
      hslToHex((hue + 200) % 360, 60, 60),
      hslToHex((hue + 30) % 360, 25, 28),
      hslToHex((hue + 20) % 360, 35, 94),
    ],
    lineWeight: "medium",
    mood: STYLE_MOODS[(h >> 6) % STYLE_MOODS.length],
    imagePromptSuffix: "flat vector sticker illustration, clean shapes, white outline",
  });
}

// ---------------------------------------------------------------------------
// item_image — server-side sticker PNG via @napi-rs/canvas (no AI involved)
// ---------------------------------------------------------------------------

export const MOCK_IMAGE_SIZE = 256;
export const MOCK_IMAGE_MIME = "image/png";



type ShapeDrawer = { name: string; draw: (ctx: SKRSContext2D) => void };

const SHAPES: readonly ShapeDrawer[] = buildShapes();

/** Draw one of the 12 shapes with the hue implied by `prompt`; returns PNG base64. */
export function drawMockSticker(prompt: string): { base64: string; shape: string; hue: number } {
  const h = hashString(prompt);
  const hue = h % 360;
  const shape = SHAPES[h % SHAPES.length]!;
  const canvas = createCanvas(MOCK_IMAGE_SIZE, MOCK_IMAGE_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, MOCK_IMAGE_SIZE, MOCK_IMAGE_SIZE);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = `hsl(${hue}, 72%, 58%)`;
  ctx.shadowColor = `hsla(${hue}, 60%, 30%, 0.35)`;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 4;
  shape.draw(ctx);
  return { base64: canvas.toBuffer("image/png").toString("base64"), shape: shape.name, hue };
}

function mockImageResult(input: Record<string, unknown>): AiCallResult {
  const prompt = String(input.prompt ?? input.subject ?? "sticker");
  const { base64, shape, hue } = drawMockSticker(prompt);
  return {
    data: { shape, hue, width: MOCK_IMAGE_SIZE, height: MOCK_IMAGE_SIZE },
    model: "mock/item_image",
    latencyMs: 0,
    imageBase64: base64,
    imageMime: MOCK_IMAGE_MIME,
    imageWidth: MOCK_IMAGE_SIZE,
    imageHeight: MOCK_IMAGE_SIZE,
  };
}

/** Every shape fills+strokes (white outline) inside a centered box with margin. */
function buildShapes(): ShapeDrawer[] {
  const M = 48; // margin
  const S = MOCK_IMAGE_SIZE - M * 2; // drawable size
  const cx = MOCK_IMAGE_SIZE / 2;
  const cy = MOCK_IMAGE_SIZE / 2;

  const fillStroke = () => { ctxFill(); ctxStroke(); };
  let ctxRef: SKRSContext2D;
  const ctxFill = () => ctxRef.fill();
  const ctxStroke = () => ctxRef.stroke();

  return [
    {
      name: "star",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? S / 2 : S / 4.4;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const x = cx + r * Math.cos(a);
          const y = cy + r * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "heart",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        const top = cy - S / 4;
        ctx.moveTo(cx, cy + S * 0.42);
        ctx.bezierCurveTo(cx - S * 0.75, cy - S * 0.15, cx - S * 0.35, cy - S * 0.55, cx, top);
        ctx.bezierCurveTo(cx + S * 0.75, cy - S * 0.55, cx + S * 0.75, cy - S * 0.1, cx, cy + S * 0.42);
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "circle",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
        fillStroke();
      },
    },
    {
      name: "triangle",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.moveTo(cx, cy - S / 2);
        ctx.lineTo(cx + S / 2, cy + S / 2);
        ctx.lineTo(cx - S / 2, cy + S / 2);
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "balloon",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.ellipse(cx, cy - S * 0.12, S * 0.32, S * 0.38, 0, 0, Math.PI * 2);
        fillStroke();
        ctx.beginPath();
        ctx.moveTo(cx - 8, cy + S * 0.26);
        ctx.lineTo(cx + 8, cy + S * 0.26);
        ctx.lineTo(cx, cy + S * 0.36);
        ctx.closePath();
        fillStroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy + S * 0.36);
        ctx.quadraticCurveTo(cx + 18, cy + S * 0.52, cx, cy + S * 0.62);
        ctx.stroke();
      },
    },
    {
      name: "gift box",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.rect(cx - S * 0.38, cy - S * 0.05, S * 0.76, S * 0.55);
        fillStroke();
        ctx.beginPath();
        ctx.rect(cx - S * 0.42, cy - S * 0.28, S * 0.84, S * 0.24);
        fillStroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - S * 0.05);
        ctx.lineTo(cx, cy + S * 0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(cx - 14, cy - S * 0.36, 12, 9, -0.4, 0, Math.PI * 2);
        ctx.ellipse(cx + 14, cy - S * 0.36, 12, 9, 0.4, 0, Math.PI * 2);
        fillStroke();
      },
    },
    {
      name: "flower",
      draw: (ctx) => {
        ctxRef = ctx;
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          ctx.beginPath();
          ctx.ellipse(cx + (S * 0.22) * Math.cos(a), cy - S * 0.08 + (S * 0.22) * Math.sin(a), S * 0.16, S * 0.16, 0, 0, Math.PI * 2);
          fillStroke();
        }
        ctx.beginPath();
        ctx.arc(cx, cy - S * 0.08, S * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = `hsl(40, 80%, 55%)`;
        ctx.beginPath();
        ctx.arc(cx, cy - S * 0.08, S * 0.08, 0, Math.PI * 2);
        ctx.fill();
      },
    },
    {
      name: "cloud",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.arc(cx - S * 0.22, cy, S * 0.18, 0, Math.PI * 2);
        ctx.arc(cx, cy - S * 0.12, S * 0.24, 0, Math.PI * 2);
        ctx.arc(cx + S * 0.24, cy, S * 0.2, 0, Math.PI * 2);
        ctx.rect(cx - S * 0.22, cy, S * 0.46, S * 0.2);
        fillStroke();
      },
    },
    {
      name: "cupcake",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.26, cy);
        ctx.lineTo(cx + S * 0.26, cy);
        ctx.lineTo(cx + S * 0.18, cy + S * 0.4);
        ctx.lineTo(cx - S * 0.18, cy + S * 0.4);
        ctx.closePath();
        fillStroke();
        ctx.beginPath();
        ctx.arc(cx, cy - S * 0.1, S * 0.24, Math.PI, 0);
        ctx.closePath();
        fillStroke();
        ctx.beginPath();
        ctx.arc(cx, cy - S * 0.38, S * 0.07, 0, Math.PI * 2);
        fillStroke();
      },
    },
    {
      name: "musical note",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.ellipse(cx - S * 0.14, cy + S * 0.28, S * 0.16, S * 0.12, -0.3, 0, Math.PI * 2);
        fillStroke();
        ctx.beginPath();
        ctx.moveTo(cx + S * 0.01, cy + S * 0.26);
        ctx.lineTo(cx + S * 0.01, cy - S * 0.36);
        ctx.quadraticCurveTo(cx + S * 0.22, cy - S * 0.34, cx + S * 0.26, cy - S * 0.18);
        ctx.stroke();
      },
    },
    {
      name: "lightning bolt",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.moveTo(cx + S * 0.1, cy - S * 0.5);
        ctx.lineTo(cx - S * 0.24, cy + S * 0.06);
        ctx.lineTo(cx - S * 0.02, cy + S * 0.06);
        ctx.lineTo(cx - S * 0.1, cy + S * 0.5);
        ctx.lineTo(cx + S * 0.26, cy - S * 0.08);
        ctx.lineTo(cx + S * 0.02, cy - S * 0.08);
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "smiley",
      draw: (ctx) => {
        ctxRef = ctx;
        ctx.beginPath();
        ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
        fillStroke();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(cx - S * 0.16, cy - S * 0.12, S * 0.07, 0, Math.PI * 2);
        ctx.arc(cx + S * 0.16, cy - S * 0.12, S * 0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy + S * 0.04, S * 0.24, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.lineWidth = 8;
        ctx.stroke();
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// layout_composition — seeded, plausible layout proposal
// ---------------------------------------------------------------------------

interface MockLayoutItem {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  weight?: unknown;
  order?: unknown;
}

function mockLayoutComposition(input: Record<string, unknown>): unknown {
  const rnd = mulberry32(hashString(JSON.stringify(input)));
  const items = Array.isArray(input.items) ? (input.items as MockLayoutItem[]) : [];
  const ids = items.map((it, i) => (typeof it?.id === "string" && it.id ? it.id : `item-${i + 1}`));

  // Golden-ratio focal point with a gentle nudge.
  const focalX = clamp(CARD_COORD_SPACE * 0.618 + (rnd() - 0.5) * 80, 120, CARD_COORD_SPACE - 120);
  const focalY = clamp(CARD_COORD_SPACE * 0.382 + (rnd() - 0.5) * 60, 120, CARD_COORD_SPACE - 120);

  const groups: { itemIds: string[]; cx: number; cy: number; spread: number }[] = [];
  if (ids.length === 0) {
    // Schema requires ≥1 group with ≥1 id; flows always pass items — this is a
    // placeholder group so the mock stays schema-valid on degenerate input.
    groups.push({ itemIds: ["__no_items__"], cx: focalX, cy: focalY, spread: 60 });
  } else if (ids.length >= 4 && rnd() > 0.5) {
    const mid = Math.ceil(ids.length / 2);
    groups.push({ itemIds: ids.slice(0, mid), cx: clamp(focalX - 90, 80, 920), cy: focalY, spread: 130 + rnd() * 40 });
    groups.push({ itemIds: ids.slice(mid), cx: clamp(focalX + 90, 120, CARD_COORD_SPACE - 120), cy: clamp(focalY + 70, 120, CARD_COORD_SPACE - 120), spread: 110 + rnd() * 40 });
  } else {
    groups.push({ itemIds: ids, cx: focalX, cy: focalY, spread: 120 + rnd() * 60 });
  }

  const textZone = { x: 60, y: 40, w: CARD_COORD_SPACE - 120, h: 280 };
  return layoutCompositionSchema.parse({
    focalPoint: { x: focalX, y: focalY },
    groups,
    textZone,
    suggestedGreetingStyle: {
      font: "Inter",
      color: "#1f2937",
      align: "center",
      y: textZone.y + textZone.h / 2,
    },
  });
}

// ---------------------------------------------------------------------------
// Deterministic helpers (hash / PRNG / color)
// ---------------------------------------------------------------------------

/** djb2-ish 32-bit string hash. */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** mulberry32 PRNG — tiny, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** hsl() → "#rrggbb". */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) =>
    lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}