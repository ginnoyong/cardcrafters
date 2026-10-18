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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { DEFAULT_CARD_CONFIG, type MontageGrading, type StyleDerivation } from "@cardcrafters/shared";

import { createAiRouter, type AiRouter } from "../ai/router";
import { drawMockSticker } from "../ai/mock-provider";
import { createServer, type CardCraftersServer } from "../../../server";
import { waitForGreetings } from "../flows/greetings";
import { DEFAULT_ITEMS_DIR } from "../flows/item-image";
import { REF_SIZE, cardBoxNormalized, baseFit } from "../../lib/canvas-geometry";
import { DEFAULT_CARD_WIDTH_PX, deriveGradingFromStyle, renderCardPng } from "../render/card-render";
import type { GameRow } from "../repo/repository";
import { MemoryRepo } from "../repo/memory-repo";

const RATIO_W = DEFAULT_CARD_CONFIG.cardRatioW;
const RATIO_H = DEFAULT_CARD_CONFIG.cardRatioH;
const STAGE_W = DEFAULT_CARD_WIDTH_PX;
const STAGE_H = Math.round((STAGE_W * RATIO_H) / RATIO_W); // → 1120 (5:7)

/** Paper background color — must stay in sync with card-render.ts. */
const PAPER = { r: 0xfa, g: 0xf5, b: 0xec };

/** RGBA pixel at (x, y) from a raw decode (pattern from card-render.test.ts). */
function pixelAt(raw: Buffer, x: number, y: number, width: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!];
}

function isPaper([r, g, b]: [number, number, number, number]): boolean {
  return r === PAPER.r && g === PAPER.g && b === PAPER.b;
}

/** Write a real mock sticker PNG into the default storage dir under its item id. */
async function writeSticker(storageDir: string, itemId: string, prompt: string, size = 512) {
  const { base64 } = drawMockSticker(prompt);
  await mkdir(storageDir, { recursive: true });
  await writeFile(path.join(storageDir, `${itemId}.png`), Buffer.from(base64, "base64"));
  return { itemId, imageUrl: `/static/items/${itemId}.png`, width: size, height: size };
}

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
  // Clean up any sticker PNGs written to the default storage dir by tests.
  try {
    const files = await import("node:fs/promises").then((fs) => fs.readdir(DEFAULT_ITEMS_DIR));
    for (const f of files) {
      if (f.startsWith("seed-")) {
        await import("node:fs/promises").then((fs) => fs.rm(path.join(DEFAULT_ITEMS_DIR, f), { force: true }));
      }
    }
  } catch {
    // dir may not exist — nothing to clean.
  }
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

/**
 * Mirror renderTeamCardPng's gather (http/api.ts) and re-render the SAME
 * gather TWICE locally: once with the endpoint's exact finalPass options
 * (feathered stickers + style-pack grading), once crisp (the build-phase
 * look, no finalPass/grading). Returns [finalPassPng, crispPng] for
 * byte-comparison against the PNG the endpoint serves.
 */
async function localFinalPassAndCrispRender(
  game: GameRow,
  teamId: string,
): Promise<[Buffer, Buffer]> {
  const layout = await srv.repo.getLayoutState(teamId, game.round);
  const items = (await srv.repo.listItems(teamId, game.round, ["READY"]))
    .filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0)
    .map((r) => ({ itemId: r.id, imageUrl: r.imageUrl, width: r.width!, height: r.height! }));
  const greeting = (await srv.repo.listGreetings(game.id, game.round)).find(
    (g) => g.teamId === teamId,
  );
  const baseOpts = { cardRatioW: game.config.cardRatioW, cardRatioH: game.config.cardRatioH };
  const placements = { placements: layout?.placements ?? [] };
  const text = greeting?.text ?? "";
  const finalPassRender = await renderCardPng(items, placements, text, {
    ...baseOpts,
    finalPass: true,
    grading: deriveGradingFromStyle(game.style, teamId),
  });
  const crispRender = await renderCardPng(items, placements, text, baseOpts);
  return [finalPassRender, crispRender];
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
    // Await the fire-and-forget greeting generation FIRST (mock resolves
    // ~instantly) so the persisted greeting text is stable before the phases
    // are driven and the served card is rendered (byte-comparison tests).
    await waitForGreetings(srv.repo, srv.hub, body.gameId, teams.length);
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

  it("?teamId=<valid team> → 200 image/png for that team's card in RESULTS", async () => {
    const { code, winnerTeamId } = await createGameInReveal();
    const res = await fetch(base(`/api/games/${code}/reveal-card?teamId=${winnerTeamId}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x89);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("?teamId=<foreign id> → 404 team_not_found (no cross-game card leak)", async () => {
    const { code } = await createGameInReveal();
    const res = await fetch(
      base(`/api/games/${code}/reveal-card?teamId=00000000-0000-4000-8000-000000000000`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("team_not_found");
  });

  it("?teamId before REVEAL (JUDGING) → 409 not_revealing even for a valid team", async () => {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Too Early For TeamId" }),
    });
    const body = (await res.json()) as {
      code: string;
      gameId: string;
      teams: Array<{ id: string }>;
    };
    const now = Date.now();
    await srv.hub.applyEvent(body.gameId, { type: "gm:approveGreetings", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:stopBuild", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:stopScoring", now });
    const res2 = await fetch(
      base(`/api/games/${body.code}/reveal-card?teamId=${body.teams[0]!.id}`),
    );
    expect(res2.status).toBe(409);
    const err = (await res2.json()) as { ok: boolean; error: string; phase: string };
    expect(err.error).toBe("not_revealing");
    expect(err.phase).toBe("JUDGING");
  });

  it("REVEAL → serves the byte-identical finalPass render (montage polish, NOT the crisp build render)", async () => {
    const { code, gameId, winnerTeamId } = await createGameInReveal();
    const res = await fetch(base(`/api/games/${code}/reveal-card`));
    expect(res.status).toBe(200);
    const fetched = Buffer.from(await res.arrayBuffer());
    const game = (await srv.repo.getGame(gameId))!;
    const [finalPassRender, crispRender] = await localFinalPassAndCrispRender(game, winnerTeamId);
    // Byte-identical to the endpoint's own gather+render (renderCardPng is
    // deterministic — card-render.test.ts pins byte-determinism, and the PNG
    // embeds no timestamps).
    expect(Buffer.compare(fetched, finalPassRender)).toBe(0);
    // …and distinct from the crisp build-phase render: the finalPass grading
    // (style-pack derived, or the neutral vignette) applies even for a
    // zero-item card.
    expect(Buffer.compare(fetched, crispRender)).not.toBe(0);
  });
});

describe("GET /api/games/:code/scoring-card/:cardId?token= (player rating card PNG)", () => {
  /** Create a game, join a player on team A, and drive it to SCORING. */
  async function createGameInScoring(nickname = "Rater"): Promise<{
    code: string;
    gameId: string;
    sessionToken: string;
    firstCardId: string;
  }> {
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Scoring Cards" }),
    });
    const body = (await res.json()) as { gameId: string; code: string };
    // Await the fire-and-forget greeting generation FIRST (mock resolves
    // ~instantly) so the persisted greeting text is stable before the served
    // card is rendered (byte-comparison tests).
    await waitForGreetings(srv.repo, srv.hub, body.gameId, 2);
    const joined = await srv.hub.joinPlayer({
      joinToken: (await srv.repo.listTeams(body.gameId))[0]!.joinToken,
      nickname,
    });
    const now = Date.now();
    await srv.hub.applyEvent(body.gameId, { type: "gm:approveGreetings", now });
    await srv.hub.applyEvent(body.gameId, { type: "gm:stopBuild", now });
    const game = await srv.repo.getGame(body.gameId);
    const order = game?.scoringOrder;
    if (!order || order.round !== 1 || order.cards.length < 2) {
      throw new Error(`no scoring order after gm:stopBuild: ${JSON.stringify(order)}`);
    }
    return { code: body.code, gameId: body.gameId, sessionToken: joined.player.sessionToken, firstCardId: order.cards[0]!.cardId };
  }

  it("unknown code → 404", async () => {
    const res = await fetch(base("/api/games/ZZZZZZ/scoring-card/card-a?token=whatever"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unknown_code");
  });

  it("missing token → 403 invalid_token (the anonymous card stays unmapped)", async () => {
    const { code, firstCardId } = await createGameInScoring();
    const res = await fetch(base(`/api/games/${code}/scoring-card/${firstCardId}`));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("invalid_token");
  });

  it("unknown token → 403; a token from ANOTHER game → 403 (never leaks cards)", async () => {
    const { code, firstCardId } = await createGameInScoring();
    const stranger = await createGameInScoring("Stranger");
    const resUnknown = await fetch(base(`/api/games/${code}/scoring-card/${firstCardId}?token=no-such-token`));
    expect(resUnknown.status).toBe(403);
    expect(((await resUnknown.json()) as { error: string }).error).toBe("invalid_token");
    const resForeign = await fetch(
      base(`/api/games/${code}/scoring-card/${firstCardId}?token=${stranger.sessionToken}`),
    );
    expect(resForeign.status).toBe(403);
    expect(((await resForeign.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("outside SCORING/JUDGING → 409 not_scoring (no card previews before build ends)", async () => {
    // A token valid for the game, but the game is still in GREETINGS.
    const res = await fetch(base("/api/games"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: 2, theme: "Too Early To Rate" }),
    });
    const body = (await res.json()) as { gameId: string; code: string };
    const joined = await srv.hub.joinPlayer({
      joinToken: (await srv.repo.listTeams(body.gameId))[0]!.joinToken,
      nickname: "Early",
    });
    const resEarly = await fetch(
      base(`/api/games/${body.code}/scoring-card/card-a?token=${joined.player.sessionToken}`),
    );
    expect(resEarly.status).toBe(409);
    const err = (await resEarly.json()) as { ok: boolean; error: string; phase: string };
    expect(err.error).toBe("not_scoring");
    expect(err.phase).toBe("GREETINGS");
  });

  it("SCORING + unknown cardId → 404 unknown_card", async () => {
    const { code, sessionToken } = await createGameInScoring();
    const res = await fetch(base(`/api/games/${code}/scoring-card/card-zzz?token=${sessionToken}`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("unknown_card");
  });

  it("SCORING → 200 image/png (paper card render behind the anonymous cardId)", async () => {
    const { code, sessionToken, firstCardId } = await createGameInScoring();
    const res = await fetch(base(`/api/games/${code}/scoring-card/${firstCardId}?token=${sessionToken}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG magic bytes (\x89PNG) — a real, decodable image came back.
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x89);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("SCORING → serves the byte-identical finalPass render (and NOT the crisp build render)", async () => {
    const { code, gameId, sessionToken, firstCardId } = await createGameInScoring();
    const res = await fetch(
      base(`/api/games/${code}/scoring-card/${firstCardId}?token=${sessionToken}`),
    );
    expect(res.status).toBe(200);
    const fetched = Buffer.from(await res.arrayBuffer());
    const game = (await srv.repo.getGame(gameId))!;
    const card = game.scoringOrder!.cards.find((c) => c.cardId === firstCardId)!;
    const [finalPassRender, crispRender] = await localFinalPassAndCrispRender(game, card.teamId);
    // Byte-identical to the endpoint's own gather+render (deterministic
    // renderer — see card-render.test.ts's byte-determinism pins).
    expect(Buffer.compare(fetched, finalPassRender)).toBe(0);
    // …and distinct from the crisp build-phase render (finalPass grading,
    // neutral vignette included, applies even for a zero-item card).
    expect(Buffer.compare(fetched, crispRender)).not.toBe(0);
  });

  /**
   * END-TO-END: a seeded game with READY items (real sticker PNGs on disk)
   * and a persisted layout → the scoring-card PNG must decode to a REAL,
   * non-paper pixel-variance image (the stickers actually drawn), and must
   * match the reveal-card render byte-for-byte (parity — same gather+render
   * path: renderTeamCardPng in api.ts).
   */
  it("SCORING → decodes to a non-paper pixel-variance render with reveal-card parity", async () => {
    const { code, gameId, sessionToken, firstCardId } = await createGameInScoring();
    const game = (await srv.repo.getGame(gameId))!;
    const card = game.scoringOrder!.cards.find((c) => c.cardId === firstCardId)!;
    const teamId = card.teamId;
    const round = game.round;

    // 1. Seed a READY item with a REAL sticker PNG in the default storage
    //    dir — the same DEFAULT_ITEMS_DIR the renderer reads from.
    const sticker = await writeSticker(DEFAULT_ITEMS_DIR, `seed-${gameId}-item`, "red balloon");
    const item = await srv.repo.createItem({
      teamId,
      playerId: "seed-player",
      round,
      promptRaw: "a red balloon",
      status: "GENERATING",
    });
    await srv.repo.updateItem(item.id, {
      status: "READY",
      imageUrl: sticker.imageUrl,
      width: sticker.width,
      height: sticker.height,
      placedAt: Date.now(),
    });

    // 2. Persist the layout: one centered hero placement for that item,
    //    scaled through the same geometry the renderer maps through (65%
    //    of the card width — the "fixed 65% centered" montage policy).
    const cardBox = cardBoxNormalized(RATIO_W, RATIO_H);
    const k = baseFit(cardBox);
    const pxPerUnit = STAGE_W / cardBox.w;
    const heroDisplayPx = 0.65 * STAGE_W;
    const heroScale = heroDisplayPx / (REF_SIZE * k * pxPerUnit);
    const placements = [{ itemId: item.id, x: cardBox.w / 2, y: 550, scale: heroScale, rotation: 0, zIndex: 0 }];
    await srv.repo.upsertLayoutState(teamId, round, {
      version: 2,
      source: "montage",
      placements,
      greetingStyle: null,
      critique: null,
    });

    // 3. Fetch the scoring card with the player token.
    const res = await fetch(
      base(`/api/games/${code}/scoring-card/${firstCardId}?token=${sessionToken}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const fetched = Buffer.from(await res.arrayBuffer());

    // 4. Decode and assert REAL sticker pixels: a blank/paper-only render
    //    (the bug under test) would count ZERO non-paper pixels around the
    //    hero placement. With the sticker drawn, they are thousands.
    const meta = await sharp(fetched).metadata();
    const width = meta.width!;
    const raw = await sharp(fetched).ensureAlpha().raw().toBuffer();
    const nonPaper = (() => {
      let count = 0;
      for (let i = 0; i < raw.length; i += 4) {
        if (!isPaper([raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!])) count++;
      }
      return count;
    })();
    expect(nonPaper).toBeGreaterThan(20_000);
    // Sample inside the mapped hero box (centered at 65% width): the pixel
    // must NOT be paper — the sticker is actually composited.
    const heroCx = Math.round(placements[0]!.x * pxPerUnit);
    const heroCy = Math.round(placements[0]!.y * (STAGE_H / cardBox.h));
    expect(heroCx).toBe(Math.round(STAGE_W / 2)); // centered
    // Sample a small region around the hero center (±20px): a single pixel
    // can land on a sticker's own paper-colored area; the hero box center
    // must contain at least one sticker pixel in the sampled window.
    const sampled = [
      pixelAt(raw, heroCx, heroCy + 40, width),
      pixelAt(raw, heroCx - 20, heroCy, width),
      pixelAt(raw, heroCx + 20, heroCy, width),
      pixelAt(raw, heroCx, heroCy - 20, width),
      pixelAt(raw, heroCx, heroCy + 20, width),
    ];
    const anyNonPaper = sampled.some((px) => !isPaper(px));
    if (!anyNonPaper) {
      console.log(
        `[scoring-card] FAIL: no non-paper pixels in hero window (heroCx=${heroCx}, heroCy=${heroCy}, nonPaper=${nonPaper})`,
      );
    }
    expect(anyNonPaper).toBe(true);

    // 5. reveal-card parity: the same gather+render path (renderTeamCardPng)
    //    serves the reveal-card route — the fetched scoring render must be
    //    byte-identical to the local finalPass render of the same state.
    const [finalPassRender] = await localFinalPassAndCrispRender(game, teamId);
    expect(Buffer.compare(fetched, finalPassRender)).toBe(0);
  });
});
