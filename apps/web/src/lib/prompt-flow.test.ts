/**
 * Unit tests for the player prompt-flow helpers (lib/prompt-flow.ts):
 * the live word counter (delegates to the SHARED counter) and the
 * submit-ack → friendly message mapping for every failure code.
 */

import { describe, expect, it } from "vitest";

import { mapSubmitError, wordCountState } from "./prompt-flow";

describe("wordCountState (shared counting rules)", () => {
  it("6 words → ok; 7 → over (red, submit disabled)", () => {
    const six = wordCountState("golden retriever wearing a party hat"); // 6
    expect(six).toMatchObject({ count: 6, over: false, ok: true });
    const seven = wordCountState("golden retriever wearing a big party hat"); // 7
    expect(seven).toMatchObject({ count: 7, over: true, ok: false });
  });

  it("hyphenated words count as ONE (shared rule)", () => {
    expect(wordCountState("state-of-the-art cake")).toMatchObject({ count: 2, over: false });
  });

  it("punctuation-only tokens count 0; whitespace-only is empty", () => {
    expect(wordCountState("! ? .")).toMatchObject({ count: 0, ok: false, over: false });
    expect(wordCountState("   ")).toMatchObject({ count: 0, ok: false, over: false });
  });

  it("emoji tokens count (documented shared assumption)", () => {
    expect(wordCountState("🎉 party")).toMatchObject({ count: 2, ok: true });
  });
});

describe("mapSubmitError — every failure code", () => {
  it("cooldown shows remaining seconds (rounded up)", () => {
    const msg = mapSubmitError({ ok: false, code: "cooldown", remainingMs: 9500 });
    expect(msg).toContain("10");
    expect(msg.toLowerCase()).toContain("wait");
  });

  it("card_full and too_many_inflight are actionable", () => {
    expect(mapSubmitError({ ok: false, code: "card_full" })).toMatch(/full/i);
    expect(mapSubmitError({ ok: false, code: "too_many_inflight" })).toMatch(/wait|finish/i);
  });

  it("validation includes the reason AND the example fix", () => {
    const msg = mapSubmitError({
      ok: false,
      code: "validation",
      reason: "'happiness' is a feeling.",
      exampleFix: "balloons bursting with confetti",
    });
    expect(msg).toContain("happiness");
    expect(msg).toContain("balloons bursting with confetti");
  });

  it("moderation explains the block without the raw category jargon", () => {
    const msg = mapSubmitError({ ok: false, code: "moderation", reason: "that prompt isn't allowed" });
    expect(msg).toContain("isn't allowed");
  });

  it("ai_unavailable reassures the attempt was free", () => {
    const msg = mapSubmitError({ ok: false, code: "ai_unavailable" });
    expect(msg).toMatch(/try again/i);
    expect(msg).toMatch(/didn't count|not count/i);
  });

  it("phase_ended / before_theme / kicked have distinct friendly texts", () => {
    expect(mapSubmitError({ ok: false, code: "phase_ended" })).toMatch(/over|ended|closed/i);
    expect(mapSubmitError({ ok: false, code: "before_theme" })).toMatch(/theme|started|round/i);
    expect(mapSubmitError({ ok: false, code: "kicked" })).toMatch(/removed|host/i);
  });

  it("empty_prompt / too_many_words mirror the word rules", () => {
    expect(mapSubmitError({ ok: false, code: "empty_prompt" })).toMatch(/describe|something/i);
    expect(mapSubmitError({ ok: false, code: "too_many_words" })).toContain(`over ${6} words`);
  });

  it("unknown code falls back to a generic message", () => {
    expect(mapSubmitError({ ok: false, code: "mystery" })).toBeTruthy();
    expect(mapSubmitError({ ok: false })).toBeTruthy();
  });
});
