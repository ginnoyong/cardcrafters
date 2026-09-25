/**
 * AI errors (Step 4).
 *
 * - AiTaskError: a task attempt (or the whole attempt chain) failed. The
 *   router's retry loop inspects `retryable` to decide whether to retry /
 *   fall back or abort immediately (fatal: disabled task, HTTP 400, ...).
 * - AiBudgetExceededError: thrown BEFORE any provider call when a game's
 *   accumulated real-AI spend has reached AI_BUDGET_PER_GAME_USD. Mock calls
 *   cost 0 and never trip the budget.
 */

export class AiTaskError extends Error {
  readonly task: string;
  readonly model?: string;
  readonly retryable: boolean;

  constructor(params: {
    task: string;
    model?: string;
    cause?: unknown;
    retryable: boolean;
    message: string;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "AiTaskError";
    this.task = params.task;
    this.model = params.model;
    this.retryable = params.retryable;
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