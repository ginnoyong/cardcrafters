/**
 * @cardcrafters/shared
 *
 * Barrel re-export of the shared kernel. This package is consumed directly as
 * TypeScript source — `main`/`types`/`exports` all point at `src/index.ts`.
 * Rationale:
 * - Vitest and tsx compile TS on the fly, so `npm test` and the scaffold
 *   server need no build step.
 * - The Next.js app compiles it via `transpilePackages: ["@cardcrafters/shared"]`
 *   in apps/web/next.config.ts, so `next build` works with no separate tsc run.
 * If this stops being sufficient (e.g. non-TS consumers appear), switch to a
 * tsc build emitting dist/ — documented here so Step 3+ authors know why.
 */

export * from "./constants";
export * from "./words";
export * from "./types";
export * from "./schemas";