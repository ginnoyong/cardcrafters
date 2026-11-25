/**
 * scoring-card-extras unit tests — the per-card SCORING payload helpers
 * against the real MemoryRepo:
 *
 *   - latestGreetingText: the round-fallback walk (rows only ever exist for
 *     round 1 in production, but the test seeds BOTH rounds for team A to
 *     prove the walk keeps the LATEST row ≤ the requested round; team B has
 *     no rows at all → "" — the 0-prompt/failed-generation case).
 *   - scoringMontageView: null until the accumulator lands a READY poster;
 *     `{ status: "ready", imageUrl }` once the row is patched READY, and
 *     null again for non-READY statuses (GENERATING / FALLBACK).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { MemoryRepo } from "../repo/memory-repo";
import {
  latestGreetingText,
  resolveCardGreeting,
  scoringCardIsEmpty,
  scoringMontageView,
} from "./scoring-card-extras";

const uniq = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

async function mkGame() {
  const repo = new MemoryRepo();
  const game = await repo.createGame({ config: DEFAULT_CARD_CONFIG });
  const teamA = await repo.createTeam({
    gameId: game.id,
    name: "Crew A",
    label: "Team A",
    joinToken: uniq("join"),
  });
  const teamB = await repo.createTeam({
    gameId: game.id,
    name: "Crew B",
    label: "Team B",
    joinToken: uniq("join"),
  });
  return { repo, game, teamA, teamB };
}

describe("latestGreetingText — round-fallback walk", () => {
  it("keeps the LATEST row at or below the requested round", async () => {
    const { repo, game, teamA } = await mkGame();
    await repo.createGreeting({ teamId: teamA.id, round: 1, text: "Round one hello" });
    await repo.createGreeting({ teamId: teamA.id, round: 2, text: "Round two hello" });

    // Exact-round hit.
    expect(await latestGreetingText(repo, game.id, teamA.id, 2)).toBe("Round two hello");
    // Round 3 has NO rows — the walk down keeps the round-2 text (the
    // production shape: rows only exist for round 1, later rounds fall back).
    expect(await latestGreetingText(repo, game.id, teamA.id, 3)).toBe("Round two hello");
    expect(await latestGreetingText(repo, game.id, teamA.id, 1)).toBe("Round one hello");
  });

  it("returns '' for a team with no greeting rows in any round", async () => {
    const { repo, game, teamB } = await mkGame();
    expect(await latestGreetingText(repo, game.id, teamB.id, 1)).toBe("");
    expect(await latestGreetingText(repo, game.id, teamB.id, 3)).toBe("");
  });
});

describe("resolveCardGreeting — LAST-RESORT blank-card guard", () => {
  it("passes real greeting text through untouched (modulo trim/collapse)", () => {
    expect(resolveCardGreeting("Happy building, Crew A!", "Castles", "Card A")).toBe(
      "Happy building, Crew A!",
    );
    // Whitespace normalization only — a real AI greeting is always preferred.
    expect(resolveCardGreeting("  Hello   world  ", null, "Card B")).toBe("Hello world");
  });

  it("falls back to the themed one-liner when the text is empty (letter = last token of teamLabel)", () => {
    expect(resolveCardGreeting("", "Castles", "Card A")).toBe("Happy Castles, Card A!");
    // The bare letter resolves to the same card identity.
    expect(resolveCardGreeting("", "  Pirate   Cove  ", "B")).toBe(
      "Happy Pirate Cove, Card B!",
    );
  });

  it("falls back to the theme-less one-liner when there is no theme", () => {
    expect(resolveCardGreeting("", null, "Card A")).toBe("For Card A!");
    expect(resolveCardGreeting("", "   ", "B")).toBe("For Card B!");
  });

  it("scoringCardIsEmpty — matches renderTeamCardPng's renderable-item filter", async () => {
    const { repo, game, teamA } = await mkGame();
    // No items → blank.
    expect(await scoringCardIsEmpty(repo, teamA.id, game.round)).toBe(true);
    // A READY item WITHOUT size is not renderable — still blank (the PNG
    // filters width/height>0 before composing).
    const unsized = await repo.createItem({
      teamId: teamA.id,
      playerId: "player-x",
      round: game.round,
      promptRaw: "p",
      subject: "s",
      status: "READY",
    });
    expect(await scoringCardIsEmpty(repo, teamA.id, game.round)).toBe(true);
    // Sized → renderable → not blank.
    await repo.updateItem(unsized.id, { width: 512, height: 512 });
    expect(await scoringCardIsEmpty(repo, teamA.id, game.round)).toBe(false);
  });
});

describe("scoringMontageView — READY-only poster view", () => {
  it("is null when no montage row exists", async () => {
    const { repo, teamA } = await mkGame();
    expect(await scoringMontageView(repo, teamA.id, 1)).toBeNull();
    expect(await repo.getMontageState(teamA.id, 1)).toBeNull();
  });

  it("surfaces {status:'ready', imageUrl} once the row is patched READY — and null for non-READY", async () => {
    const { repo, teamA } = await mkGame();

    // Patch-only upsert creates the row (create-if-missing).
    await repo.upsertMontageState(teamA.id, 1, { patch: { status: "GENERATING" } });
    expect(await scoringMontageView(repo, teamA.id, 1)).toBeNull();

    await repo.upsertMontageState(teamA.id, 1, {
      patch: { status: "READY", imageUrl: "/static/montages/g1/t1/poster.png" },
    });
    expect(await scoringMontageView(repo, teamA.id, 1)).toEqual({
      status: "ready",
      imageUrl: "/static/montages/g1/t1/poster.png",
    });

    // A later fail-open pass (FALLBACK) withdraws the view again.
    await repo.upsertMontageState(teamA.id, 1, {
      patch: { status: "FALLBACK", imageUrl: null },
    });
    expect(await scoringMontageView(repo, teamA.id, 1)).toBeNull();
  });
});
