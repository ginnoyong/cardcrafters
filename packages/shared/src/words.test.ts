import { describe, expect, it } from "vitest";

import { canSubmit, countWords, MAX_PROMPT_WORDS } from "./words";

describe("countWords", () => {
  it("accepts exactly 6 words", () => {
    expect(countWords("happy birthday to my dear friend")).toBe(6);
    expect(canSubmit("happy birthday to my dear friend")).toEqual({
      ok: true,
      count: 6,
    });
  });

  it("rejects 7 words", () => {
    expect(countWords("one two three four five six seven")).toBe(7);
    expect(canSubmit("one two three four five six seven")).toEqual({
      ok: false,
      count: 7,
    });
  });

  it("counts hyphenated words as ONE word", () => {
    // "state-of-the-art" = 1 token, "cake" = 1 → 2 total
    expect(countWords("state-of-the-art cake")).toBe(2);
    expect(countWords("well-done")).toBe(1);
  });

  it("ignores punctuation-only tokens", () => {
    expect(countWords("!")).toBe(0);
    expect(countWords("wow !!! ??? ...")).toBe(1);
    expect(countWords("hi , - ' there")).toBe(2);
  });

  it("counts emoji as one token each", () => {
    expect(countWords("🎉 party")).toBe(2);
    expect(countWords("🎂")).toBe(1);
  });

  it("returns 0 for empty and whitespace-only strings", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  ")).toBe(0);
    expect(canSubmit("  ")).toEqual({ ok: false, count: 0 });
  });

  it("handles tabs, newlines and multiple spaces", () => {
    expect(countWords("one\ttwo\nthree   four")).toBe(4);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(countWords("  hello world  ")).toBe(2);
    expect(countWords("\n\t hello \t\n")).toBe(1);
  });

  it("exposes MAX_PROMPT_WORDS for UI live counters", () => {
    expect(MAX_PROMPT_WORDS).toBe(6);
  });

  it("canSubmit boundary: 0 words fails, 6 passes, 7 fails", () => {
    expect(canSubmit("!!!").ok).toBe(false);
    expect(canSubmit("a b c d e f").ok).toBe(true);
    expect(canSubmit("a b c d e f g").ok).toBe(false);
  });
});