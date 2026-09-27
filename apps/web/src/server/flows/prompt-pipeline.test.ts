/**
 * Prompt pipeline tests (build-phase step 1) — the full server-side submission
 * pipeline with a forced-mock AI router (never hits a real provider) and a
 * fake clock for deterministic cooldown behavior.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CARD_CONFIG, type CardConfig } from "@cardcrafters/shared";

import { AiTaskError } from "../ai/errors";
import { createAiRouter, type AiRouter } from "../ai/router";
import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { ItemRow, Repository } from "../repo/repository";
import { createMemoryImageQueue } from "../queue/queue";
import { createPromptPipelineDeps, submitPrompt, type PromptIdentity, type PromptPipelineDeps, type PromptSubmitResult } from "./prompt-pipeline";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

/** Fixed epoch the fake clock returns (advanced explicitly by tests). */
const START = 1_700_000_000_000;
const clock = { now: START };
const tick = (ms: number) => {
  clock.now += ms;
};

interface RecordedEmit {
  event: string;
  payload: Record<string, unknown>;
  toPlayerOnly?: string;
}

/** Recording emit callback (the ws layer's stand-in). */
function makeEmitSink() {
  const events: RecordedEmit[] = [];
  const emit = (
    event: string,
    payload: Record<string, unknown>,
    opts?: { toPlayerOnly?: string },
  ): void => {
    events.push({ event, payload, toPlayerOnly: opts?.toPlayerOnly });
  };
  return { events, emit };
}

interface Setup {
  repo: MemoryRepo;
  hub: GameHub;
  ai: AiRouter;
  teamId: string;
  playerId: string;
  gameId: string;
  events: RecordedEmit[];
  emit: (
    event: string,
    payload: Record<string, unknown>,
    emitOpts?: { toPlayerOnly?: string },
  ) => void;
  submit(text: string, overrides?: Partial<PromptPipelineDeps>): Promise<PromptSubmitResult>;
}

/** Drive a fresh game to BUILD with one joined player ("Alex"). */
async function setup(opts: { config?: CardConfig } = {}): Promise<Setup> {
  const repo = new MemoryRepo();
  const { io } = fakeIo();
  const hub = new GameHub(repo, io);
  const config = opts.config ?? UNTIMED_CONFIG;
  const { game, teams } = await hub.createGame(config, { teamCount: 1 });
  const joined = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
  await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Birthday", now: clock.now });
  await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: clock.now });

  // Forced-mock AI (never a real provider, even with a local API key set).
  const ai = await createAiRouter({
    repo,
    env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
  });

  const events: RecordedEmit[] = [];
  const emit = (
    event: string,
    payload: Record<string, unknown>,
    emitOpts?: { toPlayerOnly?: string },
  ): void => {
    events.push({ event, payload, toPlayerOnly: emitOpts?.toPlayerOnly });
  };

  // One deps object per setup → the cooldown map lives across submits, just
  // like the single per-server map in the real wiring.
  const base = createPromptPipelineDeps({ hub, repo, ai, now: () => clock.now, emit });

  const submit = (
    text: string,
    overrides: Partial<PromptPipelineDeps> = {},
  ): Promise<PromptSubmitResult> =>
    submitPrompt(
      { ...base, ...overrides },
      { gameId: game.id, playerId: joined.player.id },
      text,
    );

  return {
    repo,
    hub,
    ai,
    teamId: joined.team.id,
    playerId: joined.player.id,
    gameId: game.id,
    events,
    emit,
    submit,
  };
}

function fakeIo(): { io: RoomEmitter } {
  const io: RoomEmitter = {
    to() {
      return { emit() {} };
    },
  };
  return { io };
}

async function itemsOf(repo: Repository, teamId: string): Promise<ItemRow[]> {
  return repo.listItems(teamId, 1);
}

afterEach(() => {
  clock.now = START;
  vi.restoreAllMocks();
});

describe("prompt pipeline — happy path", () => {
  it("pending → validation → moderation → GENERATING with subject persisted + cooldown anchored", async () => {
    const s = await setup();
    const res = await s.submit("A Red Balloon Dog");

    expect(res).toEqual({ ok: true, itemId: expect.any(String) });
    const rows = await itemsOf(s.repo, s.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: (res as { itemId: string }).itemId,
      promptRaw: "A Red Balloon Dog", // verbatim
      subject: "a red balloon dog", // normalized_subject from mock validation
      status: "GENERATING",
      failReason: null,
    });

    // Exactly one event: item:pending to the TEAM (not owner-only).
    expect(s.events).toEqual([
      {
        event: "item:pending",
        payload: expect.objectContaining({
          itemId: (res as { itemId: string }).itemId,
          promptRaw: "A Red Balloon Dog",
          nickname: "Alex",
          teamId: s.teamId,
          createdAt: expect.any(Number),
        }),
        toPlayerOnly: undefined,
      },
    ]);

    // Cooldown anchored on acceptance: an immediate second submit is blocked
    // with the remaining time on the default 5000ms cooldown.
    tick(1000);
    const second = await s.submit("a birthday cake with candles");
    expect(second).toMatchObject({ ok: false, stage: "cooldown", remainingMs: 4000 });

    // ...and once the cooldown has elapsed the same player is allowed again.
    tick(4000);
    const third = await s.submit("a birthday cake with candles");
    expect(third).toEqual({ ok: true, itemId: expect.any(String) });
  });
});

describe("prompt pipeline — AI checks", () => {
  it("validation reject ('happiness') → REJECTED row + owner-only item:rejected, cooldown NOT consumed", async () => {
    const s = await setup();
    const res = await s.submit("happiness");

    expect(res).toMatchObject({ ok: false, stage: "validation" });
    const failed = res as Extract<PromptSubmitResult, { stage: "validation" }>;
    expect(failed.reason).toContain("feeling");
    expect(failed.exampleFix).toBeTruthy();

    const rows = await itemsOf(s.repo, s.teamId);
    expect(rows).toHaveLength(1); // audit trail keeps the row
    expect(rows[0]).toMatchObject({ status: "REJECTED", failReason: expect.any(String), subject: null });

    // item:rejected goes ONLY to the owner, with the friendly reason + fix.
    expect(s.events).toEqual([
      { event: "item:pending", payload: expect.objectContaining({ itemId: rows[0]!.id }), toPlayerOnly: undefined },
      {
        event: "item:rejected",
        payload: expect.objectContaining({
          itemId: rows[0]!.id,
          reason: expect.stringContaining("feeling"),
          exampleFix: expect.any(String),
        }),
        toPlayerOnly: s.playerId,
      },
    ]);

    // Rejected submissions don't consume the cooldown → immediate resubmit ok.
    const next = await s.submit("a red balloon dog");
    expect(next).toEqual({ ok: true, itemId: expect.any(String) });
  });

  it("moderation reject ('unsafe test') → REJECTED row + owner-only item:rejected, cooldown NOT consumed", async () => {
    const s = await setup();
    const res = await s.submit("unsafe test doodle");

    expect(res).toMatchObject({ ok: false, stage: "moderation" });
    const failed = res as Extract<PromptSubmitResult, { stage: "moderation" }>;
    expect(failed.reason.toLowerCase()).toContain("allowed");

    const rows = await itemsOf(s.repo, s.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("REJECTED");
    expect(s.events[1]).toMatchObject({ event: "item:rejected", toPlayerOnly: s.playerId });

    const next = await s.submit("a red balloon dog");
    expect(next).toEqual({ ok: true, itemId: expect.any(String) });
  });

  it("AI outage → item FAILED + ai_unavailable, cooldown NOT consumed (retry works)", async () => {
    const s = await setup();
    const failingAi = {
      run: async () => {
        throw new AiTaskError({ task: "prompt_validation", retryable: false, message: "provider down" });
      },
    };

    const res = await s.submit("a red balloon dog", { ai: failingAi });
    expect(res).toEqual({
      ok: false,
      stage: "ai_unavailable",
      reason: expect.stringContaining("temporarily unavailable"),
    });

    const rows = await itemsOf(s.repo, s.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", failReason: "provider down" });
    // Owner-only item:failed.
    expect(s.events[1]).toMatchObject({ event: "item:failed", toPlayerOnly: s.playerId });

    // No cooldown consumed: with the AI back, an immediate submit succeeds.
    const retry = await s.submit("a red balloon dog");
    expect(retry).toEqual({ ok: true, itemId: expect.any(String) });
    const after = await itemsOf(s.repo, s.teamId);
    expect(after.find((r) => r.id === rows[0]!.id)).toMatchObject({
      status: "GENERATING", // the FAILED row was resurrected for the same key
      failReason: null,
      subject: "a red balloon dog",
    });
  });
});

describe("prompt pipeline — limits", () => {
  it("cooldown enforced between accepted submissions (fake clock)", async () => {
    const s = await setup();
    expect(await s.submit("a red balloon dog")).toMatchObject({ ok: true });

    tick(4999);
    const second = await s.submit("a birthday cake with candles");
    expect(second).toMatchObject({ ok: false, stage: "cooldown" });
    expect((second as { remainingMs: number }).remainingMs).toBeGreaterThan(0);

    tick(1000); // elapsed 5000 → no longer inside the cooldown window
    expect(await s.submit("a birthday cake with candles")).toMatchObject({ ok: true });
  });

  it("in-flight cap: 3 GENERATING blocks the 4th; rejected items don't count", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) {
      await s.repo.createItem({
        teamId: s.teamId,
        playerId: s.playerId,
        round: 1,
        promptRaw: `seed ${i}`,
        status: "GENERATING",
      });
    }
    const blocked = await s.submit("a red balloon dog");
    expect(blocked).toMatchObject({ ok: false, stage: "too_many_inflight" });

    // One seed rejected (mock moderation) → only 2 in flight → allowed again.
    const rows = await itemsOf(s.repo, s.teamId);
    await s.repo.updateItem(rows[0]!.id, { status: "REJECTED", failReason: "test" });
    const allowed = await s.submit("a red balloon dog");
    expect(allowed).toMatchObject({ ok: true });
    const after = await itemsOf(s.repo, s.teamId);
    expect(after.filter((r) => r.status === "GENERATING")).toHaveLength(3);
  });

  it("card full: 25 non-removed items block the 26th; removing one frees a slot", async () => {
    const s = await setup();
    for (let i = 0; i < 25; i++) {
      await s.repo.createItem({
        teamId: s.teamId,
        playerId: "someone-else",
        round: 1,
        promptRaw: `other-${i}`,
        status: "READY",
      });
    }
    const blocked = await s.submit("a red balloon dog");
    expect(blocked).toMatchObject({ ok: false, stage: "card_full" });

    // A removed item does NOT occupy card space.
    const rows = await itemsOf(s.repo, s.teamId);
    await s.repo.updateItem(rows[0]!.id, { status: "REMOVED" });
    const ok = await s.submit("a red balloon dog");
    expect(ok).toMatchObject({ ok: true });
  });

  it("GM-configurable limits flow from CardConfig (cooldownMs 0, maxItemsPerCard 1)", async () => {
    const s = await setup({
      config: { ...UNTIMED_CONFIG, limits: { cooldownMs: 0, maxInflightPerPlayer: 3, maxItemsPerCard: 1 } },
    });

    // cooldownMs 0 → back-to-back submissions are never rate-limited.
    expect(await s.submit("a red balloon dog")).toMatchObject({ ok: true });
    expect(await s.submit("a birthday cake with candles")).toMatchObject({ ok: false, stage: "card_full" });
  });

  it("cutoffAt passed → phase_ended (hub guard stays the single phase authority)", async () => {
    const s = await setup();
    // Set a cutoff in the past, then re-hydrate so the hub's runtime state
    // picks it up (simulates a GM-stopped BUILD whose cutoff has elapsed).
    await s.repo.updateGame(s.gameId, { cutoffAt: clock.now - 1000 });
    await s.hub.hydrateGame(s.gameId);

    const res = await s.submit("a red balloon dog");
    expect(res).toEqual({
      ok: false,
      stage: "phase",
      code: "phase_ended",
      error: expect.any(String),
    });
    expect(await itemsOf(s.repo, s.teamId)).toHaveLength(0); // nothing persisted
    expect(s.events).toEqual([]); // nothing emitted
  });
});

describe("prompt pipeline — queue seam", () => {
  it("enqueues accepted items with the job payload; rejected/failed items never enqueue", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const queue = createMemoryImageQueue(async (job) => {
      jobs.push(job as unknown as Record<string, unknown>);
    });
    const s = await setup();

    const rejected = await s.submit("happiness", { queue });
    expect(rejected).toMatchObject({ ok: false });
    expect(jobs).toEqual([]);

    const ok = await s.submit("a red balloon dog", { queue });
    expect(ok).toMatchObject({ ok: true });
    // The FIFO drain runs in the background — poll briefly for the handler.
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect(jobs[0]).toEqual({
      itemId: (ok as { itemId: string }).itemId,
      gameId: s.gameId,
      teamId: s.teamId,
      playerId: s.playerId,
      round: 1,
      prompt: "a red balloon dog",
      subject: "a red balloon dog",
    });
  });

  it("no queue in deps → the item simply stays GENERATING (tests / step-2 seam)", async () => {
    const s = await setup();
    const res = await s.submit("a red balloon dog");
    expect(res).toMatchObject({ ok: true });
    const rows = await itemsOf(s.repo, s.teamId);
    expect(rows[0]?.status).toBe("GENERATING");
  });
});
