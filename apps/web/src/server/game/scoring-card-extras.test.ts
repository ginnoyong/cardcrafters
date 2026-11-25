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
import { latestGreetingText, scoringMontageView } from "./scoring-card-extras";

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
