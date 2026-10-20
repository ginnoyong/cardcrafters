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
  await prisma.montageState.deleteMany({ where: { team: { gameId } } });
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

  it("duplicate sessionToken throws RepoError (fails fast, NOT auto-suffixed)", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "A");
      const sharedToken = `st-${testId}-dup`;
      await repo.createPlayer({
        gameId,
        teamId: team.id,
        nickname: `Alpha-${testId}`,
        sessionToken: sharedToken,
      });
      // Same sessionToken, different nickname → the sessionToken unique
      // constraint must reject the second row (session identity is 1:1).
      await expect(
        repo.createPlayer({
          gameId,
          teamId: team.id,
          nickname: `Beta-${testId}`,
          sessionToken: sharedToken,
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
        contentBox: { x: 10, y: 20, w: 60, h: 80 },
      });
      const [ready] = await repo.listItems(team.id, 1, ["READY"]);
      expect(ready!.imageUrl).toBe("http://x/y.png");
      expect(ready!.placedAt).toBe(5);
      expect(ready!.contentBox).toEqual({ x: 10, y: 20, w: 60, h: 80 });
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

      // Round-level lock: lockScores(gameId, round) freezes ALL writes of the
      // round — new rows and overwrites alike.
      expect(await repo.areScoresLocked(gameId, 1)).toBe(false);
      const lockedCount = await repo.lockScores(gameId, 1);
      expect(lockedCount).toBe(5); // 4 teamA scores + 1 teamB score
      expect(await repo.areScoresLocked(gameId, 1)).toBe(true);
      await expect(
        repo.upsertScore({
          gameId,
          round: 1,
          voterPlayerId: voters[0]!,
          voterTeamId: teamB.id,
          targetTeamId: teamA.id,
          value: 2,
        }),
      ).rejects.toThrow(/scores_locked/);
      await expect(
        repo.upsertScore({
          gameId,
          round: 1,
          voterPlayerId: voters[1]!,
          voterTeamId: teamB.id,
          targetTeamId: teamB.id,
          value: 9,
        }),
      ).rejects.toThrow(/scores_locked/);
      // Round 2 stays writable (lock is round-scoped).
      expect(await repo.areScoresLocked(gameId, 2)).toBe(false);
      await repo.upsertScore({
        gameId,
        round: 2,
        voterPlayerId: voters[1]!,
        voterTeamId: teamB.id,
        targetTeamId: teamA.id,
        value: 9,
      });
      expect(await repo.listScores(gameId, 2)).toHaveLength(1);
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

  it("layout state: stale version rejected, equal idempotent, newer ok (memory-repo parity)", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");
      const placements = [{ itemId: "i1", x: 1, y: 2, scale: 1, rotation: 0, zIndex: 0 }];
      await repo.upsertLayoutState(team.id, 1, { version: 5, placements, source: "solver" });

      // STALE: version < current → RepoError (the engine relies on the throw,
      // same contract as memory-repo), and the stored row is untouched.
      await expect(
        repo.upsertLayoutState(team.id, 1, { version: 4, placements, source: "stale" }),
      ).rejects.toThrow(/stale layout write: version 4 < current 5/);
      const afterStale = await repo.getLayoutState(team.id, 1);
      expect(afterStale!.version).toBe(5);
      expect(afterStale!.source).toBe("solver");

      // EQUAL: idempotent upsert (same version may re-commit its layout).
      const equalPlacements = [{ itemId: "i2", x: 9, y: 9, scale: 1, rotation: 0, zIndex: 1 }];
      const eq = await repo.upsertLayoutState(team.id, 1, {
        version: 5,
        placements: equalPlacements,
        source: "manual",
      });
      expect(eq.version).toBe(5);
      expect(eq.placements).toEqual(equalPlacements);
      expect(eq.source).toBe("manual");

      // NEWER: writes through.
      const newer = await repo.upsertLayoutState(team.id, 1, {
        version: 6,
        placements,
        source: "solver",
      });
      expect(newer.version).toBe(6);
      expect((await repo.getLayoutState(team.id, 1))!.version).toBe(6);
    });
  });

  it("layout state: critique round-trips + preservation (critique persistence D3, memory-repo parity)", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");
      const placements = [{ itemId: "i1", x: 100, y: 200, scale: 1, rotation: 0, zIndex: 0 }];

      // DEFAULT: no critique ever written → null (never undefined/garbage).
      await repo.upsertLayoutState(team.id, 1, { version: 1, placements, source: "solver" });
      expect((await repo.getLayoutState(team.id, 1))!.critique).toBeNull();

      // ROUND-TRIP: a verdict persists and reads back intact (jsonb column).
      const verdict = { score: 72, issues: ["hero slightly low"], focalOk: true };
      await repo.upsertLayoutState(team.id, 1, {
        version: 1,
        placements,
        critique: verdict,
        source: "solver",
      });
      expect((await repo.getLayoutState(team.id, 1))!.critique).toEqual(verdict);

      // PRESERVATION: a critique-less patch (the layout engine's normal write
      // shape) keeps the persisted verdict while placements/source update.
      const v2Placements = [{ itemId: "i2", x: 9, y: 9, scale: 1.5, rotation: 0, zIndex: 1 }];
      const v2 = await repo.upsertLayoutState(team.id, 1, {
        version: 2,
        placements: v2Placements,
        source: "manual",
      });
      expect(v2.critique).toEqual(verdict);
      expect(v2.placements).toEqual(v2Placements);
      expect(v2.source).toBe("manual");

      // EQUAL-VERSION: accepted (the critique write path re-writes with the
      // SAME version fire() read — no bump — to attach the verdict).
      const same = await repo.upsertLayoutState(team.id, 1, {
        version: 2,
        placements: v2Placements,
        critique: verdict,
        source: "manual",
      });
      expect(same.version).toBe(2);
      expect(same.critique).toEqual(verdict);
      expect((await repo.getLayoutState(team.id, 1))!.critique).toEqual(verdict);
    });
  });

  it("montage state: upsert with input/patch lastError round-trip + null defaults (memory-repo parity)", async () => {
    await withGame(async (gameId) => {
      const team = await mkTeam(gameId, "T");

      // No row before anything is staged.
      expect(await repo.getMontageState(team.id, 1)).toBeNull();

      // Input append #1: seq increments, defaults are null/false.
      const r1 = await repo.upsertMontageState(team.id, 1, {
        input: {
          itemId: "i1",
          promptRaw: "red balloon",
          subject: "red balloon",
          playerId: "p1",
          nickname: "Alex",
          seq: 1,
        },
      });
      expect(r1.seq).toBe(1);
      expect(r1.stagedInputs).toHaveLength(1);
      expect(r1.status).toBe("STAGED");
      expect(r1.promptText).toBeNull();
      expect(r1.imageUrl).toBeNull();
      expect(r1.imageSeq).toBeNull();
      expect(r1.fallbackUsed).toBe(false);
      expect(r1.lastError).toBeNull();

      // Input append #2 (hop 2): seq grows, both entries survive the JSON column.
      const r2 = await repo.upsertMontageState(team.id, 1, {
        input: {
          itemId: "i2",
          promptRaw: "blue cake",
          subject: "blue cake",
          playerId: "p2",
          nickname: "Sam",
          seq: 2,
        },
      });
      expect(r2.seq).toBe(2);
      expect(r2.stagedInputs.map((i) => i.subject)).toEqual(["red balloon", "blue cake"]);

      // Patch to READY: every column round-trips through the patch interface.
      await repo.upsertMontageState(team.id, 1, {
        patch: {
          status: "READY",
          promptText: "poster prompt text",
          imageUrl: "/static/montages/g/t/poster.png",
          imageSeq: 2,
          lastError: null,
          fallbackUsed: false,
        },
      });
      const ready = await repo.getMontageState(team.id, 1);
      expect(ready).toMatchObject({
        status: "READY",
        promptText: "poster prompt text",
        imageUrl: "/static/montages/g/t/poster.png",
        imageSeq: 2,
        lastError: null,
        fallbackUsed: false,
        seq: 2,
      });
      // A patch never clobbers the staged inputs.
      expect(ready?.stagedInputs).toHaveLength(2);

      // Patch to FALLBACK with lastError set (the gen-pass failure path).
      await repo.upsertMontageState(team.id, 1, {
        patch: {
          status: "FALLBACK",
          fallbackUsed: true,
          imageUrl: null,
          lastError: "image provider outage",
        },
      });
      const fallback = await repo.getMontageState(team.id, 1);
      expect(fallback?.status).toBe("FALLBACK");
      expect(fallback?.lastError).toBe("image provider outage");
      expect(fallback?.fallbackUsed).toBe(true);
      expect(fallback?.imageUrl).toBeNull();
      // promptText from the READY patch survives the fallback patch.
      expect(fallback?.promptText).toBe("poster prompt text");

      // A successful retry clears lastError via an explicit null patch.
      await repo.upsertMontageState(team.id, 1, {
        patch: { status: "READY", lastError: null, fallbackUsed: false },
      });
      const cleared = await repo.getMontageState(team.id, 1);
      expect(cleared?.lastError).toBeNull();
      expect(cleared?.fallbackUsed).toBe(false);

      // listMontageStates joins through teams (game+round scope).
      const listed = await repo.listMontageStates(gameId, 1);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.teamId).toBe(team.id);
      expect(listed[0]!.stagedInputs).toHaveLength(2);

      // Round isolation: a new round starts from nothing.
      const r2round = await repo.upsertMontageState(team.id, 2, {
        input: {
          itemId: "i3",
          promptRaw: "green kite",
          subject: "green kite",
          playerId: "p3",
          nickname: "Ari",
          seq: 1,
        },
      });
      expect(r2round.seq).toBe(1);
      expect(r2round.stagedInputs).toHaveLength(1);
      expect((await repo.getMontageState(team.id, 1))?.stagedInputs).toHaveLength(2);
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
