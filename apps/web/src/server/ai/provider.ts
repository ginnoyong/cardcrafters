/**
 * AI provider abstraction (Step 4).
 *
 * Every AI capability of the game goes through exactly one entry point:
 *   AiRouter.run(task, input) → AiCallResult
 * backed by an AiProvider (mock-provider.ts or openrouter-provider.ts).
 *
 * This file holds the shared vocabulary:
 *  - AiTaskName / TASK_NAMES — the fixed set of AI tasks (plan §5)
 *  - TaskConfig — one task's row from config/ai-tasks.json (env-overridable)
 *  - AiCallResult — what a provider returns on success
 *  - loadTaskConfig() — reads config/ai-tasks.json, applies env overrides
 *  - TASK_SCHEMAS — zod schema per structured task (from @cardcrafters/shared)
 *
 * Config file discovery: config/ lives at the REPO ROOT. We resolve it
 * relative to this module first (works under vitest/tsx regardless of cwd),
 * falling back to process.cwd()/config (works for bundled layouts).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  greetingVariationsSchema,
  layoutCompositionSchema,
  layoutCritiqueSchema,
  layoutMontageSchema,
  moderationSchema,
  promptValidationSchema,
  styleDerivationSchema,
} from "@cardcrafters/shared";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_NAMES = [
  "prompt_validation",
  "moderation",
  "greeting_variations",
  "style_derivation",
  "item_image",
  "layout_composition",
  "layout_critique",
  "layout_montage",
] as const;

export type AiTaskName = (typeof TASK_NAMES)[number];

export function isAiTaskName(value: unknown): value is AiTaskName {
  return typeof value === "string" && (TASK_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Per-task config (mirrors config/ai-tasks.json)
// ---------------------------------------------------------------------------

export interface TaskConfig {
  name: AiTaskName;
  /** Primary OpenRouter model id, e.g. "google/gemini-2.5-flash". */
  primary: string;
  /** Fallback model ids, tried in order after the primary's retries fail. */
  fallbacks: string[];
  temperature: number;
  /** max_tokens sent to the model; 0 = omit (image tasks). */
  maxTokens: number;
  timeoutMs: number;
  /** Extra attempts after the first one, per model (primary and each fallback). */
  retries: number;
  /** Name of the zod schema (TASK_SCHEMAS) the JSON output must satisfy, or null. */
  structured: string | null;
  /** Disabled tasks throw immediately in the router (layout_critique default). */
  enabled: boolean;
}

export type AiMode = "mock" | "openrouter" | "auto";

export interface LoadedAiConfig {
  mode: AiMode;
  tasks: Record<AiTaskName, TaskConfig>;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface AiCallResult {
  /** Parsed JSON payload (already schema-validated by the router for structured tasks). */
  data: unknown;
  /** Raw model text, when available (useful for debugging). */
  raw?: string;
  /** Model id that produced the result (mock providers use "mock/<task>"). */
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
  };
  /** Binary image output (item_image task). */
  imageBase64?: string;
  imageMime?: string;
  /** Pixel dimensions of the image, when known (mock canvas images). */
  imageWidth?: number;
  imageHeight?: number;
}

/** A provider executes one attempt of one task with one model config. */
export interface AiProvider {
  run(task: AiTaskName, input: Record<string, unknown>, cfg: TaskConfig): Promise<AiCallResult>;
}

// ---------------------------------------------------------------------------
// Structured-output schemas (by the name used in config/ai-tasks.json)
// ---------------------------------------------------------------------------

export const TASK_SCHEMAS: Record<string, z.ZodTypeAny> = {
  promptValidationSchema,
  moderationSchema,
  greetingVariationsSchema,
  styleDerivationSchema,
  layoutCompositionSchema,
  layoutCritiqueSchema,
  layoutMontageSchema,
};

/** Validate `data` against the schema named by cfg.structured (null = exempt). */
export function validateTaskOutput(
  cfg: TaskConfig,
  data: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!cfg.structured) return { ok: true, value: data };
  const schema = TASK_SCHEMAS[cfg.structured];
  if (!schema) return { ok: false, error: `unknown structured schema "${cfg.structured}"` };
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `schema ${cfg.structured} validation failed: ${parsed.error.message}`,
  };
}

// ---------------------------------------------------------------------------
// Config loading (config/ai-tasks.json + env overrides)
// ---------------------------------------------------------------------------

const DEFAULTS = { retries: 1, timeoutMs: 15_000 } as const;

/** repo-root config/ directory, resolved from this module then from cwd. */
export function configDir(): string {
  // apps/web/src/server/ai → repo root is five levels up.
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../config");
  if (existsSync(here)) return here;
  return path.resolve(process.cwd(), "config");
}

/** task key "prompt_validation" → env fragment "PROMPT_VALIDATION". */
function envFragment(task: string): string {
  return task.toUpperCase();
}

/**
 * Read config/ai-tasks.json and apply env overrides:
 *   AI_MODE, AI_TASK_<NAME>_MODEL, AI_TASK_<NAME>_FALLBACKS (comma-separated).
 * Throws (startup error) when the file is missing, malformed, or a task is
 * missing required fields.
 */
export async function loadTaskConfig(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = configDir(),
): Promise<LoadedAiConfig> {
  const file = path.join(dir, "ai-tasks.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new Error(`ai-tasks.json unreadable at ${file}: ${(cause as Error).message}`);
  }
  const doc = (raw ?? {}) as {
    mode?: string;
    defaults?: { retries?: number; timeoutMs?: number };
    tasks?: Record<string, unknown>;
  };

  const mode = parseMode(env.AI_MODE ?? doc.mode);
  const defaults = { ...DEFAULTS, ...doc.defaults };
  const tasks = {} as Record<AiTaskName, TaskConfig>;
  for (const name of TASK_NAMES) {
    const t = doc.tasks?.[name] as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") throw new Error(`ai-tasks.json: task "${name}" missing`);
    const frag = envFragment(name);
    const envModel = env[`AI_TASK_${frag}_MODEL`];
    const envFallbacks = env[`AI_TASK_${frag}_FALLBACKS`];
    const primary = typeof envModel === "string" && envModel.trim() ? envModel.trim() : requireString(t, name, "primary");
    const fallbacks =
      envFallbacks !== undefined
        ? envFallbacks.split(",").map((s) => s.trim()).filter(Boolean)
        : (t.fallbacks as string[] | undefined ?? []);
    tasks[name] = {
      name,
      primary,
      fallbacks,
      temperature: typeof t.temperature === "number" ? t.temperature : 0,
      maxTokens: typeof t.maxTokens === "number" ? t.maxTokens : 0,
      timeoutMs: typeof t.timeoutMs === "number" ? t.timeoutMs : defaults.timeoutMs,
      retries: typeof t.retries === "number" ? t.retries : defaults.retries,
      structured: (t.structured ?? null) === null ? null : String(t.structured),
      enabled: t.enabled === undefined ? true : t.enabled === true,
    };
  }
  return { mode, tasks };
}

function parseMode(value: string | undefined): AiMode {
  if (value === "mock" || value === "openrouter" || value === "auto" || value === undefined) {
    return value ?? "auto";
  }
  throw new Error(`invalid AI_MODE "${value}" (expected mock | openrouter | auto)`);
}

function requireString(t: Record<string, unknown>, task: string, field: string): string {
  const v = t[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`ai-tasks.json: task "${task}" missing required field "${field}"`);
  }
  return v.trim();
}