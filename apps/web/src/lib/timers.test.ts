/**
 * Unit tests for lib/timers.ts (GM timer-form helpers): minutes → seconds
 * conversion used when creating a game from the GM lobby. Regression guard —
 * the original implementation forgot the ×60, so a "5" minute scoring timer
 * was stored as 5 SECONDS.
 */

import { describe, expect, it } from "vitest";

import { minutesToSeconds } from "./timers";

describe("minutesToSeconds (minutes form string → seconds for game config)", () => {
  it("multiplies by 60: \"5\" → 300, \"10\" → 600", () => {
    expect(minutesToSeconds("5")).toBe(300);
    expect(minutesToSeconds("10")).toBe(600);
  });

  it("trims whitespace but otherwise requires integer digits", () => {
    expect(minutesToSeconds(" 3 ")).toBe(180);
    expect(minutesToSeconds("03")).toBe(180);
  });

  it("\"0\" passes through as 0 (meaningful: untimed / manual stop)", () => {
    expect(minutesToSeconds("0")).toBe(0);
  });

  it("empty, blank or garbage input → undefined (use server default)", () => {
    expect(minutesToSeconds("")).toBeUndefined();
    expect(minutesToSeconds("   ")).toBeUndefined();
    expect(minutesToSeconds("abc")).toBeUndefined();
    expect(minutesToSeconds("5m")).toBeUndefined();
    expect(minutesToSeconds("1e3")).toBeUndefined();
  });

  it("negative and fractional input → undefined", () => {
    expect(minutesToSeconds("-3")).toBeUndefined();
    expect(minutesToSeconds("1.5")).toBeUndefined();
  });

  it("very large safe integers: product stays a safe integer → seconds; overflowing product → undefined", () => {
    // MAX_SAFE_INTEGER minutes × 60 overflows — NOT a safe integer.
    expect(minutesToSeconds(String(Number.MAX_SAFE_INTEGER))).toBeUndefined();
    // Largest minutes value whose ×60 product is still a safe integer.
    const maxSafeMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60); // 150119987579016
    expect(maxSafeMinutes * 60).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(minutesToSeconds(String(maxSafeMinutes))).toBe(maxSafeMinutes * 60);
    // One more minute and the product overflows the safe-integer range.
    expect(minutesToSeconds(String(maxSafeMinutes + 1))).toBeUndefined();
  });
});