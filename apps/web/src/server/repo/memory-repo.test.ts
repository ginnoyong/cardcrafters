import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import {
  generateGameCode,
  MemoryRepo,
  nicknameCandidates,
  RepoError,
} from "./memory-repo";

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

describe("games", () => {
  it("create / get / getByCode round-trip", async () => {
    const { repo, game } = await mkGame();
    expect(await repo.getGame(game.id)).toEqual(game);
    expect(await repo.getGameByCode(game.code)).toEqual(game);
    expect(await repo.getGame("nope")).toBeNull();
    expect(await repo.getGameByCode("NOPE")).toBeNull();
  });

  it("generated codes are 6 chars from the unambiguous alphabet", async () => {
    expect(generateGameCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("duplicate game codes throw", async () => {
    const repo = new MemoryRepo();
    await repo.createGame({ config: DEFAULT_CARD_CONFIG, code: "ABC123" });
    await expect(repo.createGame({ config: DEFAULT_CARD_CONFIG, code: "ABC123" })).rejects.toThrow(
      RepoError,
    );
  });
});

describe("teams", () => {
  it("create, list (ordered by label), getByJoinToken", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    const teams = await repo.listTeams(game.id);
    expect(teams.map((t) => t.label)).toEqual(["Team A", "Team B"]);
    expect(await repo.getTeamByJoinToken(teamA.joinToken)).toEqual(teamA);
    expect(await repo.getTeamByJoinToken(teamB.joinToken)).toEqual(teamB);
    expect(await repo.getTeamByJoinToken("missing")).toBeNull();
  });

  it("duplicate gameId+label throws; other games may reuse the label", async () => {
    const { repo, game, teamA } = await mkGame();
    await expect(
      repo.createTeam({ gameId: game.id, name: "X", label: "Team A", joinToken: uniq("j") }),
    ).rejects.toThrow(RepoError);
    const other = await repo.createGame({ config: DEFAULT_CARD_CONFIG });
    const t = await repo.createTeam({
      gameId: other.id,
      name: "Crew A",
      label: "Team A",
      joinToken: uniq("j"),
    });
    expect(t.label).toBe("Team A");
    void teamA;
  });

  it("joinToken collisions throw across games", async () => {
    const { repo, game } = await mkGame();
    const other = await repo.createGame({ config: DEFAULT_CARD_CONFIG });
    const token = uniq("j");
    await repo.createTeam({ gameId: other.id, name: "X", label: "T", joinToken: token });
    await expect(
      repo.createTeam({ gameId: game.id, name: "Y", label: "T2", joinToken: token }),
    ).rejects.toThrow(RepoError);
  });

  it("updateTeam renames; duplicate label on update throws", async () => {
    const { repo, teamA, teamB } = await mkGame();
    await expect(repo.updateTeam(teamB.id, { label: "Team A" })).rejects.toThrow(RepoError);
    const updated = await repo.updateTeam(teamB.id, { label: "Team Z", name: "Zed" });
    expect(updated.label).toBe("Team Z");
    expect(updated.name).toBe("Zed");
    void teamA;
  });
});

describe("players", () => {
  it("create, getBySessionToken, presence, soft-kick leaves the row", async () => {
    const { repo, game, teamA } = await mkGame();
    const player = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
    });
    expect(player.removedAt).toBeNull();
    expect(await repo.getPlayerBySessionToken(player.sessionToken)).toEqual(player);

    await repo.setPlayerConnected(player.id, true);
    expect((await repo.getPlayerBySessionToken(player.sessionToken))?.connected).toBe(true);

    const kickAt = 123_456;
    const kicked = await repo.kickPlayer(player.id, kickAt);
    expect(kicked.removedAt).toBe(kickAt);
    expect(kicked.connected).toBe(false);
    // Soft delete: the row survives.
    expect(await repo.getPlayerBySessionToken(player.sessionToken)).toEqual(kicked);
    expect(await repo.findNicknames(game.id)).toContain("Alex");
  });

  it("duplicate gameId+nickname throws; nicknames are per-game scoped", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
    });
    await expect(
      repo.createPlayer({ gameId: game.id, teamId: teamA.id, nickname: "Alex", sessionToken: uniq("sess") }),
    ).rejects.toThrow(RepoError);
    // Same nickname in a different game is fine.
    const other = await repo.createGame({ config: DEFAULT_CARD_CONFIG });
    const otherTeam = await repo.createTeam({
      gameId: other.id,
      name: "N",
      label: "L",
      joinToken: uniq("j"),
    });
    const p = await repo.createPlayer({
      gameId: other.id,
      teamId: otherTeam.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
    });
    expect(p.nickname).toBe("Alex");
  });

  it("autoSuffix yields Alex, Alex 2, Alex 3 ...", async () => {
    const { repo, game, teamA } = await mkGame();
    const a1 = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
      autoSuffix: true,
    });
    const a2 = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
      autoSuffix: true,
    });
    const a3 = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
      autoSuffix: true,
    });
    expect([a1.nickname, a2.nickname, a3.nickname]).toEqual(["Alex", "Alex 2", "Alex 3"]);
    expect(await repo.findNicknames(game.id)).toEqual(["Alex", "Alex 2", "Alex 3"]);
  });

  it("autoSuffix skips gaps (if 'Alex 2' exists, next is 'Alex 3')", async () => {
    const { repo, game, teamA } = await mkGame();
    await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
    });
    await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex 2",
      sessionToken: uniq("sess"),
    });
    const next = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
      autoSuffix: true,
    });
    expect(next.nickname).toBe("Alex 3");
  });

  it("duplicate sessionToken throws", async () => {
    const { repo, game, teamA } = await mkGame();
    const token = uniq("sess");
    await repo.createPlayer({ gameId: game.id, teamId: teamA.id, nickname: "A", sessionToken: token });
    await expect(
      repo.createPlayer({ gameId: game.id, teamId: teamA.id, nickname: "B", sessionToken: token }),
    ).rejects.toThrow(RepoError);
  });

  it("nicknameCandidates helper", () => {
    const candidates = nicknameCandidates("Alex");
    expect(candidates.slice(0, 3)).toEqual(["Alex", "Alex 2", "Alex 3"]);
    expect(candidates.length).toBe(99); // base + 98 numbered suffixes
  });
});

describe("greetings — round-scoped isolation", () => {
  it("one greeting per team+round; rounds stay isolated", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    await repo.createGreeting({ teamId: teamA.id, round: 1, text: "Happy birthday!" });
    await repo.createGreeting({ teamId: teamB.id, round: 1, text: "Congrats!" });

    // Round 2 writes must not disturb round 1.
    await repo.createGreeting({ teamId: teamA.id, round: 2, text: "Round two!" });
    const round1 = await repo.listGreetings(game.id, 1);
    expect(round1).toHaveLength(2);
    expect(round1.find((g) => g.teamId === teamA.id)?.text).toBe("Happy birthday!");

    await repo.updateGreeting(teamA.id, 2, { status: "approved" });
    const stillRound1 = await repo.listGreetings(game.id, 1);
    expect(stillRound1.every((g) => g.status === "proposed")).toBe(true);
    expect(stillRound1.find((g) => g.teamId === teamA.id)?.text).toBe("Happy birthday!");

    // Duplicate teamId+round throws.
    await expect(
      repo.createGreeting({ teamId: teamA.id, round: 1, text: "dup" }),
    ).rejects.toThrow(RepoError);

    // Round 2 state is independent of round 1.
    const round2 = await repo.listGreetings(game.id, 2);
    expect(round2).toHaveLength(1);
    expect(round2[0]!.status).toBe("approved");
  });
});

describe("items", () => {
  it("create / update / list with status filter and round isolation", async () => {
    const { repo, game, teamA } = await mkGame();
    const player = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Sam",
      sessionToken: uniq("sess"),
    });
    const item = await repo.createItem({
      teamId: teamA.id,
      playerId: player.id,
      round: 1,
      promptRaw: "space cat",
      subject: "cat",
    });
    expect(item.status).toBe("PENDING");

    // Round 2 write; round 1 intact afterwards.
    await repo.createItem({
      teamId: teamA.id,
      playerId: player.id,
      round: 2,
      promptRaw: "space cat",
      subject: "cat",
    }); // same prompt, different round → allowed
    const round1 = await repo.listItems(teamA.id, 1);
    expect(round1).toHaveLength(1);
    expect(round1[0]!.id).toBe(item.id);

    // Exact duplicate (same team+round+prompt+player) throws.
    await expect(
      repo.createItem({
        teamId: teamA.id,
        playerId: player.id,
        round: 1,
        promptRaw: "space cat",
      }),
    ).rejects.toThrow(RepoError);

    await repo.updateItem(item.id, { status: "READY", imageUrl: "http://x/y.png", width: 100, height: 140 });
    const readyOnly = await repo.listItems(teamA.id, 1, ["READY"]);
    expect(readyOnly).toHaveLength(1);
    expect((await repo.listItems(teamA.id, 1, ["GENERATING"]))).toHaveLength(0);
  });
});

describe("layout state", () => {
  it("upsert + get, version last-write-wins, stale writes rejected", async () => {
    const { repo, teamA } = await mkGame();
    const placements = [{ itemId: "i1", x: 100, y: 200, scale: 1, rotation: 0, zIndex: 0 }];
    const v1 = await repo.upsertLayoutState(teamA.id, 1, {
      version: 1,
      placements,
      source: "solver",
    });
    expect(v1.version).toBe(1);
    const v2 = await repo.upsertLayoutState(teamA.id, 1, {
      version: 2,
      placements: [],
      greetingStyle: { align: "center" },
      source: "manual",
    });
    expect(v2.version).toBe(2);
    expect((await repo.getLayoutState(teamA.id, 1))?.greetingStyle).toEqual({ align: "center" });
    await expect(
      repo.upsertLayoutState(teamA.id, 1, { version: 1, placements: [], source: "manual" }),
    ).rejects.toThrow(RepoError);
  });

  it("critique round-trips: persist a verdict → getLayoutState returns it intact", async () => {
    const { repo, teamA } = await mkGame();
    const verdict = { score: 72, issues: ["hero slightly low"], focalOk: true };
    await repo.upsertLayoutState(teamA.id, 1, {
      version: 1,
      placements: [{ itemId: "i1", x: 100, y: 200, scale: 1, rotation: 0, zIndex: 0 }],
      critique: verdict,
      source: "solver",
    });
    expect((await repo.getLayoutState(teamA.id, 1))!.critique).toEqual(verdict);
  });

  it("critique-less patch PRESERVES an existing critique (placements/source still update)", async () => {
    const { repo, teamA } = await mkGame();
    const verdict = { score: 55, issues: [], focalOk: false };
    await repo.upsertLayoutState(teamA.id, 1, {
      version: 1,
      placements: [{ itemId: "i1", x: 1, y: 2, scale: 1, rotation: 0, zIndex: 0 }],
      critique: verdict,
      source: "solver",
    });
    // The layout engine's normal writes never carry a critique — they must
    // not wipe the persisted verdict.
    const v2 = await repo.upsertLayoutState(teamA.id, 1, {
      version: 2,
      placements: [{ itemId: "i2", x: 300, y: 400, scale: 1.5, rotation: 90, zIndex: 1 }],
      greetingStyle: { align: "center" },
      source: "manual",
    });
    expect(v2.version).toBe(2);
    expect(v2.critique).toEqual(verdict);
    expect(v2.placements).toEqual([
      { itemId: "i2", x: 300, y: 400, scale: 1.5, rotation: 90, zIndex: 1 },
    ]);
    expect(v2.source).toBe("manual");
    expect((await repo.getLayoutState(teamA.id, 1))!.critique).toEqual(verdict);
  });

  it("default critique is null when never written", async () => {
    const { repo, teamA } = await mkGame();
    await repo.upsertLayoutState(teamA.id, 1, {
      version: 1,
      placements: [],
      source: "solver",
    });
    expect((await repo.getLayoutState(teamA.id, 1))!.critique).toBeNull();
  });

  it("equal-version upsert is ACCEPTED — the critique write path relies on it", async () => {
    const { repo, teamA } = await mkGame();
    const placements = [{ itemId: "i1", x: 100, y: 200, scale: 1, rotation: 0, zIndex: 0 }];
    await repo.upsertLayoutState(teamA.id, 1, { version: 1, placements, source: "solver" });
    // fire() re-writes with the SAME version it just read (no bump) to attach
    // the verdict — this must not trip the stale-write gate.
    const verdict = { score: 80, issues: [], focalOk: true };
    const same = await repo.upsertLayoutState(teamA.id, 1, {
      version: 1,
      placements,
      critique: verdict,
      source: "solver",
    });
    expect(same.version).toBe(1);
    expect(same.critique).toEqual(verdict);
    expect((await repo.getLayoutState(teamA.id, 1))!.critique).toEqual(verdict);
  });
});

describe("scores — upsert, lock, aggregation", () => {
  it("round-scoped isolation, overwrite semantics, locked refusal", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    const voter1 = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "V1",
      sessionToken: uniq("sess"),
    });

    await repo.upsertScore({
      gameId: game.id,
      round: 1,
      voterPlayerId: voter1.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
      value: 8,
    });
    // Overwrite (same voter+target+round) — not a duplicate row.
    await repo.upsertScore({
      gameId: game.id,
      round: 1,
      voterPlayerId: voter1.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
      value: 3,
    });
    expect(await repo.listScores(game.id, 1, teamB.id)).toHaveLength(1);
    expect((await repo.listScores(game.id, 1, teamB.id))[0]!.value).toBe(3);

    // Round 2 write leaves round 1 untouched.
    await repo.upsertScore({
      gameId: game.id,
      round: 2,
      voterPlayerId: voter1.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
      value: 10,
    });
    expect((await repo.listScores(game.id, 1, teamB.id))[0]!.value).toBe(3);
    expect(await repo.listScores(game.id, 2)).toHaveLength(1);

    // Lock then refuse further writes.
    await repo.upsertScore({
      gameId: game.id,
      round: 1,
      voterPlayerId: voter1.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
      value: 3,
      locked: true,
    });
    await expect(
      repo.upsertScore({
        gameId: game.id,
        round: 1,
        voterPlayerId: voter1.id,
        voterTeamId: teamA.id,
        targetTeamId: teamB.id,
        value: 9,
      }),
    ).rejects.toThrow(RepoError);
  });

  it("aggregate math: avg + distribution over a known fixture", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    // Fixture: teamA receives [10, 7, 7, 1] → count 4, avg 6.25,
    // distribution[0]=1, distribution[6]=2, distribution[9]=1.
    const voters = ["v1", "v2", "v3", "v4"];
    const values = [10, 7, 7, 1];
    for (let i = 0; i < values.length; i++) {
      const voter = await repo.createPlayer({
        gameId: game.id,
        teamId: teamB.id,
        nickname: `Voter${i}`,
        sessionToken: uniq("sess"),
      });
      await repo.upsertScore({
        gameId: game.id,
        round: 1,
        voterPlayerId: voter.id,
        voterTeamId: teamB.id,
        targetTeamId: teamA.id,
        value: values[i]!,
      });
    }
    const aggregates = await repo.aggregateScores(game.id, 1);
    expect(aggregates).toHaveLength(1);
    const agg = aggregates[0]!;
    expect(agg.targetTeamId).toBe(teamA.id);
    expect(agg.count).toBe(4);
    expect(agg.avg).toBeCloseTo(6.25, 10);
    expect(agg.distribution).toEqual([1, 0, 0, 0, 0, 0, 2, 0, 0, 1]);
  });
});

describe("winner picks", () => {
  it("insert + list; duplicate gameId+round+role throws", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    await repo.insertWinnerPick({ gameId: game.id, round: 1, teamId: teamA.id, role: "GM_WINNER" });
    await repo.insertWinnerPick({
      gameId: game.id,
      round: 1,
      teamId: teamB.id,
      role: "PEOPLES_CHOICE",
    });
    expect(await repo.listWinnerPicks(game.id, 1)).toHaveLength(2);
    expect(await repo.listWinnerPicks(game.id, 2)).toHaveLength(0);
    await expect(
      repo.insertWinnerPick({ gameId: game.id, round: 1, teamId: teamB.id, role: "GM_WINNER" }),
    ).rejects.toThrow(RepoError);
  });
});

describe("ai calls — per-task stats + total cost", () => {
  it("aggregates per task and totals cost", async () => {
    const { repo, game } = await mkGame();
    await repo.insertAiCall({ gameId: game.id, task: "validate", model: "m1", status: "OK", latencyMs: 100, costUsd: 0.01 });
    await repo.insertAiCall({ gameId: game.id, task: "validate", model: "m1", status: "FALLBACK_OK", latencyMs: 300, costUsd: 0.02, fallbackUsed: true });
    await repo.insertAiCall({ gameId: game.id, task: "generate", model: "m2", status: "ERROR", latencyMs: 50, costUsd: 0.005, error: "boom" });
    await repo.insertAiCall({ gameId: null, task: "validate", model: "m1", status: "OK", latencyMs: 10 });

    const summary = await repo.listAiCalls(game.id);
    expect(summary.rows).toHaveLength(3);
    expect(summary.totalCostUsd).toBeCloseTo(0.035, 6);
    const validate = summary.perTask.find((t) => t.task === "validate")!;
    expect(validate.count).toBe(2);
    expect(validate.avgLatencyMs).toBe(200);
    expect(validate.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(validate.fallbackCount).toBe(1);
    expect(validate.errorCount).toBe(0);
    const generate = summary.perTask.find((t) => t.task === "generate")!;
    expect(generate.count).toBe(1);
    expect(generate.errorCount).toBe(1);
    expect(generate.avgLatencyMs).toBe(50);
    expect(summary.perTask).toHaveLength(2);
  });
});
// ---------------------------------------------------------------------------
// Step-5 review backfill: lock isolation, getPlayer, capacity counting,
// aggregate corruption guards.
// ---------------------------------------------------------------------------

describe("scores — lockScores/areScoresLocked round isolation", () => {
  it("locking round 1 does not touch round 2; writes follow the lock", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    const voter = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "V",
      sessionToken: uniq("sess"),
    });
    const base = {
      gameId: game.id,
      voterPlayerId: voter.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
    };
    await repo.upsertScore({ ...base, round: 1, value: 5 });
    await repo.upsertScore({ ...base, round: 2, value: 6 });

    expect(await repo.areScoresLocked(game.id, 1)).toBe(false);
    expect(await repo.areScoresLocked(game.id, 2)).toBe(false);

    const locked = await repo.lockScores(game.id, 1);
    expect(locked).toBe(1); // only round 1's row

    expect(await repo.areScoresLocked(game.id, 1)).toBe(true);
    expect(await repo.areScoresLocked(game.id, 2)).toBe(false);
    expect((await repo.listScores(game.id, 1))[0]!.locked).toBe(true);
    expect((await repo.listScores(game.id, 2))[0]!.locked).toBe(false);

    // Round 1 writes refused (even overwrite), round 2 still writable.
    await expect(repo.upsertScore({ ...base, round: 1, value: 9 })).rejects.toThrow(RepoError);
    await repo.upsertScore({ ...base, round: 2, value: 9 });
    expect((await repo.listScores(game.id, 2))[0]!.value).toBe(9);
  });

  it("lockScores is idempotent and counts rows, locked or not", async () => {
    const { repo, game, teamA, teamB } = await mkGame();
    const voter = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "V",
      sessionToken: uniq("sess"),
    });
    await repo.upsertScore({
      gameId: game.id,
      round: 1,
      voterPlayerId: voter.id,
      voterTeamId: teamA.id,
      targetTeamId: teamB.id,
      value: 7,
    });
    expect(await repo.lockScores(game.id, 1)).toBe(1);
    // Idempotent: still 1 row, still locked, no duplicate.
    expect(await repo.lockScores(game.id, 1)).toBe(1);
    expect(await repo.listScores(game.id, 1)).toHaveLength(1);
    expect(await repo.areScoresLocked(game.id, 1)).toBe(true);
  });
});

describe("players — getPlayer + countTeamMembers", () => {
  it("getPlayer returns the row (or null for unknown ids)", async () => {
    const { repo, game, teamA } = await mkGame();
    const player = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Alex",
      sessionToken: uniq("sess"),
    });
    const fetched = await repo.getPlayer(player.id);
    expect(fetched).toEqual(player);
    expect(await repo.getPlayer("missing-id")).toBeNull();
  });

  it("countTeamMembers excludes soft-removed players", async () => {
    const { repo, game, teamA } = await mkGame();
    const keep = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Keep",
      sessionToken: uniq("sess"),
    });
    const gone = await repo.createPlayer({
      gameId: game.id,
      teamId: teamA.id,
      nickname: "Gone",
      sessionToken: uniq("sess"),
    });
    expect(await repo.countTeamMembers(teamA.id)).toBe(2);
    await repo.kickPlayer(gone.id, 1000);
    expect(await repo.countTeamMembers(teamA.id)).toBe(1);
    expect((await repo.listTeamPlayers(teamA.id)).map((p) => p.nickname)).toEqual(["Keep"]);
    void keep;
  });
});

describe("aggregateScores — corruption guards", () => {
  it.each([0, 11, 3.5, "abc"])(
    "throws RepoError on a corrupt value (%s) instead of poisoning buckets",
    async (bad) => {
      const { repo, game, teamA, teamB } = await mkGame();
      const voter = await repo.createPlayer({
        gameId: game.id,
        teamId: teamA.id,
        nickname: "V",
        sessionToken: uniq("sess"),
      });
      await repo.upsertScore({
        gameId: game.id,
        round: 1,
        voterPlayerId: voter.id,
        voterTeamId: teamA.id,
        targetTeamId: teamB.id,
        value: bad as unknown as number, // upsert trusts upstream validation
      });
      await expect(repo.aggregateScores(game.id, 1)).rejects.toThrow(RepoError);
      // Other rounds/games are unaffected by the corrupt row's isolation.
      expect(await repo.aggregateScores(game.id, 2)).toEqual([]);
    },
  );
});
