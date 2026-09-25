/**
 * Flows: greetings — generation batch semantics (N distinct greetings),
 * per-team failure isolation, regenerate. Uses the real AiRouter in forced
 * mock mode (AI_MODE=mock) plus a failure-injecting wrapper for one team.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { createAiRouter, type AiRouter } from "../ai/router";
import { GameHub } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import { generateGreetingsForGame, regenerateGreeting } from "./greetings";

let repo: MemoryRepo;
let hub: GameHub;
let ai: AiRouter;

beforeEach(async () => {
  repo = new MemoryRepo();
  hub = new GameHub(repo, { to: () => ({ emit: () => {} }) });
  ai = await createAiRouter({ repo, env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
});

afterEach(() => {
  hub.shutdown();
});

async function createGameWithTheme(teamCount: number): Promise<string> {
  const setup = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount });
  await hub.applyEvent(setup.game.id, {
    type: "gm:setTheme",
    theme: "Golden Retrievers",
    now: Date.now(),
  });
  return setup.game.id;
}

describe("generateGreetingsForGame", () => {
  it("persists one distinct proposed greeting per team", async () => {
    const gameId = await createGameWithTheme(4);
    const batch = await generateGreetingsForGame(hub, repo, ai, gameId);
    expect(batch.results).toHaveLength(4);
    expect(batch.created).toHaveLength(4);
    const texts = batch.created.map((g) => g.text);
    expect(new Set(texts).size).toBe(4);
    for (const g of batch.created) {
      expect(g.status).toBe("proposed");
      expect(g.text.length).toBeGreaterThan(0);
    }
    // Persisted rows match the batch (one Greeting row per team+round).
    const rows = await repo.listGreetings(gameId, 1);
    expect(rows).toHaveLength(4);
  });

  it("a failing AI call for one team does not sink the batch", async () => {
    const gameId = await createGameWithTheme(3);
    // Failure-injecting wrapper: teamIndex 1 always fails.
    const flaky: AiRouter = {
      run: (task: Parameters<AiRouter["run"]>[0], input: Record<string, unknown>, opts?: { gameId?: string }) =>
        input.teamIndex === 1
          ? Promise.reject(new Error("mock AI outage"))
          : ai.run(task, input, opts),
    } as unknown as AiRouter;

    const batch = await generateGreetingsForGame(hub, repo, flaky, gameId);
    expect(batch.results).toHaveLength(3);
    const failed = batch.results.filter((r) => !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain("mock AI outage");
    // The failed team is absent from persisted greetings.
    const okIds = batch.created.map((g) => g.teamId);
    expect(okIds).toHaveLength(2);
    expect(okIds).not.toContain(failed[0]!.teamId);
    const rows = await repo.listGreetings(gameId, 1);
    expect(rows.some((g) => g.teamId === failed[0]!.teamId)).toBe(false);
  });

  it("regenerateGreeting replaces the text and returns it", async () => {
    const gameId = await createGameWithTheme(2);
    await generateGreetingsForGame(hub, repo, ai, gameId);
    const teams = await repo.listTeams(gameId);
    const team = teams[1]!;
    const round = 1;

    const text = await regenerateGreeting(hub, repo, ai, gameId, team.id);
    expect(text).toBeTruthy();
    let row = (await repo.listGreetings(gameId, round)).find((g) => g.teamId === team.id)!;
    expect(row.text).toBe(text);
    expect(row.status).toBe("proposed");

    // Regeneration replaces even an "edited" row (documented GM-intent rule).
    await repo.updateGreeting(team.id, round, { text: "hand written", status: "edited" });
    const text2 = await regenerateGreeting(hub, repo, ai, gameId, team.id);
    row = (await repo.listGreetings(gameId, round)).find((g) => g.teamId === team.id)!;
    expect(row.text).toBe(text2);
    expect(row.status).toBe("proposed");
  });
});
