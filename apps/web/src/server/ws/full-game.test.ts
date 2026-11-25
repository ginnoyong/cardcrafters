/**
 * FULL-GAME integration test — 10 teams × 12 players (120 players, the
 * 12-per-team cap) driven end to end through the REAL ws surface with the
 * mock AI router (deterministic, $0): greetings → joins → 240 sticker
 * submissions → montage posters → scoring (1080 ratings + 120 own-card
 * rejections) → judging → reveal → RESULTS. Plus the 13th-player capacity
 * rejection.
 *
 * The untimed config (0s build/scoring timers) means no phase timers are
 * armed — the test itself paces every step, like a GM driving the console.
 */

import { type AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { createAiRouter, type AiRouter } from "../ai/router";
import { DEFAULT_ITEMS_DIR } from "../flows/item-image";
import { DEFAULT_MONTAGE_DIR, resetMontageAccumulatorInFlight } from "../flows/montage-accumulator";
import { generateGreetingsForGame } from "../flows/greetings";
import { createServer, type CardCraftersServer } from "../../../server";
import { MemoryRepo } from "../repo/memory-repo";

const TEAMS = 10;
const PER_TEAM = 12; // MAX_TEAM_MEMBERS — the cap itself
const PROMPTS_PER_BOT = 2; // 24 stickers per card — strictly under the 25 cap
const ROUND = 1;

// Untimed: no phase timers armed; the test paces every step itself.
const CONFIG = { ...DEFAULT_CARD_CONFIG, buildTimerSeconds: 0, scoringTimerSeconds: 0 };

let srv: CardCraftersServer;
let repo: MemoryRepo;
let ai: AiRouter;
let hub: CardCraftersServer["hub"];
let port: number;
let gameId: string;
let gameCode: string;
let teamIds: string[] = [];
let joinTokens: string[] = [];
// Item PNGs the mock image handler writes under the Next public dir — removed
// in afterEach so the tests leave no artifacts behind.
const writtenItemFiles: string[] = [];

beforeEach(async () => {
  // Force the in-memory image queue even when the dev .env exports REDIS_URL,
  // and widen the memory queue's concurrency so 240 mock sticker generations
  // drain quickly (default is 4).
  delete process.env.REDIS_URL;
  process.env.CC_IMAGE_CONCURRENCY = "12";
  repo = new MemoryRepo();
  // Force mock mode so tests never hit a real provider even when a local
  // OPENROUTER_API_KEY is present.
  ai = await createAiRouter({ repo, env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
  srv = await createServer({ repo, enableNext: false, ai });
  hub = srv.hub;
  await new Promise<void>((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
  port = (srv.httpServer.address() as AddressInfo).port;
  const setup = await hub.createGame(CONFIG, { teamCount: TEAMS });
  gameId = setup.game.id;
  gameCode = setup.game.code;
  teamIds = setup.teams.map((t) => t.id);
  joinTokens = setup.teams.map((t) => t.joinToken);
});

afterEach(async () => {
  await srv.close();
  delete process.env.CC_IMAGE_CONCURRENCY;
  for (const f of writtenItemFiles) await rm(f, { force: true });
  writtenItemFiles.length = 0;
  // Montage posters persist under the real public dir (gameId subdir) —
  // remove the whole game's montage tree so tests leave no artifacts behind.
  if (gameId) await rm(path.join(DEFAULT_MONTAGE_DIR, gameId), { recursive: true, force: true });
  // The accumulator's fire-and-forget gen passes leave per-team in-flight
  // markers in module state — reset them so the next test starts clean.
  resetMontageAccumulatorInFlight();
});

function connect(auth: Record<string, unknown> = {}): Socket {
  return io(`http://127.0.0.1:${port}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
  });
}

/** Emit and collect the ack (generous timeout — this test runs 120 sockets). */
function emitAck<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  payload?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeoutMs);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

/** Wait for the next occurrence of an event. */
function waitFor<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ~16 concrete, drawable subjects (no mock-moderation blocklist words). */
const PROMPT_POOL = [
  "gold retirement watch",
  "red balloons",
  "beach sunset",
  "tabby cat in a cardboard box",
  "stack of blueberry pancakes",
  "violet jellyfish",
  "wooden sailboat on waves",
  "chess knight on a board",
  "hot air balloon over green hills",
  "vinyl record player",
  "sunflower in a clay pot",
  "robot made of tin cans",
  "pineapple wearing sunglasses",
  "snowy mountain cabin",
  "espresso machine pouring coffee",
  "frog on a lily pad",
];
function promptFor(botIndex: number, attempt: number): string {
  return PROMPT_POOL[(botIndex * 7 + attempt * 3) % PROMPT_POOL.length]!;
}

/** One submit with cooldown/in-flight retries (card_full stays fatal here:
 *  the wave plan keeps every team strictly under the 25-sticker cap). */
async function submitWithRetry(sock: Socket, botIndex: number, text: string): Promise<void> {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const ack = await emitAck<{
      ok: boolean;
      reason?: string;
      code?: string;
      remainingMs?: number;
      maxItems?: number;
    }>(sock, "player:submitPrompt", { text }, 15_000);
    if (ack.ok) return;
    if (ack.code === "cooldown" || ack.reason === "cooldown") {
      await sleep((ack.remainingMs ?? 5_000) + 250);
      continue;
    }
    if (ack.code === "too_many_inflight" || ack.reason === "too_many_inflight") {
      await sleep(500);
      continue;
    }
    throw new Error(`bot ${botIndex} submit "${text}" rejected: ${JSON.stringify(ack)}`);
  }
  throw new Error(`bot ${botIndex} submit "${text}" exhausted retries`);
}

describe("full game — 10 teams × 12 players (capacity cap) end to end", () => {
  it(
    "120 players build, rate, and reach RESULTS through the real ws surface",
    { timeout: 300_000 },
    async () => {
      // -----------------------------------------------------------------
      // JOINS: 120 players (12 per team — exactly the cap) in chunks of ~30
      // with small awaits between chunks. Joins stay in LOBBY/GREETINGS —
      // they must happen BEFORE the theme is set (new players are refused
      // once the game is underway).
      // -----------------------------------------------------------------
      interface Bot {
        sock: Socket;
        playerId: string;
        teamIndex: number;
        teamId: string;
      }
      const bots: Bot[] = [];
      for (let t = 0; t < TEAMS; t++) {
        for (let i = 0; i < PER_TEAM; i++) {
          bots.push({ sock: connect(), playerId: "", teamIndex: t, teamId: "" });
        }
      }
      const joinBot = async (bot: Bot, seq: number): Promise<void> => {
        const ack = await emitAck<{
          ok: boolean;
          identity?: { playerId: string; teamId: string };
        }>(bot.sock, "join", {
          role: "player",
          joinToken: joinTokens[bot.teamIndex],
          nickname: `Bot ${bot.teamIndex}-${seq}`,
        });
        if (!ack.ok || !ack.identity) throw new Error(`join rejected: ${JSON.stringify(ack)}`);
        bot.playerId = ack.identity.playerId;
        bot.teamId = ack.identity.teamId;
      };
      const CHUNK = 30;
      for (let start = 0; start < bots.length; start += CHUNK) {
        await Promise.all(bots.slice(start, start + CHUNK).map((bot, i) => joinBot(bot, start + i)));
        await sleep(50);
      }
      expect(bots.every((b) => b.playerId && b.teamId)).toBe(true);
      for (let t = 0; t < TEAMS; t++) {
        expect(bots.filter((b) => b.teamIndex === t).every((b) => b.teamId === teamIds[t])).toBe(true);
      }

      // -----------------------------------------------------------------
      // GREETINGS: theme + explicit greeting generation (as the GM console
      // does) → 10 DISTINCT greetings, one per team; then approve → BUILD.
      // -----------------------------------------------------------------
      const themed = await hub.applyEvent(gameId, { type: "gm:setTheme", theme: "Mega demo", now: Date.now() });
      if (!themed.ok) throw new Error(`gm:setTheme failed: ${themed.reason}`);
      const greetingBatch = await generateGreetingsForGame(hub, repo, ai, gameId);
      // GM approves greetings → BUILD (player:submitPrompt is refused while
      // the game is still in GREETINGS).
      const approved = await hub.applyEvent(gameId, { type: "gm:approveGreetings", now: Date.now() });
      if (!approved.ok) throw new Error(`gm:approveGreetings failed: ${approved.reason}`);
      expect(greetingBatch.created).toHaveLength(TEAMS);
      const greetingRows = await repo.listGreetings(gameId, ROUND);
      expect(greetingRows).toHaveLength(TEAMS);
      expect(new Set(greetingRows.map((g) => g.text)).size).toBe(TEAMS);

      // -----------------------------------------------------------------
      // BUILD: 240 submits — the cooldown is PER PLAYER, so each team's 12
      // bots submit in parallel; wave 2 lands ~5.2s after wave 1 (past the
      // 5s cooldown) ⇒ ≈12s total instead of a 20-minute serial crawl.
      // -----------------------------------------------------------------
      for (let wave = 0; wave < PROMPTS_PER_BOT; wave++) {
        if (wave > 0) await sleep(5_200); // > the 5s per-player cooldown
        await Promise.all(
          bots.map((bot, i) => submitWithRetry(bot.sock, i, promptFor(i, wave))),
        );
      }

      // Per-team sticker count ≤ 25 (the card_full cap) + remember every
      // written PNG for afterEach cleanup.
      for (const teamId of teamIds) {
        const items = await repo.listItems(teamId, ROUND);
        expect(items.length).toBeLessThanOrEqual(25);
        expect(items.length).toBe(PER_TEAM * PROMPTS_PER_BOT);
        for (const item of items) writtenItemFiles.push(path.join(DEFAULT_ITEMS_DIR, `${item.id}.png`));
      }

      // Montage posters converge on the final staged set (mock mode runs the
      // accumulator end-to-end and completes ALL teams) — poll each team's
      // row until READY with imageSeq === seq (bounded loop, not a fixed
      // sleep: 10 teams × gen passes take a while but finish well under a
      // minute in mock mode).
      const montageDeadline = Date.now() + 120_000;
      for (const teamId of teamIds) {
        for (;;) {
          const row = await repo.getMontageState(teamId, ROUND);
          if (row && row.status === "READY" && row.imageSeq === row.seq) break;
          if (Date.now() > montageDeadline) {
            throw new Error(
              `montage for team ${teamId} never settled: ${JSON.stringify(row)}`,
            );
          }
          await sleep(500);
        }
      }

      // -----------------------------------------------------------------
      // → SCORING via gm:stopBuild. Player copy: LABEL-ONLY card identities
      // (Card A…) + own-card pointer, NEVER a teamName or teamId. GM copy:
      // the full card→team mapping.
      // -----------------------------------------------------------------
      const gm = connect({ role: "gm", gameCode });
      await emitAck(gm, "join", { role: "gm", joinToken: gameCode });

      // One representative bot per team waits for its private scoring copy
      // (per-player-room broadcast) — registered BEFORE gm:stopBuild.
      const reps = teamIds.map((teamId) => bots.find((b) => b.teamId === teamId)!);
      const repCopies = reps.map((rep) =>
        waitFor<{
          cards: Array<{ cardId: string; label: string; teamName?: string; teamId?: string }>;
          yourTeamCardId?: string | null;
        }>(rep.sock, "scoring:started", 30_000),
      );
      const gmCopyPromise = waitFor<{
        cards: Array<{ cardId: string; label: string; teamName: string; teamId: string }>;
      }>(gm, "scoring:started", 30_000);

      const stop = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:stopBuild", {});
      expect(stop.ok).toBe(true);
      expect(stop.phase).toBe("SCORING");

      const [copies, gmCopy] = await Promise.all([Promise.all(repCopies), gmCopyPromise]);
      expect(copies).toHaveLength(TEAMS);
      for (const copy of copies) {
        expect(copy.cards).toHaveLength(TEAMS);
        for (const card of copy.cards) {
          expect(card).not.toHaveProperty("teamName"); // names stay GM-only
          expect(card).not.toHaveProperty("teamId"); // mapping stays server-side
        }
        expect(typeof copy.yourTeamCardId).toBe("string");
        expect(copy.cards.some((c) => c.cardId === copy.yourTeamCardId)).toBe(true);
        // Each team's own-card pointer maps back to that team's rep.
        const ownCard = copy.cards.find((c) => c.cardId === copy.yourTeamCardId);
        expect(ownCard).toBeTruthy();
      }
      expect(gmCopy.cards).toHaveLength(TEAMS);
      for (const card of gmCopy.cards) expect(typeof card.teamId).toBe("string");
      expect(new Set(gmCopy.cards.map((c) => c.teamId))).toEqual(new Set(teamIds));

      // Scoring order: cardIndex = position in the persisted scoring order
      // — derive every bot's targets from the payloads, never from team
      // order.
      const orderedCards = gmCopy.cards; // cards[i] → deterministic score i+1
      const scoreFor = new Map<string, number>(orderedCards.map((c, i) => [c.cardId, i + 1]));
      const ownCardByTeam = new Map<string, string>(
        teamIds.map((teamId, t) => [teamId, copies[t]!.yourTeamCardId!]),
      );

      // -----------------------------------------------------------------
      // RATINGS: 1080 score:submit (12 players × 9 non-own cards; no scoring
      // cooldown) — batched per team, bots in parallel. score = orderIndex+1
      // makes every card's avg its order position ⇒ strictly distinct
      // standings.
      // -----------------------------------------------------------------
      const rateBot = async (bot: Bot, ownCardId: string): Promise<void> => {
        for (const card of orderedCards) {
          if (card.cardId === ownCardId) continue;
          const ack = await emitAck<{ ok: boolean; reason?: string; code?: string }>(
            bot.sock,
            "score:submit",
            { cardId: card.cardId, score: scoreFor.get(card.cardId) },
            15_000,
          );
          if (!ack.ok) {
            throw new Error(`bot on ${bot.teamId} rating ${card.cardId} failed: ${JSON.stringify(ack)}`);
          }
        }
      };
      for (let t = 0; t < TEAMS; t++) {
        const teamBots = bots.filter((b) => b.teamIndex === t);
        await Promise.all(teamBots.map((bot) => rateBot(bot, ownCardByTeam.get(teamIds[t])!)));
      }

      // Tallies: every card rated by 108 raters (120 − its 12 teammates),
      // avg exactly = its score value.
      const aggregates = await repo.aggregateScores(gameId, ROUND);
      expect(aggregates).toHaveLength(TEAMS);
      for (const [i, card] of orderedCards.entries()) {
        const agg = aggregates.find((a) => a.targetTeamId === card.teamId)!;
        expect(agg.count).toBe(PER_TEAM * (TEAMS - 1));
        expect(agg.avg).toBe(i + 1);
      }

      // -----------------------------------------------------------------
      // OWN-CARD GUARD: all 120 players try to rate their own card →
      // rejected with own_card (no row persisted).
      // -----------------------------------------------------------------
      for (let t = 0; t < TEAMS; t++) {
        const ownCardId = ownCardByTeam.get(teamIds[t])!;
        const selfAcks = await Promise.all(
          bots
            .filter((b) => b.teamIndex === t)
            .map((bot) =>
              emitAck<{ ok: boolean; reason?: string; code?: string }>(bot.sock, "score:submit", {
                cardId: ownCardId,
                score: 9,
              }),
            ),
        );
        for (const ack of selfAcks) {
          expect(ack.ok).toBe(false);
          expect(ack.reason ?? ack.code).toBe("own_card");
        }
      }

      // -----------------------------------------------------------------
      // PHASE CHAIN: JUDGING → REVEAL → RESULTS. Winner = team[0] (GM pick);
      // People's Choice = server-computed top-avg card = orderedCards[9]'s
      // team; standings sorted avg-desc (sortStandings).
      // -----------------------------------------------------------------
      const stopScoring = await emitAck<{ ok: boolean; phase?: string }>(gm, "gm:stopScoring", {});
      expect(stopScoring.ok).toBe(true);
      expect(stopScoring.phase).toBe("JUDGING");

      const announcedPromise = waitFor<{
        winnerTeamId?: string;
        standings?: Array<{ teamId: string; label: string; cardId: string; avg: number; count: number }>;
        peoplesChoiceTeamId?: string;
      }>(gm, "winnerAnnounced", 30_000);
      const pick = await emitAck<{ ok: boolean; phase?: string; peoplesChoiceTeamId?: string | null }>(
        gm,
        "judging:winner",
        { teamId: teamIds[0] },
      );
      expect(pick.ok).toBe(true);
      expect(pick.phase).toBe("REVEAL");

      const topCard = orderedCards[orderedCards.length - 1]!; // avg 10
      expect(pick.peoplesChoiceTeamId).toBe(topCard.teamId);
      const announced = await announcedPromise;
      expect(announced.winnerTeamId).toBe(teamIds[0]);
      expect(announced.peoplesChoiceTeamId).toBe(topCard.teamId);

      const standings = announced.standings!;
      expect(standings).toHaveLength(TEAMS);
      for (let i = 1; i < standings.length; i++) {
        expect(standings[i - 1]!.avg).toBeGreaterThanOrEqual(standings[i]!.avg);
      }
      expect(standings[0]!.avg).toBe(TEAMS);
      expect(standings[0]!.teamId).toBe(topCard.teamId);
      expect(standings[standings.length - 1]!.avg).toBe(1);
      for (const entry of standings) {
        expect(entry.count).toBe(PER_TEAM * (TEAMS - 1));
        expect(entry.avg).toBe(scoreFor.get(entry.cardId));
      }

      const reveal = await emitAck<{ ok: boolean; phase?: string }>(gm, "reveal:ack", {});
      expect(reveal.ok).toBe(true);
      expect(reveal.phase).toBe("RESULTS");

      gm.close();
      for (const bot of bots) bot.sock.close();
    },
  );

  it("rejects the 13th player of a team (12-member cap)", async () => {
    const one = await hub.createGame(CONFIG, { teamCount: 1 });
    const token = one.teams[0]!.joinToken;
    for (let i = 1; i <= 12; i++) {
      const joined = await hub.joinPlayer({ joinToken: token, nickname: `Cap${i}` });
      expect(joined.isNewPlayer).toBe(true);
    }
    await expect(hub.joinPlayer({ joinToken: token, nickname: "Thirteen" })).rejects.toThrow(
      /team A is full \(max 12\)/,
    );
  });
});
