/**
 * Snapshot privacy tests (build-phase review fix) — filterItemsForIdentity
 * and buildSyncFull against a MemoryRepo + GameHub fixture (the same pattern
 * as the flows tests: no Postgres, no sockets, no real provider).
 *
 * Contract under test: REJECTED / FAILED / REMOVED rows (and their
 * failReasons) are OWNER-ONLY intel — a player sees only their OWN private
 * rows, the presenter sees none, and the GM (moderation duty) sees all.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG, type CardConfig } from "@cardcrafters/shared";

import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { ItemRow } from "../repo/repository";
import type { WsIdentity } from "./rooms";
import { buildSyncFull, filterItemsForIdentity } from "./server";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

function fakeIo(): RoomEmitter {
  return { to: () => ({ emit() {} }) };
}

interface Setup {
  repo: MemoryRepo;
  hub: GameHub;
  gameId: string;
  gameCode: string;
  teamId: string;
  playerAId: string;
  playerBId: string;
  sessionTokenA: string;
}

/** Fresh game at BUILD with two players (Alex + Blake) on one team. */
async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const hub = new GameHub(repo, fakeIo());
  const { game, teams } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 1 });
  const a = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
  const b = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Blake" });
  // Hydrate into BUILD so the snapshot's round/phase are meaningful.
  await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Birthday", now: 1_700_000_000_000 });
  await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: 1_700_000_000_000 });
  return {
    repo,
    hub,
    gameId: game.id,
    gameCode: game.code,
    teamId: a.team.id,
    playerAId: a.player.id,
    playerBId: b.player.id,
    sessionTokenA: a.player.sessionToken,
  };
}

/** One mixed-status item row per prompt (unique natural keys). */
async function seedMixedStatusRows(
  s: Setup,
): Promise<Record<"aReady" | "aRejected" | "bRejected" | "bFailed" | "bRemoved", ItemRow>> {
  const mk = async (playerId: string, promptRaw: string, status: ItemRow["status"]) => {
    const row = await s.repo.createItem({
      teamId: s.teamId,
      playerId,
      round: 1,
      promptRaw,
      status: "VALIDATING",
    });
    return s.repo.updateItem(row.id, { status });
  };
  return {
    aReady: await mk(s.playerAId, "a red balloon dog", "READY"),
    aRejected: await mk(s.playerAId, "happiness", "REJECTED"),
    bRejected: await mk(s.playerBId, "unsafe doodle", "REJECTED"),
    bFailed: await mk(s.playerBId, "glitched gremlin", "FAILED"),
    bRemoved: await mk(s.playerBId, "ephemeral eraser", "REMOVED"),
  };
}

function playerIdentity(s: Setup): WsIdentity {
  return {
    role: "player",
    gameId: s.gameId,
    code: s.gameCode,
    playerId: s.playerAId,
    teamId: s.teamId,
    nickname: "Alex",
    sessionToken: s.sessionTokenA,
  };
}

const gmIdentity = (s: Setup): WsIdentity => ({ role: "gm", gameId: s.gameId, code: s.gameCode });
const presenterIdentity = (s: Setup): WsIdentity => ({
  role: "presenter",
  gameId: s.gameId,
  code: s.gameCode,
});

const idsOf = (rows: ItemRow[]): string[] => rows.map((r) => r.id);

describe("filterItemsForIdentity (snapshot privacy)", () => {
  it("player sees their OWN private rows but never another player's", async () => {
    const s = await setup();
    const rows = Object.values(await seedMixedStatusRows(s));
    const visible = filterItemsForIdentity(rows, playerIdentity(s));
    const ids = idsOf(visible);
    expect(ids).toContain(rows.find((r) => r.promptRaw === "a red balloon dog")!.id); // own READY
    expect(ids).toContain(rows.find((r) => r.promptRaw === "happiness")!.id); // own REJECTED
    expect(ids).not.toContain(rows.find((r) => r.promptRaw === "unsafe doodle")!.id);
    expect(ids).not.toContain(rows.find((r) => r.promptRaw === "glitched gremlin")!.id);
    expect(ids).not.toContain(rows.find((r) => r.promptRaw === "ephemeral eraser")!.id);
  });

  it("GM sees ALL rows (moderation duty, incl. failReasons)", async () => {
    const s = await setup();
    const byStatus = await seedMixedStatusRows(s);
    const visible = filterItemsForIdentity(Object.values(byStatus), gmIdentity(s));
    expect(idsOf(visible).sort()).toEqual(
      expect.arrayContaining(Object.values(byStatus).map((r) => r.id)),
    );
    expect(visible).toHaveLength(5);
  });

  it("presenter (and unknown identities) see none of the private rows", async () => {
    const s = await setup();
    const byStatus = await seedMixedStatusRows(s);
    const visible = filterItemsForIdentity(Object.values(byStatus), presenterIdentity(s));
    expect(visible.map((r) => r.status)).toEqual(["READY"]);
    // No identity at all behaves like the presenter (fail-closed).
    expect(filterItemsForIdentity(Object.values(byStatus))).toHaveLength(1);
  });
});

describe("buildSyncFull — snapshot privacy integration", () => {
  it("team.items excludes another player's REJECTED row, includes my own; itemCount matches", async () => {
    const s = await setup();
    const byStatus = await seedMixedStatusRows(s);

    const snapshot = await buildSyncFull(s.hub, s.repo, s.gameId, playerIdentity(s));
    expect(snapshot.phase).toBe("BUILD");
    const team = snapshot.teams[0]!;
    const ids = (team.items as ItemRow[]).map((r) => r.id);

    // Own REJECTED row survives; the teammate's private rows are stripped.
    expect(ids).toContain(byStatus.aReady.id);
    expect(ids).toContain(byStatus.aRejected.id);
    expect(ids).not.toContain(byStatus.bRejected.id);
    expect(ids).not.toContain(byStatus.bFailed.id);
    expect(ids).not.toContain(byStatus.bRemoved.id);

    // The advertised usage count matches the filtered list (card capacity).
    expect(team.itemCount).toBe((team.items as ItemRow[]).length);
    expect(team.itemCount).toBe(2);

    // The GM's snapshot of the same game still shows everything…
    const gmSnapshot = await buildSyncFull(s.hub, s.repo, s.gameId, gmIdentity(s));
    expect((gmSnapshot.teams[0]!.items as ItemRow[])).toHaveLength(5);

    // …while the presenter's never sees the private rows.
    const presenterSnapshot = await buildSyncFull(s.hub, s.repo, s.gameId, presenterIdentity(s));
    expect((presenterSnapshot.teams[0]!.items as ItemRow[]).map((r) => r.id)).toEqual([
      byStatus.aReady.id,
    ]);
    expect(presenterSnapshot.teams[0]!.itemCount).toBe(1);
  });
});
