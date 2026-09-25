/**
 * @cardcrafters/shared — THE canonical word counter.
 *
 * This module must remain dependency-free and byte-identical between client
 * and server: the server trusts the client's live counter only as a hint and
 * re-checks with this exact function, so any divergence would cause confusing
 * rejections. Do not duplicate this logic elsewhere.
 *
 * Counting rules (documented assumptions):
 * - Leading/trailing whitespace is ignored; tokens are split on any run of
 *   whitespace (spaces, tabs, newlines).
 * - Hyphenated words count as ONE word ("well-done" = 1) because splitting is
 *   whitespace-only.
 * - Tokens made purely of punctuation count as ZERO words ("!" alone is not a
 *   word; "wow !!!" = 1).
 * - A token containing any letter or number counts as one word ("don't" = 1,
 *   "state-of-the-art" = 1, "42" = 1).
 * - Emoji count as one word per whitespace-separated token containing emoji
 *   ("🎉 party" = 2; "🎉🎉" as a single token = 1).
 * - Empty or whitespace-only text counts as 0.
 */

import { MAX_PROMPT_WORDS } from "./constants";

/** Re-exported here so UI live counters can import it alongside the counter. */
export { MAX_PROMPT_WORDS };

/** A token counts as a word if it contains a letter or a digit. */
const WORDISH = /[\p{L}\p{N}]/u;
/** A token counts as a word if it contains any emoji/pictographic character. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * Count words in `text` using the rules documented at the top of this module.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  let count = 0;
  for (const token of trimmed.split(/\s+/)) {
    if (token.length === 0) continue;
    if (WORDISH.test(token) || PICTOGRAPHIC.test(token)) count += 1;
  }
  return count;
}

export interface CanSubmitResult {
  /** True iff the prompt has at least one word and at most MAX_PROMPT_WORDS. */
  ok: boolean;
  /** The computed word count (so UIs can show "4 / 6 words"). */
  count: number;
}

/**
 * Whether `text` may be submitted as an item prompt: more than zero words and
 * no more than MAX_PROMPT_WORDS.
 */
export function canSubmit(text: string): CanSubmitResult {
  const count = countWords(text);
  return { ok: count > 0 && count <= MAX_PROMPT_WORDS, count };
}