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

function greetingOf(team: Record<string, unknown>): { text: string; status: string } {
  return team.greeting as { text: string; status: string };
}
