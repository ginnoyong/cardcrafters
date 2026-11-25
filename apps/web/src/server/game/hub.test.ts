/**
 * GameHub tests — in-memory repo + a recording RoomEmitter fake.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG, MAX_TEAM_MEMBERS, PHASE } from "@cardcrafters/shared";

import { MemoryRepo, RepoError } from "../repo/memory-repo";
import { GameHub, TEAM_NAME_POOL, type RoomEmitter } from "./hub";

const NOW = 1_700_000_000_000;

interface Sent {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

function fakeIo(): { io: RoomEmitter; sent: Sent[] } {
  const sent: Sent[] = [];
  const io: RoomEmitter = {
    to(room: string) {
      return {
        emit(event: string, ...args: unknown[]) {
          sent.push({ room, event, payload: args[0] as Record<string, unknown> });
        },
      };
    },
  };
  return { io, sent };
}

function makeHub() {
  const repo = new MemoryRepo();
  const { io, sent } = fakeIo();
  const hub = new GameHub(repo, io, { now: () => NOW });
  return { repo, hub, sent };
}

/** PhaseChanged emit for the game room, if any. */
function phaseChangedOf(sent: Sent[]) {
  return sent.filter((s) => s.event === "phaseChanged" && s.room === `game:${s.payload.gameId}`);
}

describe("createGame", () => {
  it("creates N teams with labels A,B,C, unique joinTokens and fun unique names", async () => {
    const { hub } = makeHub();
    const setup = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 3 });

    expect(setup.teams).toHaveLength(3);
    expect(setup.teams.map((t) => t.label)).toEqual(["A", "B", "C"]);

    const tokens = new Set(setup.teams.map((t) => t.joinToken));
    expect(tokens.size).toBe(3);

    const names = setup.teams.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(TEAM_NAME_POOL).toContain(name);

    // defaults applied
    expect(setup.game.config).toEqual(DEFAULT_CARD_CONFIG);
    expect(setup.game.phase).toBe(PHASE.LOBBY);
  });

  it("never exceeds MAX_TEAMS even for silly inputs", async () => {
    const { hub } = makeHub();
    const setup = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 99 });
    expect(setup.teams.length).toBeLessThanOrEqual(10);
  });
});

describe("player join flow", () => {
  it("creates a player with a session token and auto-suffixes duplicate nicknames", async () => {
    const { hub } = makeHub();
    const { teams, game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    const first = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
    expect(first.isNewPlayer).toBe(true);
    expect(first.player.nickname).toBe("Alex");
    expect(first.player.sessionToken).toMatch(/[0-9a-f-]{36}/);
    expect(first.player.connected).toBe(true);
    expect(first.player.teamId).toBe(teams[0]!.id);
    expect(first.game.id).toBe(game.id);

    const second = await hub.joinPlayer({ joinToken: teams[1]!.joinToken, nickname: "Alex" });
    expect(second.player.nickname).toBe("Alex 2");
  });

  it("rejects an invalid joinToken", async () => {
    const { hub } = makeHub();
    await expect(hub.joinPlayer({ joinToken: "nope", nickname: "Alex" })).rejects.toThrow(RepoError);
  });

  it("rejects the 13th player on a team", async () => {
    const { hub } = makeHub();
    const { teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });

    for (let i = 1; i <= MAX_TEAM_MEMBERS; i++) {
      await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: `P${i}` });
    }
    await expect(
      hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Onemore" }),
    ).rejects.toThrow(/full/);
  });

  it("rejects brand-new players in BUILD (allowed in LOBBY/GREETINGS)", async () => {
    const { hub } = makeHub();
    const { teams, game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Birthday", now: NOW });

    // GREETINGS: players may still trickle in while the GM prepares greetings.
    const inGreetings = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Early" });
    expect(inGreetings.isNewPlayer).toBe(true);

    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    await expect(
      hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Late" }),
    ).rejects.toThrow(RepoError);
  });

  it("a session from team A + team B's joinToken → NEW player in team B, old player untouched (link is authoritative)", async () => {
    const { hub, repo } = makeHub();
    const { teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    // Player joins team A (gets a session token).
    const inA = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
    expect(inA.player.teamId).toBe(teams[0]!.id);

    // Same session, but the URL points at team B's link → fresh join in B.
    const inB = await hub.joinPlayer({
      joinToken: teams[1]!.joinToken,
      sessionToken: inA.player.sessionToken,
      nickname: "Alex",
    });
    expect(inB.isNewPlayer).toBe(true);
    expect(inB.player.teamId).toBe(teams[1]!.id);
    expect(inB.player.id).not.toBe(inA.player.id);
    expect(inB.player.nickname).toBe("Alex 2");

    // The old player row is NOT deleted/removed (they may be live elsewhere).
    const oldRow = await repo.getPlayer(inA.player.id);
    expect(oldRow).not.toBeNull();
    expect(oldRow!.removedAt).toBeNull();
    expect(oldRow!.teamId).toBe(teams[0]!.id);
    expect(oldRow!.sessionToken).toBe(inA.player.sessionToken);
  });

  it("a session + the SAME team's joinToken → same-player rejoin (no new row)", async () => {
    const { hub, repo } = makeHub();
    const { teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    const first = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
    const rejoin = await hub.joinPlayer({
      joinToken: teams[0]!.joinToken,
      sessionToken: first.player.sessionToken,
      nickname: "Alex",
    });
    expect(rejoin.isNewPlayer).toBe(false);
    expect(rejoin.player.id).toBe(first.player.id);
    expect(rejoin.player.nickname).toBe("Alex");
    expect(rejoin.team.id).toBe(teams[0]!.id);
    // Only one player row for this session.
    const members = await repo.listTeamPlayers(teams[0]!.id);
    expect(members.filter((p) => p.nickname === "Alex")).toHaveLength(1);
  });

  it("a stale session + link + NO nickname is refused (client shows the form, no placeholder row)", async () => {
    const { hub, repo } = makeHub();
    const { teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const inA = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });

    // Mount-time auto attempt: session + link, no nickname → refused.
    await expect(
      hub.joinPlayer({
        joinToken: teams[1]!.joinToken,
        sessionToken: inA.player.sessionToken,
      }),
    ).rejects.toThrow(/stale session/);
    await expect(
      hub.joinPlayer({ joinToken: teams[1]!.joinToken }), // unresolvable session-less too
    ).rejects.toThrow(/stale session|nickname/);
    // Nothing was created in team B by the nickname-less attempts.
    expect(await repo.countTeamMembers(teams[1]!.id)).toBe(0);
  });
});

describe("applyEvent", () => {
  it("gm:setTheme → GREETINGS, persisted, phaseChanged emitted to the game room", async () => {
    const { hub, repo, sent } = makeHub();
    const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    const result = await hub.applyEvent(game.id, { type: "gm:setTheme", theme: " Birthday ", now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.phase).toBe(PHASE.GREETINGS);
      expect(result.state.theme).toBe(" Birthday ");
    }

    // Emitted to the game room with the standard envelope.
    const emits = phaseChangedOf(sent);
    expect(emits).toHaveLength(1);
    expect(emits[0]!.payload).toMatchObject({
      phase: PHASE.GREETINGS,
      theme: " Birthday ",
      gameId: game.id,
      round: 1,
      ts: NOW,
      seq: 1,
      serverNow: NOW,
    });

    // Persisted.
    const row = await repo.getGame(game.id);
    expect(row?.phase).toBe(PHASE.GREETINGS);
    expect(row?.theme).toBe(" Birthday ");
  });

  it("illegal events are rejected and NOT persisted", async () => {
    const { hub, repo, sent } = makeHub();
    const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    const result = await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("GREETINGS") });

    const row = await repo.getGame(game.id);
    expect(row?.phase).toBe(PHASE.LOBBY);
    expect(row?.theme).toBeNull();
    expect(sent).toHaveLength(0); // nothing emitted either
  });

  it("timed phase transitions arm the timer and persist phaseEndsAt", async () => {
    const { hub, repo } = makeHub();
    const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Birthday", now: NOW });
    const result = await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });

    expect(result.ok).toBe(true);
    expect(hub.timers.isArmed(game.id)).toBe(true);
    expect(hub.timers.armedFor(game.id)?.endsAt).toBe(NOW + (DEFAULT_CARD_CONFIG.buildTimerSeconds ?? 0) * 1000);

    const row = await repo.getGame(game.id);
    expect(row?.phase).toBe(PHASE.BUILD);
    expect(row?.phaseEndsAt).toBe(NOW + (DEFAULT_CARD_CONFIG.buildTimerSeconds ?? 0) * 1000);

    hub.shutdown();
  });

  it("seq increments monotonically across emits within a game", async () => {
    const { hub, sent } = makeHub();
    const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "A", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });

    // phaseChanged on setTheme, then phaseChanged on approveGreetings
    // (startTimer is a TimerService side-effect, not a socket emit).
    const seqs = sent.map((s) => s.payload.seq as number);
    expect(seqs).toEqual([1, 2]);
  });

  it("player:submitPrompt guard refuses prompts before a theme exists", async () => {
    const { hub } = makeHub();
    const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
    const result = await hub.applyEvent(game.id, {
      type: "player:submitPrompt",
      playerId: "p1",
      text: "cat in a hat",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "before_theme" });
  });
});

describe("capacity + persistence", () => {
  it("rejects the 13th player even when rows were inserted directly via the repo", async () => {
    const { hub, repo } = makeHub();
    const { teams, game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });

    // Fill the team to capacity WITHOUT going through hub.joinPlayer —
    // capacity must be counted from the Repository, not from hub caches.
    for (let i = 1; i <= MAX_TEAM_MEMBERS; i++) {
      await repo.createPlayer({
        gameId: game.id,
        teamId: teams[0]!.id,
        nickname: `P${i}`,
        sessionToken: `st-${game.id}-${i}`,
      });
    }
    expect(await repo.countTeamMembers(teams[0]!.id)).toBe(MAX_TEAM_MEMBERS);

    await expect(
      hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Onemore" }),
    ).rejects.toThrow(/full/);
  });

  it("winner pick survives a full hub restart (hydrate from repo)", async () => {
    const { repo, hub } = makeHub();
    const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const winnerId = teams[1]!.id;

    // Drive the full round: LOBBY→GREETINGS→BUILD→SCORING→JUDGING→REVEAL.
    const events = [
      { type: "gm:setTheme", theme: "Underwater bakery", now: NOW },
      { type: "gm:approveGreetings", now: NOW },
      { type: "gm:stopBuild", now: NOW },
      { type: "gm:stopScoring", now: NOW },
      { type: "gm:pickWinner", teamId: winnerId, now: NOW },
    ] as const;
    let last;
    for (const event of events) {
      last = await hub.applyEvent(game.id, event);
      expect(last.ok).toBe(true);
    }
    if (!last?.ok) throw new Error("pickWinner should have succeeded");
    expect(last.state.phase).toBe("REVEAL");
    hub.shutdown(); // clear the armed BUILD/SCORING timers

    // A FRESH hub over the same repo restores the winner from WinnerPick rows.
    const revived = new GameHub(repo, fakeIo().io, { now: () => NOW });
    const state = await revived.hydrateGame(game.id);
    expect(state).not.toBeNull();
    expect(state!.phase).toBe("REVEAL");
    expect(state!.winnerTeamId).toBe(winnerId);
    expect(state!.scoresLocked).toBe(true);
    revived.shutdown();
  });

  it("stopScoring locks the round's score rows; further upsertScore throws 'scores_locked'", async () => {
    const { repo, hub } = makeHub();
    const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });

    const voter = await repo.createPlayer({
      gameId: game.id,
      teamId: teams[0]!.id,
      nickname: "Voter",
      sessionToken: `st-${game.id}-voter`,
    });
    await repo.upsertScore({
      gameId: game.id,
      round: 1,
      voterPlayerId: voter.id,
      voterTeamId: teams[0]!.id,
      targetTeamId: teams[1]!.id,
      value: 8,
    });

    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Space zoo", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:stopBuild", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:stopScoring", now: NOW });

    // Every score row of the round is locked at JUDGING entry.
    const rows = await repo.listScores(game.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locked).toBe(true);
    expect(await repo.areScoresLocked(game.id, 1)).toBe(true);

    // A further write for the locked round is refused by the repo.
    await expect(
      repo.upsertScore({
        gameId: game.id,
        round: 1,
        voterPlayerId: voter.id,
        voterTeamId: teams[0]!.id,
        targetTeamId: teams[1]!.id,
        value: 3,
      }),
    ).rejects.toThrow(/scores_locked/);

    hub.shutdown();
  });
});

// ---------------------------------------------------------------------------
// preScoring hook (final montage window) — montage:started heads-up + fail-open
// ---------------------------------------------------------------------------

describe("preScoring hook", () => {
  it("runs after the GM montage:started heads-up and BEFORE scoring:started; scoringOrder IS persisted inside the hook (hook now fires after public-card resolution)", async () => {
    const repo = new MemoryRepo();
    const { io, sent } = fakeIo();
    let markerRan = false;
    // Marker: capture (do NOT expect) the scoringOrder the hook observes — the
    // hub try/catches around the hook, so an in-hook assert would be swallowed.
    let scoringOrderInHook: unknown = "not-run";
    const hub = new GameHub(repo, io, {
      now: () => NOW,
      preScoring: async (gameId) => {
        markerRan = true;
        scoringOrderInHook = (await repo.getGame(gameId))?.scoringOrder ?? null;
      },
    });
    const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const gm = `game:${game.id}:gm`;

    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Space zoo", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:stopBuild", now: NOW });
    hub.shutdown(); // clear the armed SCORING timer

    // The hook ran and observed the PERSISTED scoringOrder: the hook moved
    // AFTER public-card resolution + persistence (hub comment) so the
    // scoring:started emit stays ahead of the finalize chain's
    // montage:generating (the ordering guarantee the ws-integration suite
    // asserts).
    expect(markerRan).toBe(true);
    const orderInHook = scoringOrderInHook as {
      round: number;
      cards: Array<{ cardId: string }>;
    } | null;
    expect(orderInHook).not.toBeNull();
    expect(orderInHook?.round).toBe(1);
    expect(orderInHook?.cards.length).toBeGreaterThan(0);

    // GM-room ordering: montage:started strictly before scoring:started.
    const gmEvents = sent.filter((s) => s.room === gm).map((s) => s.event);
    const montageAt = gmEvents.indexOf("montage:started");
    const scoringAt = gmEvents.indexOf("scoring:started");
    expect(montageAt).toBeGreaterThanOrEqual(0);
    expect(scoringAt).toBeGreaterThan(montageAt);

    // Scoring still began: the order persisted with one card per team.
    const order = (await repo.getGame(game.id))?.scoringOrder;
    expect(order).not.toBeNull();
    expect(order!.round).toBe(1);
    expect(order!.cards).toHaveLength(2);
    expect(order!.cards.map((c) => c.teamId).sort()).toEqual(teams.map((t) => t.id).sort());
  });

  it("a THROWING hook is fail-open: gm:stopBuild still succeeds and scoring starts", async () => {
    const repo = new MemoryRepo();
    const { io, sent } = fakeIo();
    const hub = new GameHub(repo, io, {
      now: () => NOW,
      preScoring: async () => {
        throw new Error("polish exploded");
      },
    });
    const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const gm = `game:${game.id}:gm`;

    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Space zoo", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    const stopped = await hub.applyEvent(game.id, { type: "gm:stopBuild", now: NOW });
    hub.shutdown(); // clear the armed SCORING timer

    expect(stopped.ok).toBe(true);
    expect((await repo.getGame(game.id))?.scoringOrder?.cards).toHaveLength(2);
    expect(sent.filter((s) => s.room === gm).map((s) => s.event)).toContain("scoring:started");
    expect(teams).toHaveLength(2);
  });

  it("no hook (default) — beginScoring behavior is unchanged by the new wiring", async () => {
    const { repo, hub, sent } = makeHub();
    const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
    const gm = `game:${game.id}:gm`;

    await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Space zoo", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: NOW });
    await hub.applyEvent(game.id, { type: "gm:stopBuild", now: NOW });
    hub.shutdown(); // clear the armed SCORING timer

    const order = (await repo.getGame(game.id))?.scoringOrder;
    expect(order?.cards).toHaveLength(2);
    expect(sent.filter((s) => s.room === gm).map((s) => s.event)).toContain("scoring:started");
    expect(teams).toHaveLength(2);
  });
});
