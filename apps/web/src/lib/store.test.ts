/**
 * Unit tests for the client game store reducer (lib/store.tsx) — build-phase
 * item/layout event handling, owner ledger survival, version guards, and
 * activity-feed trimming.
 */

import { describe, expect, it } from "vitest";

import { selectMyItems } from "../components/player/my-items";
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
        critique: null,
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
        critique: null,
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
          critique: null,
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
// owner ledger round scoping (m4)
// ---------------------------------------------------------------------------

describe("owner ledger round scoping (m4)", () => {
  it("a round-1 ledger entry survives a same-round sync:full but is pruned on a round-2 snapshot", () => {
    const prevMyItems: Record<string, MyItemEvent> = {
      i1: { promptRaw: "red balloon", status: "ready", round: 1 },
    };

    // Same round → entry survives untouched.
    const sameRound = normalizeSyncFull(baseSnapshot(), prevMyItems, PLAYER_ME);
    expect(sameRound.myItems["i1"]).toMatchObject({ status: "ready", round: 1 });

    // Round 2 snapshot → previous-round entries are pruned (the card is
    // rebuilt fresh every round).
    const round2 = normalizeSyncFull(baseSnapshot({ round: 2 }), prevMyItems, PLAYER_ME);
    expect(round2.round).toBe(2);
    expect(round2.myItems["i1"]).toBeUndefined();
  });

  it("selectMyItems filters by round: only current-round ledger entries synthesize rows", () => {
    const s = normalizeSyncFull(baseSnapshot({ round: 2 }), {}, PLAYER_ME);
    // Simulate a ledger with a stale round-1 entry and a current round-2 one.
    s.myItems["stale"] = { promptRaw: "old prompt", status: "rejected", round: 1 };
    s.myItems["fresh"] = { promptRaw: "new prompt", status: "pending", round: 2 };

    const mine = selectMyItems(s, TEAM_A, PLAYER_ME);
    const ids = mine.map((i) => i.id);
    expect(ids).toContain("fresh"); // synthesized from the current-round entry
    expect(ids).not.toContain("stale"); // previous round → pruned
  });
});

// ---------------------------------------------------------------------------
// itemWithdrawn + own-sticker ledger filter (owner-scoped myItems)
// ---------------------------------------------------------------------------

describe("storeReducer — itemWithdrawn", () => {
  it("(i) teammate case: pending row + activity entry removed on withdrawn", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    // A TEAMMATE submits — the pending echo carries their playerId.
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i1",
        promptRaw: "happiness",
        nickname: "Sam",
        playerId: "player-other",
        teamId: TEAM_A,
      }),
    });
    expect(s!.teams.find((t) => t.id === TEAM_A)!.items).toHaveLength(1);
    expect(s!.teams.find((t) => t.id === TEAM_A)!.activity).toHaveLength(1);
    // Teammates' prompts never enter MY ledger.
    expect(s!.myItems["i1"]).toBeUndefined();

    s = storeReducer(s, {
      type: "itemWithdrawn",
      payload: envelope({ itemId: "i1", teamId: TEAM_A }),
    });
    const teamA = s!.teams.find((t) => t.id === TEAM_A)!;
    expect(teamA.items).toHaveLength(0);
    expect(teamA.activity).toHaveLength(0);
  });

  it("(ii) OWNER case: item:rejected (ledger terminal) THEN withdrawn → row + ledger survive intact", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    // Owner submits (pending echo carries my playerId → ledger registered).
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i2",
        promptRaw: "happiness",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    // Owner-only event arrives first: ledger goes terminal with the reason.
    s = storeReducer(s, {
      type: "itemRejected",
      payload: envelope({
        itemId: "i2",
        reason: "'happiness' is a feeling.",
        exampleFix: "balloons bursting with confetti",
      }),
    });
    expect(s!.myItems["i2"]).toMatchObject({ status: "rejected", reason: "'happiness' is a feeling." });

    // The team broadcast arrives AFTER the owner event → must be a no-op.
    s = storeReducer(s, {
      type: "itemWithdrawn",
      payload: envelope({ itemId: "i2", teamId: TEAM_A }),
    });
    const teamA = s!.teams.find((t) => t.id === TEAM_A)!;
    expect(teamA.items).toHaveLength(1);
    expect(teamA.items[0]).toMatchObject({ id: "i2", status: "rejected" });
    expect(teamA.activity).toHaveLength(1);
    expect(s!.myItems["i2"]).toMatchObject({
      promptRaw: "happiness",
      status: "rejected",
      reason: "'happiness' is a feeling.",
      exampleFix: "balloons bursting with confetti",
    });
  });

  it("(iii) owner's pending row + withdrawn (owner-only event LOST) → row removed, ledger promptRaw survives and selectMyItems synthesizes it", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i3",
        promptRaw: "a red balloon dog",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    // Ledger still PENDING — the owner-only item:rejected was lost/out-of-order.
    expect(s!.myItems["i3"]).toMatchObject({ status: "pending", promptRaw: "a red balloon dog" });

    s = storeReducer(s, {
      type: "itemWithdrawn",
      payload: envelope({ itemId: "i3", teamId: TEAM_A }),
    });
    // The row is removed (placeholder cleanup is unconditional for non-terminal
    // ledgers) but the ledger is NEVER touched by the broadcast.
    expect(s!.teams.find((t) => t.id === TEAM_A)!.items).toHaveLength(0);
    expect(s!.myItems["i3"]).toMatchObject({ status: "pending", promptRaw: "a red balloon dog" });

    // selectMyItems still synthesizes the entry so the owner sees their
    // submission instead of it silently vanishing.
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i3", promptRaw: "a red balloon dog", status: "pending" });
  });

  it("(iv) unknown itemId → no-op", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemWithdrawn",
      payload: envelope({ itemId: "does-not-exist", teamId: TEAM_A }),
    });
    expect(s!.teams.find((t) => t.id === TEAM_A)!.items).toHaveLength(0);
    expect(s!.myItems).toEqual({});
  });

  it("(v) stale round → dropped", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({ itemId: "i1", promptRaw: "p", nickname: "Sam", playerId: "player-other", teamId: TEAM_A }),
    });
    const out = storeReducer(s, {
      type: "itemWithdrawn",
      payload: envelope({ itemId: "i1", teamId: TEAM_A, round: 2 }),
    });
    // Stale event ignored: the round-1 placeholder survives.
    expect(out!.teams.find((t) => t.id === TEAM_A)!.items).toHaveLength(1);
  });
});

describe("own-stickers filter (owner-scoped ledger + strict row ownership)", () => {
  it("teammate itemPending (playerId 'player-other') → myItems gains NO entry; selectMyItems excludes it", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i1",
        promptRaw: "someone else's prompt",
        nickname: "Sam",
        playerId: "player-other",
        teamId: TEAM_A,
      }),
    });
    // Row lands in the team list (prompts are public)…
    expect(s!.teams.find((t) => t.id === TEAM_A)!.items[0]!.id).toBe("i1");
    // …but never in MY ledger.
    expect(s!.myItems["i1"]).toBeUndefined();
    expect(selectMyItems(s!, TEAM_A, PLAYER_ME)).toHaveLength(0);
  });

  it("my own itemPending (playerId = mine) → included in myItems and selectMyItems", () => {
    let s: GameSnapshot | null = normalizeSyncFull(baseSnapshot(), {}, PLAYER_ME);
    s = storeReducer(s, {
      type: "itemPending",
      payload: envelope({
        itemId: "i2",
        promptRaw: "my own prompt",
        nickname: "Me",
        playerId: PLAYER_ME,
        teamId: TEAM_A,
      }),
    });
    expect(s!.myItems["i2"]).toMatchObject({ promptRaw: "my own prompt", status: "pending" });
    const mine = selectMyItems(s!, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i2", promptRaw: "my own prompt", status: "pending" });
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

// ---------------------------------------------------------------------------
// selectMyItems merge precedence (stuck "drawing…" chip)
// ---------------------------------------------------------------------------

describe("selectMyItems merge precedence (stuck drawing chip)", () => {
  /** Snapshot with one READY row attributed to me (server shape: uppercase). */
  function readyRowSnapshot(itemId: string, prompt: string): SyncFullEvent {
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
              status: "READY",
              imageUrl: `/static/items/${itemId}.png`,
              width: 100,
              height: 100,
            } as unknown as never,
          ],
          layout: null,
          activity: [],
          critique: null,
        },
      ],
    });
  }

  it("stale PENDING ledger + READY row → placed/ready, never drawing (direct call)", () => {
    // Direct selectMyItems call (no normalizeSyncFull ledger rebuild in the
    // path): a stale pending LEDGER entry must never downgrade a READY row —
    // otherwise the chip sticks at "drawing…" until the round ends.
    const snap = {
      ...baseSnapshot({
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
                id: "i1",
                promptRaw: "red balloon",
                nickname: "Me",
                playerId: PLAYER_ME,
                status: "ready",
              } as unknown as GameSnapshot["teams"][number]["items"][number],
            ],
            layout: null,
            activity: [],
            critique: null,
          },
        ],
      }),
      myItems: { i1: { promptRaw: "red balloon", status: "pending", round: 1 } },
    } as GameSnapshot;
    const mine = selectMyItems(snap, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i1", status: "ready" });
  });

  it("terminal REJECTED ledger + READY row → rejected with reason (owner-only detail survives)", () => {
    // Reverse direction: the ledger's terminal owner-only intel (reason /
    // exampleFix) must still WIN over any row — the row can never carry it.
    const snap = {
      ...readyRowSnapshot("i2", "happiness"),
      myItems: {
        i2: {
          promptRaw: "happiness",
          status: "rejected" as const,
          reason: "feelings are not drawable",
          exampleFix: "a statue of a person hugging",
          round: 1,
        },
      },
    } as GameSnapshot;
    const mine = selectMyItems(snap, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: "i2",
      status: "rejected",
      reason: "feelings are not drawable",
      exampleFix: "a statue of a person hugging",
    });
  });

  it("both PENDING (ledger + row) → pending either way (no behavior change)", () => {
    const snap = {
      ...readyRowSnapshot("i3", "cat"),
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
              id: "i3",
              promptRaw: "cat",
              nickname: "Me",
              playerId: PLAYER_ME,
              status: "pending",
            } as unknown as GameSnapshot["teams"][number]["items"][number],
          ],
          layout: null,
          activity: [],
          critique: null,
        },
      ],
      myItems: { i3: { promptRaw: "cat", status: "pending", round: 1 } },
    } as GameSnapshot;
    const mine = selectMyItems(snap, TEAM_A, PLAYER_ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "i3", status: "pending" });
  });
});

// ---------------------------------------------------------------------------
// sync:full double-normalize regression (team items must survive)
// ---------------------------------------------------------------------------

describe("sync:full double-normalize regression (team items must survive)", () => {
  it("normalize → storeReducer sync:full keeps team items with statuses intact", () => {
    // Server wire shape: ItemRow statuses are UPPERCASE on the wire
    // (PENDING/READY/…). The old presenter/GM flow normalized the payload,
    // then dispatched it into a reducer that normalizes AGAIN — the second
    // pass saw the lowercase client statuses and (before the mapItemStatus
    // lowercase aliases + raw dispatch fix) dropped every team item.
    const base = baseSnapshot();
    const payload: SyncFullEvent = {
      ...base,
      teams: [
        {
          ...base.teams[0]!,
          itemCount: 3,
          items: [
            { id: "item-1", promptRaw: "a red balloon dog", nickname: "Me", playerId: PLAYER_ME, status: "READY" },
            { id: "item-2", promptRaw: "happiness", nickname: "Me", playerId: PLAYER_ME, status: "PENDING" },
            { id: "item-3", promptRaw: "unsafe doodle", nickname: "Me", playerId: PLAYER_ME, status: "REJECTED" },
          ] as unknown as SyncFullEvent["teams"][number]["items"],
        },
        base.teams[1]!,
      ],
    };

    // Step 1 — normalize the raw payload (as a (now-removed) caller would).
    const normalized = normalizeSyncFull(payload, {}, PLAYER_ME);
    expect(normalized.teams[0]!.items.map((i) => i.status)).toEqual(["ready", "pending", "rejected"]);

    // Step 2 — dispatch the ALREADY-NORMALIZED snapshot through the reducer
    // (the old double-normalize path). Items must SURVIVE with statuses.
    const s = storeReducer(normalized, { type: "sync:full", snapshot: normalized });
    expect(s).not.toBeNull();
    const items = s!.teams.find((t) => t.id === TEAM_A)!.items;
    expect(items.map((i) => i.id)).toEqual(["item-1", "item-2", "item-3"]);
    expect(items.map((i) => i.status)).toEqual(["ready", "pending", "rejected"]);
  });
});
