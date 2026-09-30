/**
 * Reveal3D support tests — the pure fallback-logic helpers (no jsdom, no
 * WebGL): the WebGL probe ladder, the reduced-motion check and the entry
 * easing curve used by the 3D reveal.
 */

import { describe, expect, it } from "vitest";

import { clamp01, easeOutCubic, prefersReducedMotion, supportsWebgl } from "./reveal3d-support";

/** Fake canvas.getContext driven by a record of id → result (or throw). */
function fakeCanvas(
  impl: Record<string, (() => unknown) | null>,
): { calls: string[]; getContext(id: string): unknown } {
  const calls: string[] = [];
  return {
    calls,
    getContext(id: string): unknown {
      calls.push(id);
      const fn = impl[id];
      if (fn === null || fn === undefined) return null;
      return fn();
    },
  };
}

describe("supportsWebgl", () => {
  it("true when webgl2 is available (probes webgl2 FIRST)", () => {
    const canvas = fakeCanvas({ webgl2: () => ({}) });
    expect(supportsWebgl(canvas)).toBe(true);
    expect(canvas.calls).toEqual(["webgl2"]);
  });

  it("falls back to webgl, then experimental-webgl, in order", () => {
    const canvas = fakeCanvas({ webgl: () => ({}) });
    expect(supportsWebgl(canvas)).toBe(true);
    expect(canvas.calls).toEqual(["webgl2", "webgl"]);

    const legacy = fakeCanvas({ "experimental-webgl": () => ({}) });
    expect(supportsWebgl(legacy)).toBe(true);
    expect(legacy.calls).toEqual(["webgl2", "webgl", "experimental-webgl"]);
  });

  it("false when every getContext returns null (headless/jsdom)", () => {
    const canvas = fakeCanvas({});
    expect(supportsWebgl(canvas)).toBe(false);
    expect(canvas.calls).toHaveLength(3);
  });

  it("false when getContext throws (blocked GPU) — and later ids still tried", () => {
    const canvas = fakeCanvas({
      webgl2: () => {
        throw new Error("webgl context lost");
      },
      webgl: () => {
        throw new Error("webgl context lost");
      },
      "experimental-webgl": () => {
        throw new Error("webgl context lost");
      },
    });
    expect(supportsWebgl(canvas)).toBe(false);
    expect(canvas.calls).toHaveLength(3);
  });

  it("true when a later id throws but an earlier one succeeds", () => {
    const canvas = fakeCanvas({
      webgl2: () => {
        throw new Error("boom");
      },
      webgl: () => ({}),
    });
    expect(supportsWebgl(canvas)).toBe(true);
  });
});

describe("prefersReducedMotion", () => {
  it("true only when the media query matches", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });

  it("false when matchMedia is unavailable (null/undefined matcher)", () => {
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });
});

describe("easeOutCubic / clamp01", () => {
  it("endpoints: 0 → 0, 1 → 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("fast start, gentle settle; monotonic across the whole curve", () => {
    expect(easeOutCubic(0.1)).toBeGreaterThan(0.27); // fast start
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("clamps out-of-range input (RAF overshoot safety)", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });
});