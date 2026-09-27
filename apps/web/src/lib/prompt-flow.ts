/**
 * Player prompt-flow helpers — pure, unit-testable UI logic for the build
 * screen. The word counter delegates to the SHARED countWords/canSubmit
 * (packages/shared/src/words.ts) so client and server can never disagree.
 */

import { MAX_PROMPT_WORDS, canSubmit, countWords } from "@cardcrafters/shared";

/** Live counter state for the prompt input. */
export interface WordCountState {
  /** Word count (shared counting rules: hyphen = 1, punctuation-only = 0…). */
  count: number;
  /** True when count exceeds MAX_PROMPT_WORDS (counter turns red, submit off). */
  over: boolean;
  /** Convenience: count > 0 && !over (mirrors shared canSubmit().ok). */
  ok: boolean;
}

/** Live "n/6" counter state, byte-identical rules to the server's pre-filter. */
export function wordCountState(text: string): WordCountState {
  const count = countWords(text);
  return {
    count,
    over: count > MAX_PROMPT_WORDS,
    ok: canSubmit(text).ok,
  };
}

// ---------------------------------------------------------------------------
// Ack → friendly message mapping (player:submitPrompt)
// ---------------------------------------------------------------------------

/** The subset of the submit ack the mapper reads (see ws server Ack shape). */
export interface SubmitAckLike {
  ok: boolean;
  code?: string;
  reason?: string;
  error?: string;
  remainingMs?: number;
  exampleFix?: string;
}

/** Code for each failure family (server mapSubmitAck / pipeline stages). */
const SUBMIT_CODES = [
  "cooldown",
  "card_full",
  "too_many_inflight",
  "validation",
  "moderation",
  "ai_unavailable",
  "phase_ended",
  "before_theme",
  "kicked",
  "empty_prompt",
  "too_many_words",
] as const;

/** Map a failed submit ack to a friendly player-facing message. */
export function mapSubmitError(ack: SubmitAckLike): string {
  const code = (ack.code ?? ack.reason ?? "") as (typeof SUBMIT_CODES)[number] | string;
  switch (code) {
    case "cooldown": {
      const secs = Math.max(1, Math.ceil((ack.remainingMs ?? 0) / 1000));
      return `Easy! Wait ${secs}s before the next one.`;
    }
    case "card_full":
      return "The card is full (25 items).";
    case "too_many_inflight":
      return "Wait for your current items to finish (max 3 at once).";
    case "validation": {
      const fix = ack.exampleFix ? ` Try: “${ack.exampleFix}”` : "";
      return `${ack.reason || ack.error || "The AI couldn't picture that — try describing something visible."}${fix}`;
    }
    case "moderation":
      // Server sends a friendly per-category reason — show it verbatim.
      return ack.reason || "That prompt can't go on the card — try rephrasing it kindly.";
    case "ai_unavailable":
      return "The AI artist is unavailable right now — try again in a moment. (It didn't count against your limits.)";
    case "phase_ended":
      return "The building phase has ended.";
    case "before_theme":
      return "Wait for the host to set the theme first.";
    case "kicked":
      return "You've been removed from this game.";
    case "empty_prompt":
      return "Type something first — describe something visible.";
    case "too_many_words":
      return `That's over ${MAX_PROMPT_WORDS} words — trim it down a little.`;
    default:
      return ack.error || "Something went wrong — please try again.";
  }
}