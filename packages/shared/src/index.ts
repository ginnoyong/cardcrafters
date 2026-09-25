/**
 * @cardcrafters/shared
 *
 * NOTE (scaffold choice): this package is consumed directly as TypeScript
 * source — `main`/`types`/`exports` all point at `src/index.ts`. Rationale:
 * - Vitest and tsx compile TS on the fly, so `npm test` and the scaffold
 *   server need no build step.
 * - The Next.js app compiles it via `transpilePackages: ["@cardcrafters/shared"]`
 *   in apps/web/next.config.ts, so `next build` works with no separate tsc run.
 * If this stops being sufficient (e.g. non-TS consumers appear), switch to a
 * tsc build emitting dist/ — documented here so Step 3+ authors know why.
 */

/** Maximum number of teams per game. */
export const MAX_TEAMS = 10;
/** Maximum players per team. */
export const MAX_TEAM_MEMBERS = 12;
/** Maximum words per item prompt. */
export const MAX_PROMPT_WORDS = 6;
/** Default card canvas aspect ratio width (5:7 portrait card). */
export const DEFAULT_CARD_RATIO_W = 5;
/** Default card canvas aspect ratio height. */
export const DEFAULT_CARD_RATIO_H = 7;

/**
 * Trivial pure helper used as the scaffold's real test target:
 * counts words in `text`, splitting on runs of whitespace.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}