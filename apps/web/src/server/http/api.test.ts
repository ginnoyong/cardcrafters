/**
 * HTTP API integration tests — in-process `createServer` factory on an
 * ephemeral port (memory repo), driving the raw JSON API with fetch.
 *
 * Design note on awaiting background generation: POST /api/games fires
 * greeting generation fire-and-forget and responds immediately with
 * phase "GREETINGS". Callers/tests synchronize via the exported
 * `waitForGreetings(repo, hub, gameId, count)` polling helper (mock mode
 * resolves ~instantly).
 */

import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAiRouter, type AiRouter } from "../ai/router";
import { createServer, type CardCraftersServer } from "../../../server";
import { waitForGreetings } from "../flows/greetings";
import { MemoryRepo } from "../repo/memory-repo";

let srv: CardCraftersServer;
let port: number;

beforeEach(async () => {
  // Force the in-memory image queue even when the dev .env exports REDIS_URL
  // — ioredis/BullMQ would try to connect to Redis and spam teardown errors.
  delete process.env.REDIS_URL;
  const repo = new MemoryRepo();
  const ai: AiRouter = await createAiRouter({ repo, env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
  srv = await createServer({ repo, enableNext: false, ai });
  await new Promise<void>((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
  port = (srv.httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await srv.close();
});

function base(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe("POST /api/games (greetings flow)", () => {
  it("missing/empty theme → 400 with a friendly error", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/theme/i);

    const resEmpty = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "   " }),
    });
    expect(resEmpty.status).toBe(400);
  });

  it("with a theme → 201 phase GREETINGS + per-team greetings generated", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 3, theme: "Office Plants" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      gameId: string;
      code: string;
      phase: string;
      teams: Array<{ id: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.phase).toBe("GREETINGS");
    expect(body.teams).toHaveLength(3);

    // Await the fire-and-forget generation (mock mode resolves ~instantly).
    const greetings = await waitForGreetings(srv.repo, srv.hub, body.gameId, 3);
    expect(greetings).toHaveLength(3);
    expect(new Set(greetings.map((g) => g.text)).size).toBe(3);
    for (const g of greetings) expect(g.status).toBe("proposed");
  });

  it("?full=1 includes per-team greeting texts; default variant does not", async () => {
    const created = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Dachshunds" }),
    });
    const createdBody = (await created.json()) as { code: string; teams: Array<{ id: string }> };
    // Poll until the fire-and-forget generation lands (mock is near-instant).
    const deadline = Date.now() + 5_000;
    let full: { teams: Array<Record<string, unknown>> } | undefined;
    for (;;) {
      const res = await fetch(base(`/api/games/${createdBody.code}?full=1`));
      full = (await res.json()) as { teams: Array<Record<string, unknown>> };
      const texts = full.teams.map((t) => (greetingOf(t) as { text: string }).text);
      if (texts.every((t) => t.length > 0) || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const texts = full!.teams.map((t) => greetingOf(t).text as string);
    expect(texts).toHaveLength(2);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(2);

    // Non-full variant: no greeting, no joinToken.
    const plain = await fetch(base(`/api/games/${createdBody.code}`));
    const plainBody = (await plain.json()) as { teams: Array<Record<string, unknown>> };
    expect(plainBody.teams[0]!.greeting).toBeUndefined();
    expect(plainBody.teams[0]!.joinToken).toBeUndefined();
  });
});

describe("POST /api/games — phase timer config", () => {
  /** Read the stored CardConfig for a freshly created game. */
  async function storedConfig(code: string): Promise<Record<string, unknown>> {
    const game = await srv.hub.gameByCode(code);
    expect(game).not.toBeNull();
    const state = await srv.hub.getOrCreateHubGame(game!.id);
    return state.config as unknown as Record<string, unknown>;
  }

  it("buildTimerSeconds 0 → stored config 0 (untimed), no timer armed", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "Zero timers", buildTimerSeconds: 0, scoringTimerSeconds: 0 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; gameId: string };
    const config = await storedConfig(body.code);
    expect(config.buildTimerSeconds).toBe(0);
    expect(config.scoringTimerSeconds).toBe(0);
    // Untimed: nothing armed even after greetings resolve.
    expect(srv.hub.timers.armedFor(body.gameId)).toBeUndefined();
  });

  it("buildTimerSeconds 900 (15 min) → stored config 900", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "Fifteen minutes", buildTimerSeconds: 900 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string };
    const config = await storedConfig(body.code);
    expect(config.buildTimerSeconds).toBe(900);
    // Unspecified scoring timer keeps the default (300s).
    expect(config.scoringTimerSeconds).toBe(300);
  });

  it("timers inside the config object merge too; top-level overrides win", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        theme: "Config merge",
        config: { buildTimerSeconds: 120, scoringTimerSeconds: 60 },
        scoringTimerSeconds: 0,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string };
    const config = await storedConfig(body.code);
    expect(config.buildTimerSeconds).toBe(120);
    expect(config.scoringTimerSeconds).toBe(0);
  });

  it("timers inside config above the 24h cap fall back to the default, not the raw value", async () => {
    // setTimeout overflow guard: 6e6 s (> 2^31−1 ms) would otherwise be armed
    // and clamped by Node to ~1 ms, ending the phase instantly.
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        theme: "Over the cap",
        config: { buildTimerSeconds: 6000000, scoringTimerSeconds: 6000000 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string };
    const config = await storedConfig(body.code);
    expect(config.buildTimerSeconds).toBe(600);
    expect(config.scoringTimerSeconds).toBe(300);
  });

  it("negative or fractional timers → 400 with a friendly error", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "Bad timer", buildTimerSeconds: -5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/buildTimerSeconds/);

    const resFrac = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "Bad timer", scoringTimerSeconds: 1.5 }),
    });
    expect(resFrac.status).toBe(400);
  });
});

function greetingOf(team: Record<string, unknown>): { text: string; status: string } {
  return team.greeting as { text: string; status: string };
}

describe("GET /api/games/:code/reveal-card (winner card PNG for the REVEAL 3D moment)", () => {
  /** Create a game and drive it LOBBY→…→REVEAL via hub events (no sockets). */
  async function createGameInReveal(): Promise<{ code: string; gameId: string; winnerTeamId: string }> {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Reveal Cards" }),
    });
    const body = (await res.json()) as { gameId: string; code: string; teams: Array<{ id: string }> };
    const teams = await srv.repo.listTeams(body.gameId);
    const now = Date.now();
    await srv.hub.applyEvent(body.gameId, { type: "gm:approveGreetings", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:stopBuild", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:stopScoring", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:pickWinner", teamId: teams[0]!.id, now });
    return { code: body.code, gameId: body.gameId, winnerTeamId: teams[0]!.id };
  }

  it("unknown code → 404", async () => {
    const res = await fetch(base("/api/games/ZZZZZZ/reveal-card"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unknown_code");
  });

  it("before REVEAL → 409 not_revealing (unfinished cards never leak)", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Too Early" }),
    });
    const body = (await res.json()) as { code: string };
    const early = await fetch(base(`/api/games/${body.code}/reveal-card`));
    expect(early.status).toBe(409);
    const err = (await early.json()) as { ok: boolean; error: string; phase: string };
    expect(err.error).toBe("not_revealing");
    expect(err.phase).toBe("GREETINGS");
  });

  it("REVEAL → 200 image/png (paper card render of the winning team)", async () => {
    const { code } = await createGameInReveal();
    const res = await fetch(base(`/api/games/${code}/reveal-card`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG magic bytes (\x89PNG) — a real, decodable image came back.
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x89);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("RESULTS (auto-advance/ack) still serves the winning card", async () => {
    const { code, gameId } = await createGameInReveal();
    await srv.hub.applyEvent(gameId, { type: "reveal:ack", now: Date.now() });
    const res = await fetch(base(`/api/games/${code}/reveal-card`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("still 200 in RESULTS after a server-side state rehydration (winner pick persistence)", async () => {
    const { code, gameId } = await createGameInReveal();
    // Simulate the hub forgetting the runtime state (restart): hydration
    // rebuilds winnerTeamId from the persisted GM_WINNER pick.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (srv.hub as unknown as { runtime: Map<string, unknown> }).runtime.delete(gameId);
    const res = await fetch(base(`/api/games/${code}/reveal-card`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});
