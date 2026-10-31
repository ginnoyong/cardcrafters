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

// ---------------------------------------------------------------------------
// Critique persistence (D3): the persisted verdict rides with the layout in
// the sync:full snapshot — GM ONLY. Players and the presenter never receive
// the critique detail (audience-scoped like the private item rows above).
// ---------------------------------------------------------------------------

interface SnapshotLayout {
  version: number;
  source: string;
  critique?: unknown;
}

describe("buildSyncFull — critique audience scoping (GM only)", () => {
  it("GM snapshot's layout carries the persisted critique; player/presenter snapshots omit it", async () => {
    const s = await setup();
    const verdict = { score: 66, issues: ["dead space at the bottom"], focalOk: true };
    // Seed exactly the way the critique scheduler persists (see
    // layout/critique.ts fire()): same version, verdict attached.
    await s.repo.upsertLayoutState(s.teamId, 1, {
      version: 1,
      placements: [{ itemId: "i1", x: 100, y: 200, scale: 1, rotation: 0, zIndex: 0 }],
      critique: verdict,
      source: "solver",
    });

    // GM: the definitive judging view — the verdict rides with the layout.
    const gm = await buildSyncFull(s.hub, s.repo, s.gameId, gmIdentity(s));
    expect(gm.teams[0]!.layout as SnapshotLayout | null).toMatchObject({
      version: 1,
      source: "solver",
      critique: verdict,
    });

    // Player: layout present but the critique detail is stripped (undefined —
    // not null, so the client reducer keeps a null-free "absent" semantics).
    const player = await buildSyncFull(s.hub, s.repo, s.gameId, playerIdentity(s));
    const playerLayout = player.teams[0]!.layout as SnapshotLayout | null;
    expect(playerLayout).not.toBeNull();
    expect(playerLayout!.version).toBe(1);
    expect(playerLayout!.critique).toBeUndefined();

    // Presenter: same fail-closed stripping as the player.
    const presenter = await buildSyncFull(s.hub, s.repo, s.gameId, presenterIdentity(s));
    const presenterLayout = presenter.teams[0]!.layout as SnapshotLayout | null;
    expect(presenterLayout).not.toBeNull();
    expect(presenterLayout!.critique).toBeUndefined();
  });

  it("a never-critiqued layout stays critique: null for the GM (default)", async () => {
    const s = await setup();
    await s.repo.upsertLayoutState(s.teamId, 1, {
      version: 1,
      placements: [],
      source: "solver",
    });
    const gm = await buildSyncFull(s.hub, s.repo, s.gameId, gmIdentity(s));
    expect(gm.teams[0]!.layout as SnapshotLayout | null).toMatchObject({
      version: 1,
      critique: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Montage promptText audience scoping: the persisted poster prompt rides the
// sync snapshot for the GM in every phase, and for the PRESENTER from JUDGING
// onward (the JUDGING big screen renders the shared TeamJudgeCard whose
// "View prompt" accordion reads montagePromptText). Players never receive it
// in a snapshot; lastError stays GM-only in every phase.
// ---------------------------------------------------------------------------

describe("buildSyncFull — montage promptText presenter visibility (JUDGING+)", () => {
  it("presenter snapshot in JUDGING carries montage.promptText; player never does", async () => {
    const s = await setup();
    await s.repo.upsertMontageState(s.teamId, 1, {
      patch: {
        status: "READY",
        imageUrl: "/static/montages/g1/t1/poster.png",
        promptText: "a glossy poster of a red balloon dog",
        lastError: "poster grading failed twice",
      },
    });

    // Pre-JUDGING (BUILD): the presenter's montage section stays lean —
    // status/imageUrl only, no promptText, no lastError.
    const before = await buildSyncFull(s.hub, s.repo, s.gameId, presenterIdentity(s));
    const beforeMontage = before.teams[0]!.montage as { promptText?: string; lastError?: string } | null;
    expect(beforeMontage).not.toBeNull();
    expect(beforeMontage!.promptText).toBeUndefined();
    expect(beforeMontage!.lastError).toBeUndefined();

    // Drive BUILD → SCORING → JUDGING.
    for (const event of [
      { type: "gm:stopBuild", now: 1_700_000_001_000 },
      { type: "gm:stopScoring", now: 1_700_000_002_000 },
    ] as const) {
      const result = await s.hub.applyEvent(s.gameId, event);
      expect(result.ok).toBe(true);
    }

    // Presenter from JUDGING onward: promptText rides the snapshot (the
    // TeamJudgeCard "View prompt" toggle reads it) — but lastError stays
    // GM-only.
    const presenter = await buildSyncFull(s.hub, s.repo, s.gameId, presenterIdentity(s));
    expect(presenter.phase).toBe("JUDGING");
    expect(presenter.teams[0]!.montage).toMatchObject({
      status: "ready",
      imageUrl: "/static/montages/g1/t1/poster.png",
      promptText: "a glossy poster of a red balloon dog",
    });
    expect((presenter.teams[0]!.montage as { lastError?: string }).lastError).toBeUndefined();

    // GM unchanged: promptText AND lastError both ride along.
    const gm = await buildSyncFull(s.hub, s.repo, s.gameId, gmIdentity(s));
    expect(gm.teams[0]!.montage).toMatchObject({
      promptText: "a glossy poster of a red balloon dog",
      lastError: "poster grading failed twice",
    });

    // Player: still lean in JUDGING (fail-closed for every non-GM/presenter
    // role).
    const player = await buildSyncFull(s.hub, s.repo, s.gameId, playerIdentity(s));
    const playerMontage = player.teams[0]!.montage as { promptText?: string } | null;
    expect(playerMontage).not.toBeNull();
    expect(playerMontage!.promptText).toBeUndefined();
  });
});
