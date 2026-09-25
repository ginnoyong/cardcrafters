/**
 * PrismaRepo contract tests — run against the real dockerized postgres
 * (localhost:5432, healthy via docker compose). Each test uses a unique
 * code/nickname prefix and cleans up by deleting the game (ordered deletes
 * because the schema does not cascade).
 *
 * These mirror the core memory-repo contract so drift between the two
 * implementations is caught. If DATABASE_URL is unreachable the suite skips.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";
import { PrismaClient } from "@prisma/client";

import { RepoError } from "./memory-repo";
import { PrismaRepo } from "./prisma-repo";

const prisma = new PrismaClient();
const repo = new PrismaRepo(prisma);

/** Unique-per-run prefix so codes/nicknames never collide across runs. */
const testId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const DB_OK = await databaseReachable();

let leakedGameId: string | null = null;

/** Ordered deletes (schema has no cascade) for a game and everything under it. */
async function cleanupGame(gameId: string): Promise<void> {
  await prisma.aiCall.deleteMany({ where: { gameId } });
  await prisma.winnerPick.deleteMany({ where: { gameId } });
  await prisma.score.deleteMany({ where: { gameId } });
  await prisma.greeting.deleteMany({ where: { team: { gameId } } });
  await prisma.layoutState.deleteMany({ where: { team: { gameId } } });
  await prisma.item.deleteMany({ where: { team: { gameId } } });
  await prisma.player.deleteMany({ where: { gameId } });
  await prisma.team.deleteMany({ where: { gameId } });
  await prisma.game.deleteMany({ where: { id: gameId } });
}

beforeEach(async () => {
  if (leakedGameId) {
    await cleanupGame(leakedGameId);
    leakedGameId = null;
  }
});

afterAll(async () => {
  if (leakedGameId) await cleanupGame(leakedGameId);
  await prisma.$disconnect();
});

/** Create a uniquely-coded game, run `body(game)`, always clean up. */
async function withGame(body: (gameId: string) => Promise<void>): Promise<void> {
  const game = await repo.createGame({
    config: DEFAULT_CARD_CONFIG,
    code: `t${testId}${Math.random().toString(36).slice(2, 8)}`,
  });
  leakedGameId = game.id;
  try {
    await body(game.id);
  } finally {
    await cleanupGame(game.id);
    if (leakedGameId === game.id) leakedGameId = null;
  }
}

function mkTeam(gameId: string, letter: string) {
  return repo.createTeam({
    gameId,
    name: `Crew ${letter}`,
    label: `${letter}-${testId}`,
    joinToken: `jt-${testId}-${letter}`,
  });
}

function mkPlayer(gameId: string, teamId: string, nick: string) {
  return repo.createPlayer({
    gameId,
    teamId,
    nickname: `${nick}-${testId}`,
    sessionToken: `st-${testId}-${nick}`,
  });
}

describe.skipIf(!DB_OK)("PrismaRepo (postgres)", () => {
  it("create game — config JSON round-trips, code lookup works", async () => {
    await withGame(async (gameId) => {
      const fetched = await repo.getGame(gameId);
      expect(fetched).not.toBeNull();
      expect(fetched!.phase).toBe("LOBBY");
      expect(fetched!.round).toBe(1);
      expect(fetched!.config).toEqual(DEFAULT_CARD_CONFIG);
      expect((await repo.getGameByCode((await repo.getGame(gameId))!.code))!.id).toBe(gameId);
      expect(await repo.getGame("missing-id")).toBeNull();
    });
  });

  it("duplicate game code throws RepoError (P2002 mapped)", async () => {
    await withGame(async (gameId) => {
      const code = (await repo.getGame(gameId))!.code;
      await expect(repo.createGame({ config: DEFAULT_CARD_CONFIG, code })).rejects.toThrow(RepoError);
    });
  });

  it("updateGame patches phase/round/theme/timers", async () => {
    await withGame(async (gameId) => {
      const updated = await repo.updateGame(gameId, {
        phase: "BUILD",
        theme: "Dog birthday",
        phaseEndsAt: 1234,
      });
      expect(updated.phase).toBe("BUILD");
      expect(updated.theme).toBe("Dog birthday");
      expect(updated.phaseEndsAt).toBe(1234);
      const cleared = await repo.updateGame(gameId, { phaseEndsAt: null });
      expect(cleared.phaseEndsAt).toBeNull();
    });
  });

  it("teams + players: unique label/joinToken, nickname rules, soft kick", async () => {
    await withGame(async (gameId) => {
      const teamA = await mkTeam(gameId, "A");
      const teamB = await mkTeam(gameId, "B");

      await expect(
        repo.createTeam({ gameId, name: "X", label: `A-${testId}`, joinToken: `jt-${testId}-c` }),
      ).rejects.toThrow(RepoError);
      await expect(
        repo.createTeam({ gameId, name: "X", label: `C-${testId}`, joinToken: `jt-${testId}-A` }),
      ).rejects.toThrow(RepoError); // joinToken collision with team A

      expect((await repo.getTeamByJoinToken(`jt-${testId}-B`))!.id).toBe(teamB.id);
      expect((await repo.listTeams(gameId)).map((t) => t.id).sort()).toEqual(
        [teamA.id, teamB.id].sort(),
      );

      const player = await mkPlayer(gameId, teamA.id, "Alex");
      expect(player.removedAt).toBeNull();
      expect((await repo.getPlayerBySessionToken(`st-${testId}-Alex`))!.id).toBe(player.id);

      await expect(mkPlayer(gameId, teamA.id, "Alex")).rejects.toThrow(RepoError);
      const suffixed = await repo.createPlayer({
        gameId,
        teamId: teamA.id,
        nickname: `Alex-${testId}`,
        sessionToken: `st-${testId}-Alex2`,
        autoSuffix: true,
      });
      expect(suffixed.nickname).toBe(`Alex-${testId} 2`);
      expect(await repo.findNicknames(gameId)).toEqual([`Alex-${testId}`, `Alex-${testId} 2`]);

      await repo.setPlayerConnected(player.id, true);
      expect((await repo.getPlayerBySessionToken(`st-${testId}-Alex`))!.connected).toBe(true);

      const kickAt = 1_700_000_000_000;
      const kicked = await repo.kickPlayer(player.id, kickAt);
      expect(kicked.removedAt).toBe(kickAt);
      // Row survives the soft kick.
      expect(await repo.getPlayerBySessionToken(`st-${testId}-Alex`)).not.toBeNull();
      // Nickname stays reserved even after kick (DB unique [gameId, nickname]).
      await expect(
        repo.createPlayer({
          gameId,
          teamId: teamA.id,
          nickname: `Alex-${testId}`,
          sessionToken: `st-${testId}-Alex3`,
        }),
      ).rejects.toThrow(RepoError);
    });
  });

  it("items: create/update/status filter + duplicate prompt rejection", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");
      const player = await mkPlayer(gameId, team.id, "Sam");
      const item = await repo.createItem({
        teamId: team.id,
        playerId: player.id,
        round: 1,
        promptRaw: "space cat",
        subject: "cat",
      });
      expect(item.status).toBe("PENDING");
      await expect(
        repo.createItem({ teamId: team.id, playerId: player.id, round: 1, promptRaw: "space cat" }),
      ).rejects.toThrow(RepoError);

      await repo.updateItem(item.id, {
        status: "READY",
        imageUrl: "http://x/y.png",
        width: 100,
        height: 140,
        placedAt: 5,
      });
      const [ready] = await repo.listItems(team.id, 1, ["READY"]);
      expect(ready!.imageUrl).toBe("http://x/y.png");
      expect(ready!.placedAt).toBe(5);
      expect(await repo.listItems(team.id, 1, ["GENERATING"])).toHaveLength(0);
    });
  });

  it("scores: upsert overwrite, lock refusal, aggregate math", async () => {
    await withGame(async (gameId) => {
      const teamA = await mkTeam(gameId, "A");
      const teamB = await mkTeam(gameId, "B");
      const voters: string[] = [];
      for (let i = 0; i < 4; i++) {
        voters.push((await mkPlayer(gameId, teamB.id, `V${i}`)).id);
      }
      const seed = [10, 7, 7, 1];
      for (let i = 0; i < seed.length; i++) {
        await repo.upsertScore({
          gameId,
          round: 1,
          voterPlayerId: voters[i]!,
          voterTeamId: teamB.id,
          targetTeamId: teamA.id,
          value: seed[i]!,
        });
      }
      // Overwrite one score (same voter+target+round) — row count stays 4.
      await repo.upsertScore({
        gameId,
        round: 1,
        voterPlayerId: voters[0]!,
        voterTeamId: teamB.id,
        targetTeamId: teamA.id,
        value: 4,
      });
      expect(await repo.listScores(gameId, 1, teamA.id)).toHaveLength(4);

      // [4, 7, 7, 1] → count 4, avg 4.75, distribution[0]=1, [3]=1, [6]=2.
      const agg = (await repo.aggregateScores(gameId, 1)).find((a) => a.targetTeamId === teamA.id)!;
      expect(agg.count).toBe(4);
      expect(agg.avg).toBeCloseTo(4.75, 10);
      expect(agg.distribution).toEqual([1, 0, 0, 1, 0, 0, 2, 0, 0, 0]);

      // Lock then refuse further writes.
      await repo.upsertScore({
        gameId,
        round: 1,
        voterPlayerId: voters[0]!,
        voterTeamId: teamB.id,
        targetTeamId: teamA.id,
        value: 4,
        locked: true,
      });
      await expect(
        repo.upsertScore({
          gameId,
          round: 1,
          voterPlayerId: voters[0]!,
          voterTeamId: teamB.id,
          targetTeamId: teamA.id,
          value: 2,
        }),
      ).rejects.toThrow(RepoError);

      // Same voter may score the other team in the same round → 2 aggregates.
      await repo.upsertScore({
        gameId,
        round: 1,
        voterPlayerId: voters[0]!,
        voterTeamId: teamB.id,
        targetTeamId: teamB.id,
        value: 5,
      });
      expect(await repo.aggregateScores(gameId, 1)).toHaveLength(2);
    });
  });

  it("greetings + winner picks: unique constraints per round", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");
      await repo.createGreeting({ teamId: team.id, round: 1, text: "Happy birthday!" });
      await expect(
        repo.createGreeting({ teamId: team.id, round: 1, text: "dup" }),
      ).rejects.toThrow(RepoError);
      await repo.updateGreeting(team.id, 1, { status: "approved" });
      expect((await repo.listGreetings(gameId, 1))[0]!.status).toBe("approved");

      await repo.insertWinnerPick({ gameId, round: 1, teamId: team.id, role: "GM_WINNER" });
      await expect(
        repo.insertWinnerPick({ gameId, round: 1, teamId: team.id, role: "GM_WINNER" }),
      ).rejects.toThrow(RepoError);
      expect(await repo.listWinnerPicks(gameId, 1)).toHaveLength(1);
    });
  });

  it("layout state: upsert + get per team+round", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");
      const placements = [{ itemId: "i1", x: 100, y: 200, scale: 1.5, rotation: 12, zIndex: 3 }];
      await repo.upsertLayoutState(team.id, 1, { version: 1, placements, source: "solver" });
      await repo.upsertLayoutState(team.id, 1, {
        version: 2,
        placements,
        greetingStyle: { align: "center", y: 800 },
        source: "manual",
      });
      const layout = await repo.getLayoutState(team.id, 1);
      expect(layout!.version).toBe(2);
      expect(layout!.source).toBe("manual");
      expect(layout!.placements).toEqual(placements);
      expect(layout!.greetingStyle).toEqual({ align: "center", y: 800 });
    });
  });

  it("ai calls: insert + per-task cost summary, no cross-game leakage", async () => {
    await withGame(async (gameId) => {
      await repo.insertAiCall({ gameId, task: "validate", model: "m1", status: "OK", latencyMs: 100, costUsd: 0.01 });
      await repo.insertAiCall({ gameId, task: "validate", model: "m1", status: "FALLBACK_OK", latencyMs: 300, costUsd: 0.02, fallbackUsed: true });
      await repo.insertAiCall({ gameId, task: "generate", model: "m2", status: "ERROR", latencyMs: 50, costUsd: 0.005, error: "boom" });
      const other = await repo.createGame({
        config: DEFAULT_CARD_CONFIG,
        code: `t${testId}${Math.random().toString(36).slice(2, 8)}`,
      });
      await repo.insertAiCall({ gameId: other.id, task: "validate", model: "m1", status: "OK", latencyMs: 1, costUsd: 9.99 });
      await cleanupGame(other.id);

      const summary = await repo.listAiCalls(gameId);
      expect(summary.rows).toHaveLength(3);
      expect(summary.totalCostUsd).toBeCloseTo(0.035, 6);
      const validate = summary.perTask.find((t) => t.task === "validate")!;
      expect(validate.count).toBe(2);
      expect(validate.avgLatencyMs).toBe(200);
      expect(validate.totalCostUsd).toBeCloseTo(0.03, 6);
      expect(validate.fallbackCount).toBe(1);
      const generate = summary.perTask.find((t) => t.task === "generate")!;
      expect(generate.errorCount).toBe(1);
      expect(summary.perTask).toHaveLength(2);
    });
  });
});