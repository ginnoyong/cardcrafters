/**
 * Bug (a) regression probe — "Your stickers" chip stuck at "drawing…" even
 * though the sticker rendered on the canvas (item:ready WAS emitted).
 * Reproduces the full real flow: submit ack → itemPending echo → itemReady.
 */
import { describe, expect, it } from "vitest";

import { selectMyItems } from "../components/player/my-items";
import { normalizeSyncFull, storeReducer, type GameSnapshot, type SyncFullEvent } from "./store";

const TEAM_A = "team-a";
const PLAYER_ME = "player-me";

function baseSnapshot(overrides: Partial<SyncFullEvent> = {}): SyncFullEvent {
  return {
    gameId: "g1",
    phase: "BUILD",
    round: 1,
    theme: "Test theme",
    phaseEndsAt: null,
    cutoffAt: null,
    scoresLocked: false,
    serverNow: 1000,
    teams: [
      {
        id: TEAM_A,
        name: "Team A",
        label: "A",
        memberCount: 1,
        members: [{ id: PLAYER_ME, nickname: "Me", connected: true }],
        itemCount: 0,
        greeting: { text: "Hello!", status: "proposed" },
        items: [],
        layout: null,
        activity: [],
      },
    ],
    myItems: {},
    myPlayerId: PLAYER_ME,
    ...overrides,
  };
}

function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gameId: "g1", round: 1, ts: 2000, seq: 1, ...extra };
}

function generatingRowSnapshot(itemId: string, prompt: string): SyncFullEvent {
  return baseSnapshot({
    teams: [
      {
        id: TEAM_A,
        name: "Team A",
        label: "A",
        memberCount: 1,
        members: [{ id: PLAYER_ME, nickname: "Me", connected: true }],
        itemCount: 1,
        greeting: { text: "", status: null },
        items: [
          {
            id: itemId,
            promptRaw: prompt,
            nickname: "Me",
            playerId: PLAYER_ME,
            status: "GENERATING",
          } as unknown as never,
        ],
        layout: null,
        activity: [],
      },
    ],
  });
}

describe("bug (a): chip must go placed after itemReady", () => {
  it("submit ack → itemPending → itemReady → selectMyItems shows ready", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);

    // 1) Submit ack ok → owner ledger registration.
    s = storeReducer(s, { type: "mySubmitted", itemId: "i1", promptRaw: "red balloon" });
    expect(s!.myItems["i1"]!.status).toBe("pending");

    // 2) Team-wide item:pending echo (real payload carries the submitter id).
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i1",
        promptRaw: "red balloon",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    expect(s!.myItems["i1"]!.status).toBe("pending");

    // 3) item:ready from the worker (real payload shape: no playerId).
    s = storeReducer(s, {
      type: "itemReady",
      payload: envelope({
        itemId: "i1",
        imageUrl: "/static/items/i1.png",
        width: 256,
        height: 256,
        teamId: TEAM_A,
      }),
    });

    const row = s!.teams.find((t) => t.id === TEAM_A)!.items[0]!;
    expect(row.status).toBe("ready");
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i1", status: "ready" });
    expect(s!.myItems["i1"]!.status).toBe("ready");
  });

  it("variant: itemReady arrives while the ledger entry is missing but the row is attributed (echo lost)", () => {
    // Item row only enters team.items via a SYNC FULL with playerId (echo lost).
    const snap = generatingRowSnapshot("i2", "cat");
    const s0 = normalizeSyncFull(snap, {}, PLAYER_ME);
    const s = storeReducer(s0, {
      type: "itemReady",
      payload: envelope({
        itemId: "i2",
        imageUrl: "/static/items/i2.png",
        width: 100,
        height: 100,
        teamId: TEAM_A,
      }),
    });
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i2", status: "ready" });
  });

  it("variant: resync (sync:full) BETWEEN submit and ready keeps the ledger, then itemReady still applies", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, { type: "mySubmitted", itemId: "i3", promptRaw: "dog" });
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i3",
        promptRaw: "dog",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    // Resync while GENERATING: row pending + ledger pending, round preserved.
    s = normalizeSyncFull(generatingRowSnapshot("i3", "dog"), s!.myItems, PLAYER_ME);
    expect(s!.myItems["i3"]!.status).toBe("pending");

    s = storeReducer(s, {
      type: "itemReady",
      payload: envelope({
        itemId: "i3",
        imageUrl: "/static/items/i3.png",
        width: 100,
        height: 100,
        teamId: TEAM_A,
      }),
    });
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine[0]).toMatchObject({ id: "i3", status: "ready" });
  });

  it("variant: a stale PENDING ledger must never beat a READY row in selectMyItems", () => {
    const snap = baseSnapshot({
      teams: [
        {
          id: TEAM_A,
          name: "Team A",
          label: "A",
          memberCount: 1,
          members: [{ id: PLAYER_ME, nickname: "Me", connected: true }],
          itemCount: 1,
          greeting: { text: "", status: null },
          items: [
            {
              id: "i4",
              promptRaw: "cat",
              nickname: "Me",
              playerId: PLAYER_ME,
              status: "READY",
              imageUrl: "/static/items/i4.png",
              width: 100,
              height: 100,
            } as unknown as never,
          ],
          layout: null,
          activity: [],
        },
      ],
    });
    // A stale pending ledger entry (e.g. the ready echo was lost mid-flight).
    const prev = { i4: { promptRaw: "cat", status: "pending" as const, round: 1 } };
    const s = normalizeSyncFull(snap, prev, PLAYER_ME);
    const mine = selectMyItems(s, TEAM_A, PLAYER_ME);
    expect(mine[0]).toMatchObject({ id: "i4", status: "ready" });
  });
});
// ---------------------------------------------------------------------------
// Bug (a) round-2 variant — after gm:newRound the client snapshot.round used
// to stay 1 (phaseChangedSchema stripped `round`), so roundGuard dropped every
// round-2 item:pending/item:ready/layout:updated → chips stuck "drawing…"
// forever and stale round-2 layouts eventually leaked onto the round-1 card.
// ---------------------------------------------------------------------------

describe("bug (a) round-2: phaseChanged must advance the round so build events apply", () => {
  it("round-1 card → phaseChanged{round:2} → item:pending/item:ready/layout all apply", () => {
    // Round 1 finished state: a placed item + a committed layout + history.
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, { type: "mySubmitted", itemId: "r1", promptRaw: "old cat" });
    s = storeReducer(s, {
      type: "itemReady",
      payload: envelope({
        itemId: "r1",
        imageUrl: "/static/items/r1.png",
        width: 100,
        height: 100,
        teamId: TEAM_A,
      }),
    });
    s = storeReducer(s, {
      type: "layoutUpdated",
      payload: envelope({
        teamId: TEAM_A,
        version: 3,
        placements: [{ itemId: "r1", x: 10, y: 10, scale: 1, rotation: 0, zIndex: 0 }],
        source: "solver",
      }),
    });
    expect(s!.round).toBe(1);
    expect(s!.teams[0]!.layout).not.toBeNull();

    // gm:newRound → GREETINGS, round 2. The payload carries round on the
    // envelope (what the real hub stamps).
    s = storeReducer(s, {
      type: "phaseChanged",
      payload: envelope({ phase: "GREETINGS", round: 2, serverNow: 3000 }),
    });
    expect(s!.round).toBe(2);
    // Round-scoped state is cleared for the fresh card (invariant: the card
    // is rebuilt per round — items/layout/activity never carry over); the
    // teams[] structure (members/greeting) persists.
    expect(s!.teams[0]!.items).toEqual([]);
    expect(s!.teams[0]!.layout).toBeNull();
    expect(s!.teams[0]!.activity).toEqual([]);
    expect(s!.myItems["r1"]).toBeUndefined();

    // Round-2 build events (previously ALL dropped by roundGuard).
    const env2 = (extra: Record<string, unknown>): Record<string, unknown> => ({
      gameId: "g1", round: 2, ts: 4000, seq: 9, ...extra,
    });
    s = storeReducer(s, {
      type: "itemPending",
      payload: env2({
        itemId: "r2",
        promptRaw: "new dog",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    expect(s!.teams[0]!.items.map((i) => i.id)).toContain("r2");
    expect(s!.myItems["r2"]!.status).toBe("pending");
    expect(s!.myItems["r2"]!.round).toBe(2);

    s = storeReducer(s, {
      type: "itemReady",
      payload: env2({
        itemId: "r2",
        imageUrl: "/static/items/r2.png",
        width: 256,
        height: 256,
        teamId: TEAM_A,
      }),
    });
    // Chip must be READY ("drawing…" resolved) and the canvas row present.
    const row = s!.teams[0]!.items.find((i) => i.id === "r2")!;
    expect(row.status).toBe("ready");
    expect(row.imageUrl).toBe("/static/items/r2.png");
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine[0]).toMatchObject({ id: "r2", status: "ready" });

    s = storeReducer(s, {
      type: "layoutUpdated",
      payload: env2({
        teamId: TEAM_A,
        version: 1,
        placements: [{ itemId: "r2", x: 50, y: 60, scale: 1.2, rotation: 5, zIndex: 1 }],
        source: "solver",
      }),
    });
    expect(s!.teams[0]!.layout!.version).toBe(1);
    expect(s!.teams[0]!.layout!.placements.map((p) => p.itemId)).toEqual(["r2"]);
  });

  it("non-bump phase change with a stale/absent round does not clear state", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemReady",
      payload: envelope({
        itemId: "x1",
        imageUrl: "/static/items/x1.png",
        width: 100,
        height: 100,
        teamId: TEAM_A,
      }),
    });
    // Same round (1): only phase/timers change — items survive.
    s = storeReducer(s, {
      type: "phaseChanged",
      payload: envelope({ phase: "BUILD", serverNow: 5000 }),
    });
    expect(s!.round).toBe(1);
    expect(s!.teams[0]!.items).toHaveLength(1);
    // Payload without a round field at all: untouched round, untouched state.
    s = storeReducer(s, {
      type: "phaseChanged",
      payload: { phase: "SCORING", serverNow: 6000 },
    });
    expect(s!.round).toBe(1);
    expect(s!.teams[0]!.items).toHaveLength(1);
  });
});
