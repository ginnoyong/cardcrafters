/**
 * Reveal3D support — the pure, dependency-free checks behind the 3D winner
 * reveal's fallback ladder, split out so they are unit-testable in a plain
 * Node vitest environment (no jsdom/WebGL needed — the callers inject fakes).
 *
 * Fallback ladder (Reveal3D.tsx): any of these → static WinnerBanner —
 *   1. prefers-reduced-motion (the moment must not animate);
 *   2. WebGL unavailable (headless browsers, jsdom, blocked GPU);
 *   3. Three.js dynamic import failing (offline chunk, bundling quirk);
 *   4. the reveal-card texture failing to load (endpoint 409/404/network).
 */

/** Minimal slice of HTMLCanvasElement the probe needs (test fakes suffice). */
export interface WebGLContextGetter {
  /** Mirrors canvas.getContext — may return null or throw. */
  getContext(contextId: string, ...args: unknown[]): unknown;
}

/** Context ids probed in order — modern first, legacy last. */
const WEBGL_CONTEXT_IDS = ["webgl2", "webgl", "experimental-webgl"] as const;

/**
 * Does this canvas have ANY usable WebGL context? Probes webgl2 → webgl →
 * experimental-webgl; a thrown getContext (GPU blocked) counts as unavailable.
 */
export function supportsWebgl(canvas: WebGLContextGetter): boolean {
  for (const id of WEBGL_CONTEXT_IDS) {
    try {
      if (canvas.getContext(id)) return true;
    } catch {
      // Context creation can throw (blocked/failed GPU) — try the next id.
    }
  }
  return false;
}

/** Media-query slice (window.matchMedia result; may be missing entirely). */
export interface MotionMatcher {
  matches: boolean;
}

/** True when the user asked for reduced motion — show the static banner. */
export function prefersReducedMotion(matcher: MotionMatcher | null | undefined): boolean {
  return matcher?.matches === true;
}

/** Entry "materialize" duration (ms) — the slow scale-up to idle float. */
export const REVEAL_ENTRY_MS = 1800;

/** Clamp to [0, 1] — animation progress guard. */
export function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Ease-out cubic — fast start, gentle settle (the materialize curve). */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** Lighting rig + sheen-sweep parameters for the reveal scene. */
export interface GlossLightParams {
  /** Warm key light intensity. */
  keyIntensity: number;
  /** Cool rim light intensity. */
  rimIntensity: number;
  /** Ambient base intensity. */
  ambientIntensity: number;
  /** Sheen sweep period in seconds (undefined ⇒ no sweep). */
  sheenPeriod?: number;
  /** Whether the specular sheen sweep runs at all. */
  sheenEnabled: boolean;
}

/** Default (calm) lighting — the presenter REVEAL look, unchanged. */
const DEFAULT_LIGHT_PARAMS: GlossLightParams = {
  keyIntensity: 1.5,
  rimIntensity: 0.45,
  ambientIntensity: 1.05,
  sheenPeriod: undefined,
  sheenEnabled: false,
};

/** Winner-gloss lighting — brighter rig + a slow specular sheen sweep. */
const GLOSS_LIGHT_PARAMS: GlossLightParams = {
  keyIntensity: 2.1,
  rimIntensity: 0.75,
  ambientIntensity: 1.3,
  sheenPeriod: 6,
  sheenEnabled: true,
};

/**
 * Pure lighting rig for the reveal scene. gloss=false (default) returns the
 * original presenter intensities with the sheen disabled; gloss=true returns
 * a brighter rig (winner card) plus a ~6s sinusoidal sheen sweep.
 */
export function glossLightParams(gloss: boolean): GlossLightParams {
  return gloss ? { ...GLOSS_LIGHT_PARAMS } : { ...DEFAULT_LIGHT_PARAMS };
}