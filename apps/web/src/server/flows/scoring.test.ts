/**
 * Scoring flow tests — MemoryRepo + GameHub + fakeIo (the hub.test.ts
 * pattern). No sockets, no Postgres, no real providers.
 *
 * Contract under test:
 *  - submitScore guard order: phase → kicked → scoring order/card → own-card
 *    → duplicate → lock;
 *  - success broadcasts `scores:update` to the game room with ANONYMOUS cards
 *    only ({cardId, avg, count} — never teamId, avg 2dp);
 *  - pickPeoplesChoice tie-breaks: avg desc → count desc → label asc,
 *    count>0 only, null when nobody scored.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG, type CardConfig } from "@cardcrafters/shared";

import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { ScoreAggregate, TeamRow } from "../repo/repository";
import { pickPeoplesChoice, submitScore } from "./scoring";

/** Untimed config — no phase timers armed, nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

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

interface Setup {
  repo: MemoryRepo;
  hub: GameHub;
  sent: Sent[];
  gameId: string;
  teamIds: string[];
  /** One player per team, in team order. */
  playerIds: string[];
  /** cardId of team X's anonymous card, indexed by team order. */
  cardIds: string[];
}

/** Fresh game with 3 teams + one player each, driven into SCORING. */
async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const { io, sent } = fakeIo();
  const hub = new GameHub(repo, io, { now: () => NOW });
  const { game, teams } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 3 });
  const playerIds: string[] = [];
  for (const [i, team] of teams.entries()) {
    const joined = await hub.joinPlayer({
      joinToken: team.joinToken,
      nickname: `Player${i + 1}`,
    });
    playerIds.push(joined.player.id);
  }
  for (const event of [
    { type: "gm:setTheme", theme: "Space zoo", now: NOW },
    { type: "gm:approveGreetings", now: NOW },
    { type: "gm:stopBuild", now: NOW },
  ] as const) {
    const r = await hub.applyEvent(game.id, event);
    if (!r.ok) throw new Error(`${event.type} failed: ${r.reason}`);
  }
  const gameRow = await repo.getGame(game.id);
  if (!gameRow?.scoringOrder || gameRow.scoringOrder.round !== 1) {
    throw new Error("scoring order missing after stopBuild");
  }
  const cardIds = teams.map((team) => {
    const card = gameRow.scoringOrder!.cards.find((c) => c.teamId === team.id);
    if (!card) throw new Error(`no card for team ${team.id}`);
    return card.cardId;
  });
  return {
    repo,
    hub,
    sent,
    gameId: game.id,
    teamIds: teams.map((t) => t.id),
    playerIds,
    cardIds,
  };
}

/** All scores:update payloads (usually exactly one). */
function scoresUpdates(sent: Sent[]) {
  return sent.filter((s) => s.event === "scores:update");
}

describe("submitScore — happy path", () => {
  it("persists the score and broadcasts anonymous running averages", async () => {
    const s = await setup();
    s.sent.length = 0; // drop the setup emits (scoring:started etc.)

    const result = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 8 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score.targetTeamId).toBe(s.teamIds[1]);
      expect(result.score.value).toBe(8);
      expect(result.score.locked).toBe(false);
    }

    const updates = scoresUpdates(s.sent);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.room).toBe(`game:${s.gameId}`);
    const payload = updates[0]!.payload;
    // ANONYMITY: the broadcast carries only {cardId, avg, count} — the card↔
    // team mapping never leaves the server.
    expect(payload.cards).toEqual([{ cardId: s.cardIds[1]!, avg: 8, count: 1 }]);
    expect(JSON.stringify(payload)).not.toContain("teamId");
    expect(payload.gameId).toBe(s.gameId);
    expect(payload.seq).toBeGreaterThan(0);

    // A second voter on the same card → avg 8.5 (2dp), count 2.
    await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[2]!, cardId: s.cardIds[1]!, score: 9 },
    );
    const last = scoresUpdates(s.sent).at(-1)!.payload;
    expect(last.cards).toEqual([{ cardId: s.cardIds[1]!, avg: 8.5, count: 2 }]);
  });

  it("score rows keep voter + target in the repo (aggregation works)", async () => {
    const s = await setup();
    await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 7 },
    );
    const rows = await s.repo.listScores(s.gameId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.voterPlayerId).toBe(s.playerIds[0]);
    expect(rows[0]!.voterTeamId).toBe(s.teamIds[0]);
    expect(rows[0]!.targetTeamId).toBe(s.teamIds[1]);
    expect(rows[0]!.value).toBe(7);
  });
});

describe("submitScore — guards", () => {
  it("rejects submissions outside SCORING (phase guard, first in line)", async () => {
    const s = await setup();
    // Move to JUDGING: scores lock AND the phase guard refuses first.
    const r = await s.hub.applyEvent(s.gameId, { type: "gm:stopScoring", now: NOW });
    expect(r.ok).toBe(true);
    const result = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 5 },
    );
    expect(result).toEqual({
      ok: false,
      stage: "phase",
      error: expect.stringContaining("JUDGING"),
    });
    expect(await s.repo.listScores(s.gameId, 1)).toHaveLength(0);
  });

  it("rejects kicked players", async () => {
    const s = await setup();
    await s.hub.kickPlayer(s.playerIds[0]!);
    const result = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 5 },
    );
    expect(result).toEqual({ ok: false, stage: "kicked", error: expect.any(String) });
    expect(await s.repo.listScores(s.gameId, 1)).toHaveLength(0);
  });

  it("rejects unknown cardIds and stale/missing scoring orders", async () => {
    const s = await setup();
    const badCard = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: "card-z", score: 5 },
    );
    expect(badCard).toEqual({ ok: false, stage: "unknown_card", error: expect.any(String) });

    // Stale order: the stored order belongs to round 1 while the game is in
    // round 2 → nothing resolvable (no crash).
    const gameRow = await s.repo.getGame(s.gameId);
    await s.repo.updateGame(s.gameId, {
      scoringOrder: { round: 99, cards: gameRow!.scoringOrder!.cards },
    });
    const stale = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[0]!, score: 5 },
    );
    expect(stale).toEqual({ ok: false, stage: "unknown_card", error: expect.any(String) });
  });

  it("rejects rating your own card (own_card)", async () => {
    const s = await setup();
    const result = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[0]!, score: 10 },
    );
    expect(result).toEqual({ ok: false, stage: "own_card", error: expect.any(String) });
    expect(await s.repo.listScores(s.gameId, 1)).toHaveLength(0);
    expect(scoresUpdates(s.sent)).toHaveLength(0); // nothing broadcast either
  });

  it("rejects re-submission for the same card (already_rated), even with a different score", async () => {
    const s = await setup();
    const first = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 8 },
    );
    expect(first.ok).toBe(true);
    sentReset(s);
    const second = await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 3 },
    );
    expect(second).toEqual({ ok: false, stage: "already_rated", error: expect.any(String) });
    expect(scoresUpdates(s.sent)).toHaveLength(0);
    // The original value survived untouched.
    const rows = await s.repo.listScores(s.gameId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(8);
  });

  it("maps the repo's scores_locked error to stage 'locked'", async () => {
    const s = await setup();
    // Create one score row, then lock the round via the repo (as
    // gm:stopScoring's lockScores effect does) while a hub reporting SCORING
    // is used — the phase guard normally refuses before the lock, so this
    // pins the defensive branch with a DIFFERENT voter (no duplicate hit).
    await submitScore(
      { hub: s.hub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[0]!, cardId: s.cardIds[1]!, score: 8 },
    );
    await s.repo.lockScores(s.gameId, 1);
    const scoringHub = {
      runtimeState: async () => {
        const st = await s.hub.runtimeState(s.gameId);
        return { ...st, phase: "SCORING" as const };
      },
      isKicked: async () => false,
      emitScoresUpdate: async () => {},
    };
    const result = await submitScore(
      // Structural deps — a minimal hub facade is enough for this branch.
      { hub: scoringHub as unknown as GameHub, repo: s.repo },
      { gameId: s.gameId, playerId: s.playerIds[2]!, cardId: s.cardIds[1]!, score: 5 },
    );
    expect(result).toEqual({ ok: false, stage: "locked", error: expect.any(String) });
  });
});

function sentReset(s: Setup): void {
  s.sent.length = 0;
}

describe("pickPeoplesChoice", () => {
  const teams: TeamRow[] = [
    { id: "t-a", gameId: "g", name: "Team Papercraft", label: "A", joinToken: "jt-a" },
    { id: "t-b", gameId: "g", name: "The Glue Guns", label: "B", joinToken: "jt-b" },
    { id: "t-c", gameId: "g", name: "Ink & Imagination", label: "C", joinToken: "jt-c" },
  ];

  const agg = (targetTeamId: string, avg: number, count: number): ScoreAggregate => ({
    targetTeamId,
    avg,
    count,
    distribution: new Array<number>(10).fill(0),
  });

  it("picks the highest average", () => {
    const aggregates = [agg("t-a", 7.5, 2), agg("t-b", 9.1, 3), agg("t-c", 6, 1)];
    expect(pickPeoplesChoice(aggregates, teams)?.id).toBe("t-b");
  });

  it("equal averages → higher count wins", () => {
    const aggregates = [agg("t-a", 8, 1), agg("t-b", 8, 3)];
    expect(pickPeoplesChoice(aggregates, teams)?.id).toBe("t-b");
  });

  it("equal average AND count → lower label wins (deterministic tie-break)", () => {
    const aggregates = [agg("t-c", 8, 2), agg("t-a", 8, 2)];
    expect(pickPeoplesChoice(aggregates, teams)?.id).toBe("t-a");
  });

  it("ignores teams with zero scores and returns null when nobody scored", () => {
    expect(pickPeoplesChoice([agg("t-a", 8, 0), agg("t-b", 9, 0)], teams)).toBeNull();
    expect(pickPeoplesChoice([], teams)).toBeNull();
    const aggregates = [agg("t-a", 0, 0), agg("t-b", 6.5, 2)];
    expect(pickPeoplesChoice(aggregates, teams)?.id).toBe("t-b");
  });

  it("ignores aggregates for teams that are not in the game", () => {
    const aggregates = [agg("t-ghost", 10, 5), agg("t-a", 4, 1)];
    expect(pickPeoplesChoice(aggregates, teams)?.id).toBe("t-a");
  });
});