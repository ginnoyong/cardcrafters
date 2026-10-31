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
  layoutMontageSchema,
  moderationSchema,
  montagePromptSchema,
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

/** Contentious public figures (politicians + criminals): prompts referencing
 *  them are blocked as category 'contentious_figure'. Single words match on
 *  word boundaries, multi-word phrases as substrings (case-insensitive).
 *  Celebrities (Elvis, etc.) are deliberately NOT on this list. */
const CONTENTIOUS_FIGURES: readonly string[] = [
  "putin",
  "biden",
  "trump",
  "hitler",
  "stalin",
  "bin laden",
  "epstein",
  "manson",
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
    if (task === "montage_image") {
      // Binary output (like item_image): the procedural 800×1120 poster is
      // returned as the full AiCallResult, not a { data } payload.
      const img = mockMontageImageResult(input);
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
        // The critique scheduler short-circuits mock mode BEFORE calling the
        // router, so this branch is a deterministic safety net (tests, or any
        // future direct mock call): a fixed passing verdict — never a
        // heuristic, never a network call.
        data = { score: 80, issues: [], focalOk: true };
        break;
      case "layout_montage":
        // The montage module short-circuits mock mode BEFORE calling the
        // router, so this branch is a deterministic safety net for direct
        // calls (tests, or any future direct mock call): the regular layout
        // composition, tagged with fixed montage options (strategy
        // "character_montage", relaxOverlap false) — never a network call.
        data = mockLayoutMontage(input);
        break;
      case "montage_prompt":
        // Deterministic canned poster prompt: hash-seeded flavor words +
        // theme + greeting + subjects joined. Validated against
        // montagePromptSchema below (same belt-and-braces as other tasks).
        data = mockMontagePrompt(input);
        break;
      case "item_image":
        // Handled in run() (binary output path); unreachable here.
        throw new AiTaskError({
          task,
          model: `mock/${task}`,
          retryable: false,
          message: "item_image is handled by the binary path in run()",
        });
      case "montage_image":
        // Handled in run() (binary output path); unreachable here.
        throw new AiTaskError({
          task,
          model: `mock/${task}`,
          retryable: false,
          message: "montage_image is handled by the binary path in run()",
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
      layout_montage: layoutMontageSchema,
      montage_prompt: montagePromptSchema,
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
  const lower = prompt.toLowerCase();
  const figure = CONTENTIOUS_FIGURES.find((entry) =>
    entry.includes(" ")
      ? lower.includes(entry)
      : new RegExp(`\\b${escapeRegex(entry)}\\b`, "i").test(lower),
  );
  if (figure) {
    return moderationSchema.parse({
      safe: false,
      category: "contentious_figure",
      reason: `Mock moderation: "${figure}" is a contentious public figure — prompts referencing them are blocked.`,
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

/** Exported so tests can assert the shape pool + its distribution. */
export const SHAPES: readonly ShapeDrawer[] = buildShapes();

/**
 * Seed for shape/hue selection. Plain `hashString(prompt) % N` is BIASED for
 * sticker prompts: djb2's low bits are a plain character checksum — since
 * 33·h ≡ h (mod 32), the low 5 bits of the hash are just 5381 + Σ chars
 * (mod 32) — and with a bucket count like 12 = 4·3 the mod-4 component of
 * the bucket comes from that letter checksum. Short, similar prompts (rhymes,
 * one-word color swaps, anagrams) therefore cluster into neighboring buckets.
 * BEFORE (measured with a tsx probe, `djb2 % 12`, 12-shape pool):
 *   - 105 varied prompts: gift box 12%, lightning bolt 11%, star 10%, …
 *     circle 6% — acceptable, BUT:
 *   - 50 in-game-style prompts ("a red/blue/green balloon", "red star",
 *     …): star 16%, heart/lightning/circle 10–14%, and 6 of the 12 shapes
 *     are roundish (circle, smiley, balloon, cloud, flower, heart), so the
 *     rendered stickers read as "mostly circles" at sticker scale.
 * Fix: avalanche the hash (murmur3 fmix32) and mix in the prompt length plus
 * the first/last characters (which djb2 underweights for short strings)
 * BEFORE taking the bucket modulo. AFTER (same probes re-run against the
 * final 20-shape pool with a fresh tsx probe):
 * 105 varied prompts: 19/20 shapes used (only balloon unused), spread
 * 2–12% per shape (worst bucket triangle 12%); 50 similar in-game prompts
 * hit ALL 20 distinct shapes (worst bucket flower 10%); roundish shapes
 * (6 of 20) took 32–34% of selections in both samples.
 */
function stickerSeed(prompt: string): number {
  let h = hashString(prompt) ^ Math.imul(prompt.length, 0x9e3779b9);
  h ^= (prompt.charCodeAt(0) ?? 0) + ((prompt.charCodeAt(prompt.length - 1) ?? 0) << 8);
  // murmur3 fmix32 finalizer — full avalanche before the modulo.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Draw one of the mock sticker shapes with the hue implied by `prompt`; returns PNG base64. */
export function drawMockSticker(prompt: string): { base64: string; shape: string; hue: number } {
  const seed = stickerSeed(prompt);
  const hue = seed % 360;
  const shape = SHAPES[seed % SHAPES.length]!;
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
    {
      name: "tree",
      draw: (ctx) => {
        ctxRef = ctx;
        // trunk
        ctx.beginPath();
        ctx.rect(cx - S * 0.09, cy + S * 0.18, S * 0.18, S * 0.32);
        fillStroke();
        // bottom tier
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.42, cy + S * 0.24);
        ctx.lineTo(cx + S * 0.42, cy + S * 0.24);
        ctx.lineTo(cx, cy - S * 0.08);
        ctx.closePath();
        fillStroke();
        // top tier
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.3, cy - S * 0.02);
        ctx.lineTo(cx + S * 0.3, cy - S * 0.02);
        ctx.lineTo(cx, cy - S * 0.42);
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "cat",
      draw: (ctx) => {
        ctxRef = ctx;
        // ears first so the head outline reads in front of them
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.3, cy - S * 0.1);
        ctx.lineTo(cx - S * 0.36, cy - S * 0.46);
        ctx.lineTo(cx - S * 0.04, cy - S * 0.24);
        ctx.closePath();
        fillStroke();
        ctx.beginPath();
        ctx.moveTo(cx + S * 0.3, cy - S * 0.1);
        ctx.lineTo(cx + S * 0.36, cy - S * 0.46);
        ctx.lineTo(cx + S * 0.04, cy - S * 0.24);
        ctx.closePath();
        fillStroke();
        // head
        ctx.beginPath();
        ctx.ellipse(cx, cy + S * 0.1, S * 0.36, S * 0.33, 0, 0, Math.PI * 2);
        fillStroke();
        // eyes
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(cx - S * 0.13, cy + S * 0.02, S * 0.045, 0, Math.PI * 2);
        ctx.arc(cx + S * 0.13, cy + S * 0.02, S * 0.045, 0, Math.PI * 2);
        ctx.fill();
        // whiskers
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.2, cy + S * 0.16);
        ctx.lineTo(cx - S * 0.42, cy + S * 0.12);
        ctx.moveTo(cx - S * 0.2, cy + S * 0.22);
        ctx.lineTo(cx - S * 0.42, cy + S * 0.24);
        ctx.moveTo(cx + S * 0.2, cy + S * 0.16);
        ctx.lineTo(cx + S * 0.42, cy + S * 0.12);
        ctx.moveTo(cx + S * 0.2, cy + S * 0.22);
        ctx.lineTo(cx + S * 0.42, cy + S * 0.24);
        ctx.lineWidth = 6;
        ctx.stroke();
      },
    },
    {
      name: "sun",
      draw: (ctx) => {
        ctxRef = ctx;
        // rays first; the disc's fill+stroke covers their inner ends
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          const bx = cx + S * 0.3 * Math.cos(a);
          const by = cy + S * 0.3 * Math.sin(a);
          const px = -Math.sin(a) * S * 0.07;
          const py = Math.cos(a) * S * 0.07;
          ctx.beginPath();
          ctx.moveTo(bx + px, by + py);
          ctx.lineTo(cx + S * 0.48 * Math.cos(a), cy + S * 0.48 * Math.sin(a));
          ctx.lineTo(bx - px, by - py);
          ctx.closePath();
          fillStroke();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, S * 0.24, 0, Math.PI * 2);
        fillStroke();
      },
    },
    {
      name: "moon",
      draw: (ctx) => {
        ctxRef = ctx;
        // crescent opening right: outer arc the long way round, inner arc back.
        // Geometry (R = outer radius, inner circle offset 0.55R with r = 0.8R):
        // intersections sit at angle ±0.925 on the outer circle, ±1.505 on the inner.
        const R = S * 0.46;
        ctx.beginPath();
        ctx.arc(cx, cy, R, -0.925, 0.925, true);
        ctx.arc(cx + R * 0.55, cy, R * 0.8, 1.505, -1.505, false);
        ctx.closePath();
        fillStroke();
      },
    },
    {
      name: "rainbow",
      draw: (ctx) => {
        ctxRef = ctx;
        // three concentric half-annulus bands on a flat baseline
        const base = cy + S * 0.32;
        for (let i = 0; i < 3; i++) {
          const outer = S * 0.46 - i * 26;
          ctx.beginPath();
          ctx.arc(cx, base, outer, Math.PI, 0, false);
          ctx.arc(cx, base, outer - 13, 0, Math.PI, true);
          ctx.closePath();
          fillStroke();
        }
      },
    },
    {
      name: "snowflake",
      draw: (ctx) => {
        ctxRef = ctx;
        // six kite arms, each with two barb triangles, one path
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 3;
          const ux = Math.cos(a);
          const uy = Math.sin(a);
          const px = -uy;
          const py = ux;
          const tipX = cx + ux * S * 0.48;
          const tipY = cy + uy * S * 0.48;
          // arm kite (thin diamond from center to tip)
          ctx.moveTo(cx + px * S * 0.05, cy + py * S * 0.05);
          ctx.lineTo(cx + ux * S * 0.3 + px * S * 0.02, cy + uy * S * 0.3 + py * S * 0.02);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(cx + ux * S * 0.3 - px * S * 0.02, cy + uy * S * 0.3 - py * S * 0.02);
          ctx.closePath();
          // two barbs at ±60° from the arm, starting at 55% radius
          for (const sign of [-1, 1]) {
            const ba = a + sign * (Math.PI / 3);
            const ox = cx + ux * S * 0.28;
            const oy = cy + uy * S * 0.28;
            ctx.moveTo(ox, oy);
            ctx.lineTo(ox + Math.cos(ba) * S * 0.2, oy + Math.sin(ba) * S * 0.2);
            ctx.lineTo(
              ox + Math.cos(ba) * S * 0.14 - ux * S * 0.02,
              oy + Math.sin(ba) * S * 0.14 - uy * S * 0.02,
            );
            ctx.closePath();
          }
        }
        fillStroke();
      },
    },
    {
      name: "gem",
      draw: (ctx) => {
        ctxRef = ctx;
        // classic gem outline: table edge → girdle → culet
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.3, cy - S * 0.32);
        ctx.lineTo(cx + S * 0.3, cy - S * 0.32);
        ctx.lineTo(cx + S * 0.48, cy - S * 0.06);
        ctx.lineTo(cx, cy + S * 0.48);
        ctx.lineTo(cx - S * 0.48, cy - S * 0.06);
        ctx.closePath();
        fillStroke();
        // facet lines
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.3, cy - S * 0.32);
        ctx.lineTo(cx - S * 0.18, cy - S * 0.06);
        ctx.lineTo(cx, cy + S * 0.48);
        ctx.lineTo(cx + S * 0.18, cy - S * 0.06);
        ctx.lineTo(cx + S * 0.3, cy - S * 0.32);
        ctx.moveTo(cx - S * 0.48, cy - S * 0.06);
        ctx.lineTo(cx + S * 0.48, cy - S * 0.06);
        ctx.lineWidth = 6;
        ctx.stroke();
      },
    },
    {
      name: "house",
      draw: (ctx) => {
        ctxRef = ctx;
        // body
        ctx.beginPath();
        ctx.rect(cx - S * 0.32, cy - S * 0.06, S * 0.64, S * 0.52);
        fillStroke();
        // roof
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.4, cy - S * 0.06);
        ctx.lineTo(cx + S * 0.4, cy - S * 0.06);
        ctx.lineTo(cx, cy - S * 0.44);
        ctx.closePath();
        fillStroke();
        // door (white for contrast, like the flower centre)
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.rect(cx - S * 0.1, cy + S * 0.14, S * 0.2, S * 0.32);
        ctx.fill();
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
  /** The engine sends `visualWeight`; direct mock tests send `weight`. */
  visualWeight?: unknown;
  /** Normalized subject from prompt validation (semantic grouping input). */
  subject?: unknown;
}

function mockLayoutComposition(input: Record<string, unknown>): unknown {
  const rnd = mulberry32(hashString(JSON.stringify(input)));
  const items = Array.isArray(input.items) ? (input.items as MockLayoutItem[]) : [];
  const ids = items.map((it, i) => (typeof it?.id === "string" && it.id ? it.id : `item-${i + 1}`));
  // The hint is expressed in the CARD's own coordinate system (the same box
  // the solver lays out in), so the golden-ratio anchor must be computed from
  // the actual card dims — a 0..1000-space anchor on a portrait card lands
  // near the right edge / inside the text zone, where a v2-sized sticker
  // (solo ≈ 65% card area) cannot center without heavy shrinkage.
  const cardWidth = Number(input.cardWidth) > 0 ? Number(input.cardWidth) : CARD_COORD_SPACE;
  const cardHeight = Number(input.cardHeight) > 0 ? Number(input.cardHeight) : CARD_COORD_SPACE;

  // Golden-ratio focal point with a gentle nudge. For SMALL item counts the
  // v2 sizing policy makes each sticker huge (solo ≈ 65% card area), so an
  // off-center golden-ratio focal is physically unreachable at a good scale
  // (greeting text zone + safe margins force shrinkage) and the hint LOSES
  // the engine's with-vs-without score comparison. Bias the seeded focal
  // toward the card center for n ≤ 3 (jitter the golden anchor BEFORE the
  // lerp so the biased point keeps a clear margin away from the exact center
  // — a focal on the center would tie the hint-less run, which only wins by
  // RNG noise); larger compositions keep the classic golden-ratio placement.
  const goldenX = clamp(cardWidth * 0.618 + (rnd() - 0.5) * 80, 120, cardWidth - 120);
  const goldenY = clamp(cardHeight * 0.382 + (rnd() - 0.5) * 60, 120, cardHeight - 120);
  let focalX = goldenX;
  let focalY = goldenY;
  if (ids.length > 0 && ids.length <= 3) {
    // Full bias to the measured sweet spot (0.5w, 0.65h) — a 0.5 lerp measured
    // only 23/30 hint wins; the full target won 40/40 (craft probe).
    focalX = clamp(cardWidth * 0.5 + (rnd() - 0.5) * 80, 120, cardWidth - 120);
    focalY = clamp(cardHeight * 0.65 + (rnd() - 0.5) * 60, 120, cardHeight - 120);
  }

  const groups: {
    itemIds: string[];
    cx: number;
    cy: number;
    spread: number;
    subject?: string;
  }[] = [];
  // SEMANTIC GROUPING (deterministic approximation): adjacent INDEX PAIRS —
  // items 0-1 form one group, 2-3 the next, etc. (a trailing odd item joins
  // the last pair's group alone). Adjacent items come from adjacent creation
  // order, which the real model treats as a topic-continuity prior; the mock
  // just needs a plausible, schema-valid grouping.
  const subjects = items.map((it) =>
    typeof it?.subject === "string" && it.subject.trim() ? it.subject.trim() : null,
  );
  const pairs: string[][] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const pair = ids.slice(i, i + 2);
    // Odd trailing item: fold into the previous pair when one exists.
    if (pair.length === 1 && pairs.length > 0) pairs[pairs.length - 1]!.push(pair[0]!);
    else pairs.push(pair);
  }
  if (ids.length === 0) {
    // NOTE: no current caller passes an empty items array (flows always submit
    // ≥1 item); this placeholder group only exists so the mock stays
    // schema-valid on degenerate input instead of throwing a zod error.
    groups.push({ itemIds: ["__no_items__"], cx: focalX, cy: focalY, spread: 60 });
  } else {
    for (let p = 0; p < pairs.length; p++) {
      const memberSubjects = pairs[p]!
        .map((id) => subjects[ids.indexOf(id)])
        .filter((s): s is string => s !== null);
      const subject = memberSubjects.length > 0 ? memberSubjects.join(" + ") : undefined;
      if (ids.length <= 3) {
        // Small n: a tight spread keeps the hint samples ON the focal point —
        // wide scatters dilute the hint into noise and can lose the engine's
        // with-vs-without comparison. Every pair centers on the focal point.
        groups.push({ itemIds: pairs[p]!, cx: focalX, cy: focalY, spread: 40 + rnd() * 20, subject });
      } else {
        // Larger n: pair groups alternate left/right of the focal anchor with
        // a vertical stagger so the clusters don't stack on one spot.
        const cx = clamp(p % 2 === 0 ? focalX - 90 : focalX + 90, 120, cardWidth - 120);
        const cy = clamp(p < 2 ? focalY : focalY + 70, 120, cardHeight - 120);
        groups.push({ itemIds: pairs[p]!, cx, cy, spread: 110 + rnd() * 40, subject });
      }
    }
  }

  // Per-item hints: tilt toward the group center (stickers face each other
  // across the pair's middle — the deterministic stand-in for the model's
  // subject-interaction reasoning), role/importance from the visualWeight
  // ranking (rank 0 = focal, importance 1; last rank ≈ 1/n).
  const weightOf = (i: number): number => {
    const raw = items[i]?.visualWeight ?? items[i]?.weight;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const rank = ids.map((_, i) => i).sort(
    (a, b) => weightOf(b) - weightOf(a) || a - b,
  );
  const importanceOf = new Map<number, number>();
  rank.forEach((itemIdx, r) => importanceOf.set(itemIdx, (ids.length - r) / ids.length));
  const groupSizeOf = new Map<string, number>();
  for (const g of groups) for (const id of g.itemIds) groupSizeOf.set(id, g.itemIds.length);
  const hints = ids.map((id, i) => ({
    itemId: id,
    role: (rank[0] === i ? "focal" : "support") as "focal" | "support",
    tiltToward: "group_center" as const,
    importance: importanceOf.get(i) ?? 1,
  }));

  const textZone = { x: 60, y: 40, w: CARD_COORD_SPACE - 120, h: 280 };
  return layoutCompositionSchema.parse({
    focalPoint: { x: focalX, y: focalY },
    groups,
    hints,
    textZone,
    suggestedGreetingStyle: {
      font: "Inter",
      color: "#1f2937",
      align: "center",
      y: textZone.y + textZone.h / 2,
    },
  });
}

/**
 * Mock layout_montage: reuses the deterministic layout-composition builder
 * (seeded from input) and tags it with FIXED montage options — strategy
 * "character_montage", relaxOverlap false. Mock mode always resolves to this
 * single, predictable poster arrangement.
 */
function mockLayoutMontage(input: Record<string, unknown>): unknown {
  const base = mockLayoutComposition(input) as Record<string, unknown>;
  return layoutMontageSchema.parse({
    ...base,
    strategy: "character_montage",
    relaxOverlap: false,
  });
}

// ---------------------------------------------------------------------------
// montage_prompt — deterministic canned poster prompt (zero network)
// ---------------------------------------------------------------------------

/** Flavor adjectives for the canned montage prompt; picked by an
 *  avalanche-hashed seed so near-identical inputs still diverge (the same
 *  reasoning as stickerSeed — plain djb2 low bits cluster for similar
 *  strings). */
const MONTAGE_FLAVOR_ADJECTIVES: readonly string[] = [
  "Vibrant",
  "Whimsical",
  "Radiant",
  "Playful",
  "Bold",
  "Dreamy",
  "Festive",
  "Cheerful",
];

/**
 * Canned deterministic montage prompt: avalanche-hash-seeded flavor adjective
 * + theme + greeting text + subjects joined, phrased as ONE vivid poster
 * image prompt (single cohesive full-bleed illustration with the greeting
 * BAKED IN as the lower-third title treatment, family-friendly). Validated
 * against montagePromptSchema by compute()'s schema table — the same
 * belt-and-braces as other tasks.
 */
function mockMontagePrompt(input: Record<string, unknown>): unknown {
  const theme = String(input.theme ?? "").trim() || "a happy occasion";
  const greeting = String(input.greeting ?? "").trim();
  const subjectsRaw = Array.isArray(input.subjects) ? input.subjects : [];
  const subjects = subjectsRaw
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);

  // Avalanche the combined seed so similar inputs pick different flavors.
  let h = hashString(`${theme}:${greeting}:${subjects.join("|")}`);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const seed = h >>> 0;
  const flavor = MONTAGE_FLAVOR_ADJECTIVES[seed % MONTAGE_FLAVOR_ADJECTIVES.length]!;

  const subjectList =
    subjects.length > 0 ? subjects.join(", ") : "a charming ensemble of themed icons";
  const greetingNote = greeting
    ? ` Render the greeting "${greeting}" verbatim as the poster's title treatment across the lower third.`
    : " Render the greeting verbatim as the poster's title treatment across the lower third.";

  const prompt =
    `${flavor} full-bleed movie-poster illustration for a ${theme} greeting card: ` +
    `a single cohesive composition featuring ${subjectList}, arranged as an ensemble ` +
    `cast with one clear focal hero. Bold cinematic poster style, rich painterly ` +
    `shading, joyful lighting.${greetingNote} Family-friendly; the ONLY text in the artwork is the greeting, rendered exactly as given.`;

  // montagePromptSchema caps at 800 chars — hard-truncate defensively so a
  // very long subject list can never make the mock itself schema-invalid.
  return montagePromptSchema.parse({ prompt: prompt.slice(0, 800) });
}

// ---------------------------------------------------------------------------
// montage_image — procedural 800×1120 poster via @napi-rs/canvas
// ---------------------------------------------------------------------------

export const MONTAGE_IMAGE_WIDTH = 800;
export const MONTAGE_IMAGE_HEIGHT = 1120;
export const MONTAGE_IMAGE_MIME = "image/png";

/**
 * Draw one of the mock sticker shapes centered at (cx, cy) with visual size
 * `size`, by reusing the shared SHAPES pool (each drawer paints into a
 * centered MOCK_IMAGE_SIZE box) with translate+scale. Zero network.
 */
function drawStickerShapeAt(
  ctx: SKRSContext2D,
  shape: (typeof SHAPES)[number],
  cx: number,
  cy: number,
  size: number,
  hue: number,
): void {
  const scale = size / MOCK_IMAGE_SIZE;
  ctx.save();
  ctx.translate(cx - (MOCK_IMAGE_SIZE / 2) * scale, cy - (MOCK_IMAGE_SIZE / 2) * scale);
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = `hsl(${hue}, 72%, 58%)`;
  ctx.shadowColor = `hsla(${hue}, 60%, 30%, 0.35)`;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 4;
  shape.draw(ctx);
  ctx.restore();
}

/** Greedy word-wrap into lines no wider than maxWidth. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Procedural 800×1120 (2:2.8 portrait) poster: ONE cohesive composition —
 * theme-hash gradient background, a single dominant central hero shape (the
 * first subject) with the remaining subjects as satellites orbiting it at
 * decaying scales, every shape inside the SAME theme-hash hue family, and the
 * greeting text baked into the lower third. Deliberately NOT a per-subject
 * column lineup: the mock must model the hardened montage_prompt's "one shared
 * scene with one focal hero" rubric. Fully deterministic per input, zero
 * network.
 */
function mockMontageImageResult(input: Record<string, unknown>): AiCallResult {
  const theme = String(input.theme ?? "").trim() || "celebration";
  const greeting = String(input.greeting ?? "").trim();
  const subjectsRaw = Array.isArray(input.subjects) ? input.subjects : [];
  const subjects = subjectsRaw
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);

  const canvas = createCanvas(MONTAGE_IMAGE_WIDTH, MONTAGE_IMAGE_HEIGHT);
  const ctx = canvas.getContext("2d");

  // -- background: theme-hash gradient -------------------------------------
  const th = hashString(theme);
  const hue = th % 360;
  const grad = ctx.createLinearGradient(0, 0, 0, MONTAGE_IMAGE_HEIGHT);
  grad.addColorStop(0, hslToHex(hue, 70, 84));
  grad.addColorStop(1, hslToHex((hue + 40) % 360, 65, 56));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, MONTAGE_IMAGE_WIDTH, MONTAGE_IMAGE_HEIGHT);

  // -- ONE hero + satellite ring (cohesive composition) --------------------
  // Upper two thirds is the artwork stage; the lower third stays open for the
  // greeting text (the poster rubric). The first subject is the HERO: largest
  // shape, dead center. Satellites orbit it at varying (decaying) scales —
  // importance-weighted when the caller supplies per-subject weights — and
  // every hue stays in the hero's ±24° family so the cast reads as one scene.
  const stageH = MONTAGE_IMAGE_HEIGHT * (2 / 3);
  const cast = subjects.length > 0 ? subjects : [theme];
  const [hero, ...satellites] = cast;
  const heroSeed = stickerSeed(hero);
  const heroShape = SHAPES[heroSeed % SHAPES.length]!;
  const heroHue = th % 360;
  const heroSize = Math.min(MONTAGE_IMAGE_WIDTH * 0.38, stageH * 0.5);
  const heroCx = MONTAGE_IMAGE_WIDTH / 2;
  const heroCy = stageH * 0.54;
  drawStickerShapeAt(ctx, heroShape, heroCx, heroCy, heroSize, heroHue);

  // Importance weights (optional — the accumulator doesn't send them today;
  // when present, satellite scale follows relative weight instead of rank).
  const weightsRaw = Array.isArray(input.weights) ? input.weights : [];
  const satWeights = satellites.map((_, i) => Math.max(Number(weightsRaw[i]) || 0, 0));
  const maxWeight = Math.max(...satWeights, 0);

  satellites.forEach((subject, i) => {
    const seed = stickerSeed(subject);
    const shape = SHAPES[seed % SHAPES.length]!;
    // Shared palette: jitter the hero hue by at most ±24° (seeded, stable).
    const satHue = (heroHue + 24 + ((seed >>> 6) % 48) - 24 + 360) % 360;
    // Varying scales: deterministic decay 0.52 → 0.40 → 0.46 → 0.34 (rank
    // order), or the subject's relative weight when weights are supplied.
    const scale =
      maxWeight > 0
        ? 0.32 + 0.28 * (satWeights[i]! / maxWeight)
        : [0.52, 0.4, 0.46, 0.34][(i + (seed >>> 3)) % 4]!;
    const satSize = heroSize * scale;
    // Deterministic ring placement: even base spacing + seeded angle jitter.
    const angle =
      -Math.PI / 2 +
      (i / Math.max(satellites.length, 1)) * Math.PI * 2 +
      (((seed >>> 9) % 30) - 15) * (Math.PI / 180);
    // Elliptical orbit (wider than tall) keeps satellites on the wide stage.
    const rx = heroSize * 0.6 + satSize * 0.6;
    const ry = heroSize * 0.42 + satSize * 0.5;
    const cx = heroCx + Math.cos(angle) * rx * 1.1;
    const cy = heroCy + Math.sin(angle) * ry;
    // Clamp into the stage: never cross the frame edge nor dip into the
    // lower-third greeting band.
    const x = Math.min(
      Math.max(cx, satSize * 0.45 + 10),
      MONTAGE_IMAGE_WIDTH - satSize * 0.45 - 10,
    );
    const y = Math.min(Math.max(cy, satSize * 0.4 + 10), stageH - 10);
    drawStickerShapeAt(ctx, shape, x, y, satSize, satHue);
  });

  // -- greeting text, baked into the lower third ---------------------------
  const text = greeting || theme;
  const bandY = MONTAGE_IMAGE_HEIGHT - stageH; // top of the lower third
  const bandH = stageH;
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.fillRect(0, bandY, MONTAGE_IMAGE_WIDTH, bandH);
  ctx.fillStyle = "#1f2937";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Shrink the font until the wrapped text fits the band.
  let fontSize = 56;
  let lines: string[] = [];
  for (;;) {
    ctx.font = `bold ${fontSize}px sans-serif`;
    lines = wrapText(ctx, text, MONTAGE_IMAGE_WIDTH - 80);
    if (lines.length * fontSize * 1.25 <= bandH - 40 || fontSize <= 18) break;
    fontSize -= 4;
  }
  const lineH = fontSize * 1.25;
  const startY = bandY + bandH / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, MONTAGE_IMAGE_WIDTH / 2, startY + i * lineH);
  });

  return {
    data: {
      width: MONTAGE_IMAGE_WIDTH,
      height: MONTAGE_IMAGE_HEIGHT,
      subjects: cast,
      greetingUsed: Boolean(greeting),
    },
    model: "mock/montage_image",
    latencyMs: 0,
    imageBase64: canvas.toBuffer("image/png").toString("base64"),
    imageMime: MONTAGE_IMAGE_MIME,
    imageWidth: MONTAGE_IMAGE_WIDTH,
    imageHeight: MONTAGE_IMAGE_HEIGHT,
  };
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