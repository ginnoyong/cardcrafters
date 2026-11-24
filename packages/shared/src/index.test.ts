import { describe, expect, it } from "vitest";
import {
  countWords,
  DEFAULT_CARD_RATIO_H,
  DEFAULT_CARD_RATIO_W,
  MAX_PROMPT_WORDS,
  MAX_TEAM_MEMBERS,
  MAX_TEAMS,
} from "./index";

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("happy birthday to you")).toBe(4);
  });

  it("returns 0 for an empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace-only input", () => {
    expect(countWords("   \t\n  ")).toBe(0);
  });

  it("collapses runs of whitespace", () => {
    expect(countWords("  hello\t\tworld\nagain  ")).toBe(3);
  });
});

describe("scaffold constants", () => {
  it("matches the planned game limits", () => {
    expect(MAX_TEAMS).toBe(10);
    expect(MAX_TEAM_MEMBERS).toBe(12);
    expect(MAX_PROMPT_WORDS).toBe(6);
    expect(DEFAULT_CARD_RATIO_W).toBe(3);
    expect(DEFAULT_CARD_RATIO_H).toBe(4);
  });
});