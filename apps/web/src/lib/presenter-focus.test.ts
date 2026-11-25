/**
 * presenter-focus — GM judge-box "View" deep-link resolution.
 *
 * The View link targets `/present/<code>?card=<cardId>`; the presenter must
 * resolve that EXACT cardId against its (shuffled, snapshot-driven) scoring
 * order — never an index. These tests pin the pure resolution helpers;
 * the board wiring (carousel index / stage latch) is asserted by the
 * component's own contract.
 */

import { describe, expect, it } from "vitest";

import {
  resolvePresenterCard,
  resolvePresenterCardIndex,
  resolvePresenterCardTeam,
} from "./presenter-focus";

const SHUFFLED = [
  { cardId: "card-c", label: "Card C", teamName: "The Fold Cats" },
  { cardId: "card-a", label: "Card A", teamName: "Team Papercraft" },
  { cardId: "card-e", label: "Card E", teamName: "Glitter Guild" },
  { cardId: "card-b", label: "Card B", teamName: "The Glue Guns" },
  { cardId: "card-d", label: "Card D", teamName: "Ribbon Riots" },
];

describe("resolvePresenterCardIndex", () => {
  it("resolves an exact cardId to its index in the (shuffled) scoring order", () => {
    expect(resolvePresenterCardIndex(SHUFFLED, "card-e", 0)).toBe(2);
    expect(resolvePresenterCardIndex(SHUFFLED, "card-b", 0)).toBe(3);
  });

  it("falls back to the default index for unknown ids", () => {
    expect(resolvePresenterCardIndex(SHUFFLED, "card-z", 0)).toBe(0);
    expect(resolvePresenterCardIndex(SHUFFLED, "", 0)).toBe(0);
    expect(resolvePresenterCardIndex(SHUFFLED, undefined, 0)).toBe(0);
    expect(resolvePresenterCardIndex(SHUFFLED, null, 0)).toBe(0);
  });

  it("respects a non-zero default index on miss", () => {
    expect(resolvePresenterCardIndex(SHUFFLED, "nope", 4)).toBe(4);
  });

  it("is case-sensitive — a partial/wrong-case id is unknown", () => {
    expect(resolvePresenterCardIndex(SHUFFLED, "Card-A", 0)).toBe(0);
    expect(resolvePresenterCardIndex(SHUFFLED, "card-a ", 0)).toBe(0);
  });
});

describe("resolvePresenterCard", () => {
  it("returns the matching card (with its payload fields) or null", () => {
    expect(resolvePresenterCard(SHUFFLED, "card-a")).toEqual({
      cardId: "card-a",
      label: "Card A",
      teamName: "Team Papercraft",
    });
    expect(resolvePresenterCard(SHUFFLED, "card-x")).toBeNull();
    expect(resolvePresenterCard(SHUFFLED, undefined)).toBeNull();
  });
});

describe("resolvePresenterCardTeam", () => {
  const teams = [
    { id: "t1", name: "Team Papercraft" },
    { id: "t2", name: "The Glue Guns" },
    { id: "t3", name: "The Fold Cats" },
  ];

  it("resolves via the card's teamId when present (JUDGING onward)", () => {
    const cards = [
      { cardId: "card-b", teamId: "t2", teamName: "The Glue Guns" },
      { cardId: "card-a", teamId: "t1", teamName: "Team Papercraft" },
    ];
    expect(resolvePresenterCardTeam(cards, "card-b", teams)).toEqual(teams[1]);
  });

  it("resolves via a UNIQUE teamName match when teamId is absent (SCORING)", () => {
    expect(resolvePresenterCardTeam(SHUFFLED, "card-c", teams)).toEqual(teams[2]);
  });

  it("returns null for unknown ids / missing param / ambiguous names", () => {
    expect(resolvePresenterCardTeam(SHUFFLED, "card-z", teams)).toBeNull();
    expect(resolvePresenterCardTeam(SHUFFLED, null, teams)).toBeNull();
    const dupNames = [
      { cardId: "card-x", teamName: "Dup" },
      { cardId: "card-y", teamName: "Dup" },
    ];
    expect(resolvePresenterCardTeam(dupNames, "card-x", teams)).toBeNull();
  });

  it("returns null when the teamId no longer exists in the snapshot", () => {
    const cards = [{ cardId: "card-a", teamId: "gone", teamName: "Team Papercraft" }];
    expect(resolvePresenterCardTeam(cards, "card-a", [])).toBeNull();
  });
});
