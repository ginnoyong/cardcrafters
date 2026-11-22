/**
 * AI errors (Step 4).
 *
 * - AiTaskError: a task attempt (or the whole attempt chain) failed. The
 *   router's retry loop inspects `retryable` to decide whether to retry /
 *   fall back or abort immediately (fatal: disabled task, HTTP 400, ...).
 *   It additionally inspects `inFlightBudget` for OpenRouter's HTTP 402
 *   "in_flight_budget_exhausted" response (the account still HAS credits, but
 *   concurrent in-flight requests would exceed the available budget): the
 *   remedy is to WAIT for in-flight requests to settle and retry the SAME
 *   model, not to burn retries/fallbacks — retrying immediately adds MORE
 *   in-flight requests and makes the 402 worse.
 * - AiBudgetExceededError: thrown BEFORE any provider call when a game's
 *   accumulated real-AI spend has reached AI_BUDGET_PER_GAME_USD. Mock calls
 *   cost 0 and never trip the budget.
 */

export class AiTaskError extends Error {
  readonly task: string;
  readonly model?: string;
  readonly retryable: boolean;
  /** HTTP 402 with reason "in_flight_budget_exhausted" (or the equivalent
   *  limit_source marker) — see the class doc. Only the provider layer sets
   *  this; the router uses it to back off and retry the SAME model. */
  readonly inFlightBudget: boolean;
  /** Standard `Retry-After` response header (integer seconds) attached by
   *  OpenRouter to a 402 in-flight response, when present. The provider layer
   *  parses it (case-insensitive; invalid/absent → undefined); the router
   *  uses max(retryAfterSeconds, its planned backoff) — the hint can lengthen
   *  the wait but never shortens it below the planned ladder. */
  readonly retryAfterSeconds?: number;

  constructor(params: {
    task: string;
    model?: string;
    cause?: unknown;
    retryable: boolean;
    inFlightBudget?: boolean;
    retryAfterSeconds?: number;
    message: string;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "AiTaskError";
    this.task = params.task;
    this.model = params.model;
    this.retryable = params.retryable;
    this.inFlightBudget = params.inFlightBudget ?? false;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export class AiBudgetExceededError extends Error {
  readonly gameId: string;
  readonly spentUsd: number;
  readonly budgetUsd: number;

  constructor(params: { gameId: string; spentUsd: number; budgetUsd: number }) {
    super(
      `AI budget exceeded for game ${params.gameId}: spent $${params.spentUsd.toFixed(6)} of $${params.budgetUsd} budget`,
    );
    this.name = "AiBudgetExceededError";
    this.gameId = params.gameId;
    this.spentUsd = params.spentUsd;
    this.budgetUsd = params.budgetUsd;
  }
}