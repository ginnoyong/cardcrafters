/**
 * empty-card-note — phase-aware empty-card placeholder copy.
 *
 * The CardCanvas itself can never render under test (react-konva), so the
 * copy decision is a pure helper (see lib/empty-card-note.ts) asserted here,
 * and the PROP WIRING (which faces get building={false}) is asserted at the
 * SSR level in TeamJudgeCard.ssr.test.tsx / PresenterTeamStage.ssr.test.tsx.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_CARD_FINISHED,
  EMPTY_CARD_TEASER,
  emptyCardNote,
} from "./empty-card-note";

describe("emptyCardNote — phase-aware empty-card placeholder", () => {
  it("BUILD keeps the classic teaser (verbatim legacy copy)", () => {
    expect(emptyCardNote(true)).toBe(
      "Stickers will appear here as your team creates them…",
    );
    expect(EMPTY_CARD_TEASER).toContain("will appear here");
  });

  it("post-BUILD phases get the finished treatment — never the teaser", () => {
    // SCORING / JUDGING / REVEAL / RESULTS all pass building={false}.
    expect(emptyCardNote(false)).toBe("This card stayed blank this round.");
    expect(emptyCardNote(false)).not.toContain("will appear here");
  });

  it("the two treatments are distinct strings", () => {
    expect(EMPTY_CARD_TEASER).not.toBe(EMPTY_CARD_FINISHED);
  });
});
