/**
 * AiRouter (Step 4) — the ONE entry point game flows use for AI work
 * (Steps 6-8 consume it; nothing in the game UI talks to providers directly).
 *
 * Responsibilities:
 *  1. Per-game BUDGET GUARD: when budget tracking is enabled and a gameId is
 *     given, current spend is checked (repo.listAiCalls cached in memory,
 *     refreshed on insert) BEFORE any call; real spend >= budget →
 *     AiBudgetExceededError. Mock results cost 0 and never trip the budget.
 *  2. PROVIDER RESOLUTION by mode: "mock" → MockProvider; "openrouter" →
 *     OpenRouterProvider; "auto" → OpenRouter iff OPENROUTER_API_KEY is set,
 *     else MockProvider (the full game must run on mock).
 *  3. RETRY + FALLBACK chain: primary model gets (1 + cfg.retries) attempts,
 *     then each fallback model in order gets (1 + cfg.retries) attempts.
 *     Non-retryable failures skip the remaining retries of the current model
 *     but still move to the next fallback model (retrying a bad model id or
 *     malformed request can't help; a different model might).
 *  4. AUDIT: every attempt is persisted via repo.insertAiCall (status
 *     OK / FALLBACK_OK / ERROR, latency, cost, usage, retries, fallbackUsed,
 *     error). Mock calls log cost 0.
 *  5. SCHEMA ENFORCEMENT: structured outputs are validated against the zod
 *     schema named in config before being returned (invalid → retryable).
 *  6. After the chain is exhausted: throws the last AiTaskError.
 */

import type { Repository } from "../repo/repository";
import { AiBudgetExceededError, AiTaskError } from "./errors";
import { MockProvider } from "./mock-provider";
import { OpenRouterProvider } from "./openrouter-provider";
import {
  loadTaskConfig,
  validateTaskOutput,
  type AiCallResult,
  type AiMode,
  type AiProvider,
  type AiTaskName,
  type TaskConfig,
} from "./provider";

// ---------------------------------------------------------------------------
// Cost estimation (optimistic budget reservation)
// ---------------------------------------------------------------------------

/**
 * Default per-game AI spend ceiling, in USD, applied when AI_BUDGET_PER_GAME_USD
 * is not set in the environment (a valid positive env value always wins).
 *
 * Budget math (measured costs, worst case):
 *   - text tasks (montage_prompt / greeting / validation / moderation):
 *     ≈ $0.001–0.005 per call;
 *   - image tasks (item_image / montage_image) on google/gemini-2.5-flash-image:
 *     ≈ $0.03–0.04 per image (openai/gpt-image-1 fallback up to ≈ $0.19).
 *   - Per team per round: up to 25 sticker images (cap 25/team) + 1
 *     montage_prompt + 1 montage_image ≈ 25 × $0.04 + $0.05 ≈ $1.10; the
 *     continuous montage loop can add one more montage_image per validated
 *     submission burst (≤ 25/team) ≈ +$1.
 *   - 10 teams → ~$15–22 per game worst case, ~$5–10 typical.
 * $25 = realistic worst case ($22) × ~1.15 headroom.
 */
// USER DECISION: keep the cap at $50/game. For the record, MEASURED spend
// across all played games (AiCall ledger): sticker images $0.031/call,
// montage posters $0.034/call, text tasks <= $0.0013/call — most expensive
// game ever $1.02, so the cap is generous headroom by design (it exists as
// runaway protection, not a spend target).
export const DEFAULT_AI_BUDGET_PER_GAME_USD = 50;

/**
 * Optimistic pre-call reserve for a non-image (text) call, in USD. Realistic
 * measured text cost is $0.001–0.005; the reserve only gates CONCURRENT
 * in-flight calls and is reconciled to the real cost on completion, so a
 * realistic value prevents over-reservation lockouts at scale (many teams
 * reserving far more than they will ever spend).
 */
export const DEFAULT_CALL_ESTIMATE_USD = 0.01;
/**
 * Optimistic pre-call reserve for an image-generation call, in USD. Realistic
 * gemini-2.5-flash-image cost is $0.03–0.04 (gpt-image-1 fallback up to
 * ~$0.19) — see the budget math on DEFAULT_AI_BUDGET_PER_GAME_USD.
 */
export const DEFAULT_IMAGE_CALL_ESTIMATE_USD = 0.05;

/**
 * Optimistic cost estimate for one call, reserved BEFORE the provider runs so
 * concurrent runs cannot jointly overshoot the budget (check-then-act race).
 * Reconciled against the actual cost (from usage) once the call completes.
 */
function estimateCallCostUsd(task: string): number {
  return task === "item_image" || task === "montage_image"
    ? DEFAULT_IMAGE_CALL_ESTIMATE_USD
    : DEFAULT_CALL_ESTIMATE_USD;
}

export interface AiRouterOptions {
  repo: Repository;
  mode: AiMode;
  config: Record<AiTaskName, TaskConfig>;
  /** Per-game spend ceiling in USD; omit to disable budget tracking. */
  budgetUsd?: number;
  /** Provider override (tests / custom providers). Default: resolved from mode. */
  provider?: AiProvider;
  /** OpenRouter credentials, needed when mode resolves to the real provider. */
  openrouter?: { apiKey?: string; baseUrl?: string };
  env?: NodeJS.ProcessEnv;
}

export class AiRouter {
  private readonly repo: Repository;
  private readonly config: Record<AiTaskName, TaskConfig>;
  private readonly budgetUsd: number | null;
  private readonly provider: AiProvider;
  /** gameId → committed spend (USD); populated lazily from repo, kept fresh on insert. */
  private readonly spend = new Map<string, number>();
  /** gameId → sum of estimates reserved for calls currently in flight. */
  private readonly inflight = new Map<string, number>();

  constructor(opts: AiRouterOptions) {
    this.repo = opts.repo;
    this.config = opts.config;
    this.budgetUsd = opts.budgetUsd ?? null;
    this.provider =
      opts.provider ??
      resolveProvider(opts.mode, opts.openrouter?.apiKey, opts.openrouter?.baseUrl, opts.env);
  }

  /**
   * Run one AI task. Throws:
   *  - AiTaskError (retryable=false) for unknown/disabled tasks;
   *  - AiBudgetExceededError when the game's spend already reached the budget;
   *  - AiTaskError when every model attempt failed.
   */
  async run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<AiCallResult> {
    const cfg = this.config[task as AiTaskName];
    if (!cfg) {
      throw new AiTaskError({ task, retryable: false, message: `unknown AI task "${task}"` });
    }
    if (!cfg.enabled) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        retryable: false,
        message: `AI task "${task}" is disabled by config`,
      });
    }

    // -- budget guard (BEFORE any call) --------------------------------------
    // Optimistic reservation: reserve an estimated cost up-front so concurrent
    // runs for the same game cannot jointly overshoot the budget; reconcile
    // with the actual cost (repo-logged) after the call completes.
    // Calls WITHOUT a gameId deliberately bypass the budget: they are
    // game-less (boot-time warmups, config checks) and have nothing to charge
    // against — documented here so the exclusion stays intentional.
    const reserve =
      this.budgetUsd !== null && opts?.gameId && !(this.provider instanceof MockProvider);
    const estimate = reserve ? estimateCallCostUsd(task) : 0;
    if (reserve && opts?.gameId) {
      const gameId = opts.gameId;
      const committed = await this.currentSpend(gameId);
      const reserved = this.inflight.get(gameId) ?? 0;
      if (committed + reserved + estimate > this.budgetUsd!) {
        throw new AiBudgetExceededError({
          gameId,
          spentUsd: committed + reserved,
          budgetUsd: this.budgetUsd!,
        });
      }
      this.inflight.set(gameId, reserved + estimate);
    }

    try {
      return await this.runChain(task, input, opts, cfg);
    } finally {
      // Reconcile: release the reservation. The actual cost (from usage) is
      // already folded into the committed-spend cache by log(); concurrent
      // callers now see real spend instead of our estimate.
      if (reserve && opts?.gameId) {
        const gameId = opts.gameId;
        const reserved = this.inflight.get(gameId) ?? 0;
        this.inflight.set(gameId, Math.max(0, reserved - estimate));
      }
    }
  }

  /** The retry/fallback loop (extracted so budget reservation wraps it). */
  private async runChain(
    task: string,
    input: Record<string, unknown>,
    opts: { gameId?: string } | undefined,
    cfg: TaskConfig,
  ): Promise<AiCallResult> {
    const models = [cfg.primary, ...cfg.fallbacks];
    let lastError: AiTaskError | undefined;
    let failedAttempts = 0;

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi]!;
      const fallbackUsed = mi > 0;
      const modelCfg: TaskConfig = { ...cfg, primary: model };

      for (let attempt = 0; attempt <= cfg.retries; attempt++) {
        let result: AiCallResult;
        try {
          result = await this.provider.run(task as AiTaskName, input, modelCfg);
        } catch (cause) {
          lastError =
            cause instanceof AiTaskError
              ? cause
              : new AiTaskError({
                  task,
                  model,
                  cause,
                  retryable: true,
                  message: `provider threw: ${(cause as Error).message}`,
                });
          failedAttempts += 1;
          console.warn(
            `[ai-router] ${task} attempt ${failedAttempts} via ${model} failed: ${lastError.message}`,
          );
          await this.log(task, model, "ERROR", {
            latencyMs: 0,
            costUsd: 0,
            retries: failedAttempts, // cumulative failed attempts across ALL models
            fallbackUsed,
            error: lastError.message,
            gameId: opts?.gameId,
          });
          if (!lastError.retryable) break; // fatal for this model → next fallback
          continue;
        }

        // -- schema enforcement (belt & braces: providers validate too) -------
        const checked = validateTaskOutput(cfg, result.data);
        if (!checked.ok) {
          lastError = new AiTaskError({
            task,
            model,
            retryable: true,
            message: `router rejected output: ${checked.error}`,
          });
          failedAttempts += 1;
          console.warn(
            `[ai-router] ${task} attempt ${failedAttempts} via ${model} rejected: ${lastError.message}`,
          );
          await this.log(task, model, "ERROR", {
            latencyMs: result.latencyMs,
            costUsd: result.usage?.costUsd ?? 0,
            usage: result.usage,
            retries: failedAttempts, // cumulative failed attempts across ALL models
            fallbackUsed,
            error: lastError.message,
            gameId: opts?.gameId,
          });
          continue;
        }

        await this.log(task, model, fallbackUsed ? "FALLBACK_OK" : "OK", {
          latencyMs: result.latencyMs,
          costUsd: result.usage?.costUsd ?? 0,
          usage: result.usage,
          retries: failedAttempts,
          fallbackUsed,
          error: null,
          gameId: opts?.gameId,
        });
        return { ...result, data: checked.value };
      }
    }

    throw (
      lastError ??
      new AiTaskError({ task, retryable: false, message: `AI task "${task}" failed with no attempts` })
    );
  }

  /** Per-task config access (flows may inspect timeouts for UX). */
  taskConfig(task: AiTaskName): TaskConfig | undefined {
    return this.config[task];
  }

  /** True when the resolved provider is the deterministic mock (no network,
   *  no cost). The layout-critique scheduler uses this to short-circuit the
   *  vision call with a fixed verdict instead of asking the mock provider. */
  isMock(): boolean {
    return this.provider instanceof MockProvider;
  }

  /** Total known spend for a game (cached; refreshed from repo on demand). */
  async spendUsd(gameId: string): Promise<number> {
    return this.currentSpend(gameId);
  }

  // -- internals -------------------------------------------------------------

  /** Cached spend for a game; refreshed from the repo when unknown. */
  private async currentSpend(gameId: string): Promise<number> {
    const cached = this.spend.get(gameId);
    if (cached !== undefined) return cached;
    const summary = await this.repo.listAiCalls(gameId);
    this.spend.set(gameId, summary.totalCostUsd);
    return summary.totalCostUsd;
  }

  /** Persist one attempt row and keep the per-game spend cache in sync.
   *  A logging failure must NEVER discard a successful AI result — it is
   *  swallowed (with console.error) instead of propagating to the caller. */
  private async log(
    task: string,
    model: string,
    status: "OK" | "FALLBACK_OK" | "ERROR",
    fields: {
      latencyMs: number;
      costUsd: number;
      usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number };
      retries: number;
      fallbackUsed: boolean;
      error: string | null;
      gameId?: string;
    },
  ): Promise<void> {
    try {
      await this.repo.insertAiCall({
        gameId: fields.gameId ?? null,
        task,
        model,
        status,
        latencyMs: fields.latencyMs,
        costUsd: fields.costUsd,
        usage: fields.usage ?? null,
        retries: fields.retries,
        fallbackUsed: fields.fallbackUsed,
        error: fields.error,
      });
      if (fields.gameId) {
        const cached = this.spend.get(fields.gameId);
        if (cached !== undefined) {
          this.spend.set(fields.gameId, cached + fields.costUsd);
        }
      }
    } catch (err) {
      console.error(
        `[ai-router] failed to persist AI call log (task=${task}, model=${model}, status=${status}):`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateAiRouterOptions {
  repo: Repository;
  /** Environment (defaults to process.env; inject for tests). */
  env?: NodeJS.ProcessEnv;
  /** Config directory override (defaults to <repo>/config). */
  configDir?: string;
}

/**
 * Build a fully-configured AiRouter from the environment:
 *   AI_MODE (auto|mock|openrouter), OPENROUTER_API_KEY, OPENROUTER_BASE_URL,
 *   AI_BUDGET_PER_GAME_USD (default DEFAULT_AI_BUDGET_PER_GAME_USD when unset
 *   or invalid), plus the per-task AI_TASK_* overrides applied by
 *   loadTaskConfig(). The server calls this once at boot.
 */
export async function createAiRouter(opts: CreateAiRouterOptions) {
  const env = opts.env ?? process.env;
  const loaded = await loadTaskConfig(env, opts.configDir);
  const budgetUsd = resolveBudgetUsd(env);
  return new AiRouter({
    repo: opts.repo,
    mode: loaded.mode,
    config: loaded.tasks,
    budgetUsd,
    openrouter: { apiKey: env.OPENROUTER_API_KEY, baseUrl: env.OPENROUTER_BASE_URL },
    env,
  });
}

/**
 * Per-game budget resolution: a valid positive AI_BUDGET_PER_GAME_USD env
 * value wins; anything else falls back to DEFAULT_AI_BUDGET_PER_GAME_USD
 * (budget tracking is ALWAYS on for real providers — the point of the guard).
 */
export function resolveBudgetUsd(env: NodeJS.ProcessEnv): number {
  const budgetRaw = Number(env.AI_BUDGET_PER_GAME_USD);
  return Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : DEFAULT_AI_BUDGET_PER_GAME_USD;
}

// ---------------------------------------------------------------------------
// Provider resolution (mock | openrouter | auto)
// ---------------------------------------------------------------------------

function resolveProvider(
  mode: AiMode,
  apiKey?: string,
  baseUrl?: string,
  env?: NodeJS.ProcessEnv,
): AiProvider {
  const useOpenRouter = mode === "openrouter" || (mode === "auto" && !!apiKey);
  if (useOpenRouter) {
    if (!apiKey) {
      throw new Error("AI_MODE=openrouter requires OPENROUTER_API_KEY");
    }
    return new OpenRouterProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  }
  return new MockProvider({ env });
}