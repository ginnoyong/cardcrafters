/**
 * Unit tests for the client game store reducer (lib/store.tsx) — build-phase
 * item/layout event handling, owner ledger survival, version guards, and
 * activity-feed trimming.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_FEED_MAX,
  normalizeSyncFull,
  storeReducer,
  type GameSnapshot,
  type MyItemEvent,
  type SyncFullEvent,
} from "./store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_A = "team-a";
const TEAM_B = "team-b";
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
      {
        id: TEAM_B,
        name: "Team B",
        label: "B",
        memberCount: 0,
        members: [],
        itemCount: 0,
        greeting: { text: "", status: null },
        items: [],
        layout: null,
        activity: [],
      },
    ],
    myItems: {},
    ...overrides,
  };
}

function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gameId: "g1", round: 1, ts: 2000, seq: 1, ...extra };
}

// ---------------------------------------------------------------------------
// item lifecycle
// ---------------------------------------------------------------------------

describe("storeReducer — item lifecycle", () => {
  it("itemPending adds a pending item + activity entry; itemReady places it", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);

    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({ itemId: "i1", promptRaw: "red balloon", nickname: "Me", teamId: TEAM_A }),
    });
    const teamA = s!.teams.find((t) => t.id === TEAM_A)!;
    expect(teamA.items).toHaveLength(1);
    expect(teamA.items[0]).toMatchObject({ id: "i1", promptRaw: "red balloon", status: "pending" });
    expect(teamA.activity[0]).toMatchObject({ text: expect.stringContaining("red balloon") });

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
    const after = s!.teams.find((t) => t.id === TEAM_A)!;
    expect(after.items[0]!.status).toBe("ready");
    expect(after.items[0]!.imageUrl).toBe("/static/items/i1.png");
  });

  it("itemRejected goes to the owner ledger with exampleFix and marks the row", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({ itemId: "i2", promptRaw: "happiness", nickname: "Me", teamId: TEAM_A }),
    });
    s = storeReducer(s, {
      type: "mySubmitted",
      itemId: "i2",
      promptRaw: "happiness",
    });
    // Owner-only event: no teamId, no round guard helper — envelope still present.
    s = storeReducer(s, {
      type: "itemRejected",
      payload: envelope({
        itemId: "i2",
        reason: "'happiness' is a feeling.",
        exampleFix: "balloons bursting with confetti",
      }),
    });

    const teamA = s!.teams.find((t) => t.id === TEAM_A)!;
    expect(teamA.items[0]!.status).toBe("rejected");
    expect(teamA.items[0]!.reason).toContain("feeling");
    expect(s!.myItems["i2"]).toMatchObject({
      status: "rejected",
      exampleFix: "balloons bursting with confetti",
    });
  });

  it("owner ledger exampleFix survives a sync:full resync (prevMyItems + myPlayerId)", () => {
    const prevMyItems: Record<string, MyItemEvent> = {
      i2: { promptRaw: "happiness", status: "rejected", reason: "feeling", exampleFix: "confetti!" },
    };
    // Server rows do NOT carry exampleFix; the ledger must be merged in.
    const snapshot = baseSnapshot({
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
              id: "i2",
              promptRaw: "happiness",
              nickname: "Me",
              playerId: PLAYER_ME,
              status: "REJECTED", // server ItemStatus is UPPERCASE
              failReason: "feeling",
            } as unknown as never,
          ],
          layout: null,
          activity: [],
        },
        baseSnapshot().teams[1]!,
      ],
    });
    const s = normalizeSyncFull(snapshot, prevMyItems, PLAYER_ME);
    expect(s.myItems["i2"]).toMatchObject({ status: "rejected", exampleFix: "confetti!" });
    const row = s.teams[0]!.items[0]!;
    expect(row.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// layout version guard
// ---------------------------------------------------------------------------

const PLACEMENTS_V1 = [{ itemId: "i1", x: 500, y: 500, scale: 1, rotation: 0, zIndex: 0 }];
const PLACEMENTS_V2 = [
  { itemId: "i1", x: 300, y: 300, scale: 1.2, rotation: 10, zIndex: 0 },
  { itemId: "i2", x: 700, y: 700, scale: 1, rotation: 0, zIndex: 1 },
];

describe("storeReducer — layoutUpdated version guard", () => {
  function withLayout(v: number, placements = PLACEMENTS_V1): GameSnapshot | null {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_A, version: v, placements, source: "solver" }),
    });
    return s;
  }

  it("applies a newer version; ignores equal and older versions", () => {
    const v2 = withLayout(2, PLACEMENTS_V2)!;
    expect(v2.teams[0]!.layout!.version).toBe(2);
    expect(v2.teams[0]!.layout!.placements).toHaveLength(2);

    // Older than current (2) → ignored.
    const stale = storeReducer(v2, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_A, version: 1, placements: PLACEMENTS_V1, source: "solver" }),
    });
    expect(stale!.teams[0]!.layout!.version).toBe(2);

    // Equal → ignored (idempotent).
    const same = storeReducer(v2, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_A, version: 2, placements: PLACEMENTS_V1, source: "solver" }),
    });
    expect(same!.teams[0]!.layout!.placements).toHaveLength(2);
  });

  it("isolates per team (team B layout untouched)", () => {
    let s: GameSnapshot | null = withLayout(1);
    s = storeReducer(s, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_B, version: 5, placements: PLACEMENTS_V2, source: "solver" }),
    });
    expect(s!.teams.find((t) => t.id === TEAM_A)!.layout!.version).toBe(1);
    expect(s!.teams.find((t) => t.id === TEAM_B)!.layout!.version).toBe(5);
  });

  it("drops stale-round events entirely", () => {
    const s = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    const out = storeReducer(s, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_A, version: 9, placements: PLACEMENTS_V1, round: 2 }),
    });
    expect(out!.teams[0]!.layout).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// activity feed
// ---------------------------------------------------------------------------

describe("storeReducer — activity feed", () => {
  it("trims at ACTIVITY_FEED_MAX, newest first", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    for (let i = 0; i < ACTIVITY_FEED_MAX + 1; i++) {
      s = storeReducer(s, {
        type: "itemPending",
        payload: envelope({ itemId: `i${i}`, promptRaw: `p${i}`, nickname: "Me", teamId: TEAM_A }),
      });
    }
    const feed = s!.teams.find((t) => t.id === TEAM_A)!.activity;
    expect(feed).toHaveLength(ACTIVITY_FEED_MAX);
    expect(feed[0]!.text).toContain("p30"); // newest survives, p0 trimmed
  });
});

// ---------------------------------------------------------------------------
// itemRemoved placeholder
// ---------------------------------------------------------------------------

describe("storeReducer — itemRemoved", () => {
  it("removes the item and its placement", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({ itemId: "i1", promptRaw: "red balloon", nickname: "Me", teamId: TEAM_A }),
    });
    s = storeReducer(s, {
      type: "layoutUpdated",
      payload: envelope({ teamId: TEAM_A, version: 1, placements: PLACEMENTS_V1, source: "solver" }),
    });
    s = storeReducer(s, { type: "itemRemoved", itemId: "i1" });
    const teamA = s!.teams.find((t) => t.id === TEAM_A)!;
    // GM removal marks the row (audit trail) and drops the placement; the
    // OWNER's ledger gets the player-facing reason.
    expect(teamA.items[0]!.status).toBe("rejected");
    expect(teamA.items[0]!.reason).toBe("removed");
    expect(s!.myItems["i1"]!.reason).toBe("removed by the host");
    expect(teamA.layout!.placements).toHaveLength(0);
  });
});
