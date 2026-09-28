/**
 * Prompt pipeline (build-phase step 1) — everything that happens to a player's
 * BUILD prompt AFTER the ws layer's cheap zod + word-count pre-filter.
 *
 * ORCHESTRATION ORDER (each step returns a typed PromptSubmitResult the ws
 * handler maps onto an ack):
 *   1. Phase/cutoff   — hub.applyEvent(player:submitPrompt) is the SINGLE
 *                       phase authority (BUILD + `now < cutoffAt` guard live
 *                       in the pure state machine; a failed guard persists
 *                       and emits nothing).
 *   2. Cooldown       — per-player ms since the last fully ACCEPTED
 *                       submission (validated + moderated). In-memory map:
 *                       a server restart resets cooldowns — acceptable for a
 *                       local party game (documented here by design).
 *                       Rejected/blocked/failed submissions never touch it.
 *   3. Card capacity  — items for (teamId, round) excluding
 *                       REMOVED/REJECTED/FAILED vs limits.maxItemsPerCard.
 *   4. In-flight cap  — this player's VALIDATING|GENERATING items this round
 *                       vs limits.maxInflightPerPlayer.
 *   5. Persist (VALIDATING) → emit `item:pending` to the team room (with the
 *      submitter's playerId — prompts are public, and clients need the owner
 *      for their own-stickers ledger) → run the AI checks:
 *      prompt_validation → moderation → GENERATING + subject,
 *      `item:rejected` (OWNER ONLY) on a failed check, FAILED +
 *      `item:failed` (OWNER ONLY) when the AI is unreachable.
 *
 * TEAMMATE PRIVACY vs. PLACEHOLDER CLEANUP: rejected/failed prompts are
 * never broadcast with their reason (owner-only intel), but the earlier
 * `item:pending` placeholder WAS broadcast to the team. Every terminal
 * transition therefore ALSO emits `item:withdrawn` {itemId, teamId} to the
 * team room (no reason — nothing is leaked) so teammates' reducers drop the
 * "drawing…" placeholder. Clients order it AFTER the owner-only event so
 * the owner's ledger is already terminal when the broadcast arrives.
 *
 * SUBMIT RACES (per-player mutex): every step up to and including the
 * cooldown anchor is check-then-act across `await`s (repo reads, AI round-
 * trips), so two concurrent submits from the SAME player (two tabs) could
 * both pass the checks. submitPrompt therefore SERIALIZES the entire call
 * per player: a Map<playerId, Promise> mutex chain in deps.submitLocks —
 * each submit awaits the previous one for the same player before its checks
 * run. Different players are unaffected (they each get their own chain).
 * This serializes the AI latency per player too — fine for a party game.
 * The VALIDATING row is persisted immediately after the checks and BEFORE
 * the AI calls, so the row itself is the durable in-flight lock; the
 * cooldown anchor write happens before the mutex is released.
 *
 * ITEM CREATION OWNERSHIP: the PIPELINE (not the hub) creates Item rows.
 * hub.applyEvent(player:submitPrompt) remains exactly as the state machine
 * defines it (guard → `accept-submission` effect), but the hub executes that
 * effect as a documented no-op so there is exactly one creator/owner of item
 * rows + item events: this pipeline. Limits come from the game's CardConfig
 * (GM-configurable), overridable per-deps for tests.
 *
 * Resubmission note: Item has a unique [teamId, round, promptRaw, playerId].
 * A REJECTED/FAILED/REMOVED row with the same text would otherwise block the
 * player forever, so the pipeline RESURRECTS that terminal row (back to
 * VALIDATING) instead of creating a new one — the audit trail keeps one row
 * per (team, round, player, prompt). Resubmitting text whose row is still
 * VALIDATING/GENERATING/READY hits the unique index and surfaces as
 * `submit_failed` on the ack (intentional: the prompt is already in flight).
 */

import {
  MAX_PROMPT_WORDS,
  moderationSchema,
  promptValidationSchema,
  type CardConfig,
  type Moderation,
  type ModerationCategory,
  type PromptValidation,
} from "@cardcrafters/shared";

import type { ImageQueue } from "../queue/queue";
import type { GameEvent, TransitionResult } from "../game/types";
import type { ItemRow, Repository } from "../repo/repository";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Emission callback: team-room broadcast, or direct to one player's sockets
 *  via `opts.toPlayerOnly` (the ws layer wires this to socket.emit). */
export type PromptEmit = (
  event: string,
  payload: Record<string, unknown>,
  opts?: { toPlayerOnly?: string },
) => void;

/** Minimal hub surface the pipeline needs (GameHub satisfies structurally). */
export interface PromptPipelineHub {
  applyEvent(gameId: string, event: GameEvent): Promise<TransitionResult>;
}

/** Minimal AI surface (AiRouter satisfies structurally; tests inject fakes). */
export interface PromptPipelineAi {
  run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<{ data: unknown }>;
}

/** Who is submitting (ws identity subset; team/nickname re-resolved via repo). */
export interface PromptIdentity {
  gameId: string;
  playerId: string;
}

export interface PromptPipelineDeps {
  hub: PromptPipelineHub;
  repo: Repository;
  ai: PromptPipelineAi;
  /** Socket-wired emitter (per call in the ws layer; recording in tests). */
  emit: PromptEmit;
  /** Optional image queue (step 2); absent → items stay GENERATING. */
  queue?: ImageQueue;
  /** Test overrides merged over the game config's limits. */
  limits?: Partial<CardConfig["limits"]>;
  /** Injectable clock (cooldown math + event `now`). */
  now: () => number;
  /** playerId → epoch ms of the last fully ACCEPTED submission. */
  cooldowns: Map<string, number>;
  /** Per-player submit mutex (see the SUBMIT RACES note in the module doc).
   *  Optional: absent → no serialization (only ad-hoc deps objects). */
  submitLocks?: Map<string, Promise<void>>;
}

export type PromptSubmitResult =
  | { ok: true; itemId: string }
  /** Phase/cutoff/kicked guard refused the prompt (code = machine reason). */
  | { ok: false; stage: "phase"; code: string; error: string }
  | { ok: false; stage: "cooldown"; remainingMs: number }
  | { ok: false; stage: "card_full"; maxItems: number }
  | { ok: false; stage: "too_many_inflight"; maxInflight: number }
  | { ok: false; stage: "validation"; reason: string; exampleFix?: string }
  | { ok: false; stage: "moderation"; reason: string }
  | { ok: false; stage: "ai_unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Friendly per-category moderation copy (kept non-accusatory — party game). */
const MODERATION_MESSAGES: Record<ModerationCategory, string> = {
  none: "That prompt isn't allowed — try describing something else.",
  hate: "That prompt isn't kind enough for a greeting card — try something friendlier.",
  sexual: "Keep it family-friendly — try a different subject.",
  violence: "Cards are a no-fight zone — try something peaceful instead.",
  dangerous: "That's a bit too risky to draw — try something safer.",
  contentious_figure:
    "That's a public figure we'd rather not draw — try a made-up character instead",
  other: "That prompt isn't allowed — try describing something else.",
};

const PHASE_ERRORS: Record<string, string> = {
  phase_ended: "The building phase has ended — hang tight for judging!",
  before_theme: "Wait for the GM to set a theme first!",
  game_in_progress: "The game isn't accepting prompts right now.",
  kicked: "You were removed from this game.",
};

export const AI_UNAVAILABLE_MESSAGE =
  "Generation is temporarily unavailable — try again (this attempt didn't count against your limits)";

const CARD_FULL_MESSAGE = (max: number): string =>
  `This card is full (${max} stickers max) — the GM can move the game along.`;

const TOO_MANY_INFLIGHT_MESSAGE = (max: number): string =>
  `You already have ${max} stickers in progress — wait for one to finish.`;

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

/**
 * Build complete pipeline deps with a FRESH cooldown map. Call ONCE per
 * server (the map + queue are process-wide state); per-request code spreads
 * `{ ...deps, emit }` to attach the socket-specific emitter.
 */
export function createPromptPipelineDeps(
  base: Omit<PromptPipelineDeps, "cooldowns" | "now" | "emit"> & {
    emit?: PromptEmit;
    now?: () => number;
  },
): PromptPipelineDeps {
  return {
    ...base,
    cooldowns: new Map<string, number>(),
    submitLocks: new Map<string, Promise<void>>(),
    now: base.now ?? Date.now,
    // The ws layer passes the socket-specific emitter per call; the default
    // no-op keeps the factory total for tests that never emit.
    emit: base.emit ?? (() => {}),
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run one prompt through the full server-side pipeline (see module doc).
 * Never throws for game-level failures — everything is a typed result.
 *
 * WRAPPER = per-player mutex: concurrent submits from the SAME player run
 * strictly one after another (deps.submitLocks chains them); different
 * players never wait on each other. The entire check→persist→AI→anchor
 * section runs inside the lock so the cooldown/capacity/in-flight checks
 * and the cooldown anchor write cannot interleave with another submit from
 * the same player.
 */
export async function submitPrompt(
  deps: PromptPipelineDeps,
  identity: PromptIdentity,
  text: string,
): Promise<PromptSubmitResult> {
  const locks = deps.submitLocks ?? new Map<string, Promise<void>>();
  // The stored tail promise NEVER rejects (runSubmit never throws), so
  // awaiting it below is safe without a catch.
  const prev = locks.get(identity.playerId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(identity.playerId, gate);
  try {
    await prev;
    return await runSubmit(deps, identity, text);
  } finally {
    release();
    // Only the tail owner removes itself — a concurrent submit may have
    // already replaced the map entry with its own gate.
    if (locks.get(identity.playerId) === gate) locks.delete(identity.playerId);
  }
}

async function runSubmit(
  deps: PromptPipelineDeps,
  identity: PromptIdentity,
  text: string,
): Promise<PromptSubmitResult> {
  const now = deps.now;

  // 0) Resolve the player from the repository (team, nickname, kick state).
  const player = await deps.repo.getPlayer(identity.playerId);
  if (!player || player.gameId !== identity.gameId || player.removedAt !== null) {
    return {
      ok: false,
      stage: "phase",
      code: "kicked",
      error: PHASE_ERRORS.kicked!,
    };
  }

  // 1) Phase + cutoff — the hub's guarded transition is the single authority.
  //    A rejected guard persists and emits NOTHING (pure state machine).
  const guard = await deps.hub.applyEvent(identity.gameId, {
    type: "player:submitPrompt",
    playerId: player.id,
    text,
    now: now(),
  });
  if (!guard.ok) {
    const code = guard.reason;
    return {
      ok: false,
      stage: "phase",
      code,
      error: PHASE_ERRORS[code] ?? "Prompt not accepted right now.",
    };
  }
  const state = guard.state;
  const limits = { ...state.config.limits, ...deps.limits };

  // 2) Cooldown since the player's LAST ACCEPTED submission. Rejected,
  //    blocked and AI-failed attempts never consume or extend it.
  const lastAccepted = deps.cooldowns.get(player.id);
  if (lastAccepted !== undefined) {
    const elapsed = now() - lastAccepted;
    if (elapsed < limits.cooldownMs) {
      return { ok: false, stage: "cooldown", remainingMs: limits.cooldownMs - elapsed };
    }
  }

  // 3) Card capacity: count this round's items excluding terminal/
  //    removed ones (REMOVED / REJECTED / FAILED never occupy space).
  const items = await deps.repo.listItems(player.teamId, state.round);
  const active = items.filter(
    (i) => i.status !== "REMOVED" && i.status !== "REJECTED" && i.status !== "FAILED",
  );
  if (active.length >= limits.maxItemsPerCard) {
    return { ok: false, stage: "card_full", maxItems: limits.maxItemsPerCard };
  }

  // 4) In-flight cap: this player's VALIDATING|GENERATING items this round.
  const inflight = active.filter(
    (i) =>
      i.playerId === player.id && (i.status === "VALIDATING" || i.status === "GENERATING"),
  );
  if (inflight.length >= limits.maxInflightPerPlayer) {
    return { ok: false, stage: "too_many_inflight", maxInflight: limits.maxInflightPerPlayer };
  }

  // 5) Accept → persist VALIDATING (promptRaw verbatim, subject null).
  //    Resurrect a REJECTED/FAILED row with the same natural key instead of
  //    tripping the [teamId, round, promptRaw, playerId] unique index.
  const item = await persistValidatingItem(deps.repo, player, state.round, text, items);

  deps.emit("item:pending", {
    itemId: item.id,
    promptRaw: item.promptRaw,
    nickname: player.nickname,
    playerId: player.id, // lets clients scope their own-stickers ledger
    teamId: player.teamId,
    createdAt: item.createdAt,
  });

  // 5a) AI validation.
  let validation: PromptValidation;
  try {
    const res = await deps.ai.run(
      "prompt_validation",
      { prompt: text, maxWords: MAX_PROMPT_WORDS },
      { gameId: identity.gameId },
    );
    validation = promptValidationSchema.parse(res.data);
  } catch (err) {
    return aiUnavailable(deps, item, player.id, player.teamId, err);
  }
  if (!validation.valid) {
    const reason = validation.reason;
    const exampleFix = validation.example_fix;
    await deps.repo.updateItem(item.id, { status: "REJECTED", failReason: reason });
    // Owner-only: the team never sees rejected prompts. The broadcast
    // item:withdrawn (emitted AFTER the owner event) then removes the
    // team's pending placeholder.
    deps.emit(
      "item:rejected",
      { itemId: item.id, reason, ...(exampleFix ? { exampleFix } : {}) },
      { toPlayerOnly: player.id },
    );
    deps.emit("item:withdrawn", { itemId: item.id, teamId: player.teamId });
    return {
      ok: false,
      stage: "validation",
      reason,
      ...(exampleFix ? { exampleFix } : {}),
    };
  }

  // 5b) Moderation.
  let moderation: Moderation;
  try {
    const res = await deps.ai.run("moderation", { prompt: text }, { gameId: identity.gameId });
    moderation = moderationSchema.parse(res.data);
  } catch (err) {
    return aiUnavailable(deps, item, player.id, player.teamId, err);
  }
  if (!moderation.safe) {
    const reason = MODERATION_MESSAGES[moderation.category];
    await deps.repo.updateItem(item.id, { status: "REJECTED", failReason: reason });
    deps.emit("item:rejected", { itemId: item.id, reason }, { toPlayerOnly: player.id });
    deps.emit("item:withdrawn", { itemId: item.id, teamId: player.teamId });
    return { ok: false, stage: "moderation", reason };
  }

  // 5c) Both checks passed → GENERATING with the normalized subject. The
  //     cooldown anchor is stamped only here (accepted = fully validated).
  const accepted = await deps.repo.updateItem(item.id, {
    status: "GENERATING",
    subject: validation.normalized_subject,
  });
  // Queue enqueue failure must not leave a zombie GENERATING row (a permanent
  // in-flight slot + card-capacity consumer with no item:failed). On failure:
  // mark FAILED, emit owner-only item:failed (same path as ai_unavailable),
  // and treat the attempt as failed — roll the cooldown anchor back to its
  // pre-acceptance value (the anchor was already stamped above, at
  // acceptance; a queue hiccup must not consume the player's cooldown).
  const prevCooldown = deps.cooldowns.get(player.id);
  if (deps.queue) {
    try {
      await deps.queue.enqueue({
        itemId: accepted.id,
        gameId: identity.gameId,
        teamId: player.teamId,
        playerId: player.id,
        round: state.round,
        prompt: text,
        subject: validation.normalized_subject,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await deps.repo.updateItem(accepted.id, {
        status: "FAILED",
        failReason: "queue unavailable",
      });
      if (prevCooldown === undefined) deps.cooldowns.delete(player.id);
      else deps.cooldowns.set(player.id, prevCooldown);
      deps.emit(
        "item:failed",
        { itemId: accepted.id, reason: `queue unavailable (${detail})` },
        { toPlayerOnly: player.id },
      );
      deps.emit("item:withdrawn", { itemId: accepted.id, teamId: player.teamId });
      return { ok: false, stage: "ai_unavailable", reason: AI_UNAVAILABLE_MESSAGE };
    }
  }
  deps.cooldowns.set(player.id, now());
  return { ok: true, itemId: accepted.id };
}

/**
 * AI outage after fallbacks: the item is FAILED (not REJECTED — nothing was
 * wrong with the prompt), the player is told to retry, and no cooldown is
 * consumed. Also emits `item:failed` owner-only so the player's own UI can
 * clear the pending state, then `item:withdrawn` to the team (placeholder
 * cleanup — see the module doc).
 */
async function aiUnavailable(
  deps: PromptPipelineDeps,
  item: ItemRow,
  playerId: string,
  teamId: string,
  err: unknown,
): Promise<PromptSubmitResult> {
  const detail = err instanceof Error ? err.message : String(err);
  await deps.repo.updateItem(item.id, { status: "FAILED", failReason: detail });
  deps.emit("item:failed", { itemId: item.id, reason: detail }, { toPlayerOnly: playerId });
  // Owner-only item:failed FIRST (ledger goes terminal), then the team
  // broadcast that removes the pending placeholder.
  deps.emit("item:withdrawn", { itemId: item.id, teamId });
  return { ok: false, stage: "ai_unavailable", reason: AI_UNAVAILABLE_MESSAGE };
}

/**
 * Create (or resurrect) the VALIDATING item row. `items` is the round's item
 * list already fetched for the capacity check — reused for the resurrection
 * lookup so no extra repo round-trip is needed.
 */
async function persistValidatingItem(
  repo: Repository,
  player: { id: string; teamId: string },
  round: number,
  text: string,
  items: ItemRow[],
): Promise<ItemRow> {
  const previous = items.find(
    (i) =>
      i.playerId === player.id &&
      i.promptRaw === text &&
      (i.status === "REJECTED" || i.status === "FAILED" || i.status === "REMOVED"),
  );
  if (previous) {
    return repo.updateItem(previous.id, { status: "VALIDATING", failReason: null });
  }
  return repo.createItem({
    teamId: player.teamId,
    playerId: player.id,
    round,
    promptRaw: text,
    subject: null,
    status: "VALIDATING",
  });
}
