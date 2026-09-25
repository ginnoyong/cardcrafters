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
  /** gameId → known spend (USD); populated lazily from repo, kept fresh on insert. */
  private readonly spend = new Map<string, number>();

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

    // -- budget guard (BEFORE any call; mock costs 0 so it never trips) ------
    if (this.budgetUsd !== null && opts?.gameId) {
      const spent = await this.currentSpend(opts.gameId);
      if (spent >= this.budgetUsd) {
        throw new AiBudgetExceededError({
          gameId: opts.gameId,
          spentUsd: spent,
          budgetUsd: this.budgetUsd,
        });
      }
    }

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
          await this.log(task, model, "ERROR", {
            latencyMs: 0,
            costUsd: 0,
            retries: attempt,
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
          await this.log(task, model, "ERROR", {
            latencyMs: result.latencyMs,
            costUsd: result.usage?.costUsd ?? 0,
            usage: result.usage,
            retries: attempt,
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

  /** Persist one attempt row and keep the per-game spend cache in sync. */
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
 *   AI_BUDGET_PER_GAME_USD, plus the per-task AI_TASK_* overrides applied by
 *   loadTaskConfig(). The server calls this once at boot.
 */
export async function createAiRouter(opts: CreateAiRouterOptions) {
  const env = opts.env ?? process.env;
  const loaded = await loadTaskConfig(env, opts.configDir);
  const budgetRaw = Number(env.AI_BUDGET_PER_GAME_USD);
  const budgetUsd = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : null;
  return new AiRouter({
    repo: opts.repo,
    mode: loaded.mode,
    config: loaded.tasks,
    ...(budgetUsd !== null ? { budgetUsd } : {}),
    openrouter: { apiKey: env.OPENROUTER_API_KEY, baseUrl: env.OPENROUTER_BASE_URL },
    env,
  });
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