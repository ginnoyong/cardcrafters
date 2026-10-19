/**
 * Montage accumulator tests (poster step at SCORING entry) — the real
 * runMontageAccumulator against the MemoryRepo with a controllable fake
 * MontageAi (plus the real mock AiRouter for the mock-mode end-to-end):
 * in-flight dedup per team+round, AI-error fail-open (FALLBACK),
 * budget-skip at zero AI spend, mock-mode READY + file persistence, and
 * the GENERATING patch + `montage:generating` heads-up ordering.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { AiBudgetExceededError } from "../ai/errors";
import { createAiRouter } from "../ai/router";
import { GameHub } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { MontageAi } from "../layout/montage";
import type { LayoutEmit } from "../layout/engine";
import {
  resetMontageAccumulatorInFlight,
  runMontageAccumulator,
  type MontageAccumulatorDeps,
} from "./montage-accumulator";

const START = 1_700_000_000_000;

/** Minimal 1×1 PNG — the accumulator only persists bytes, never decodes them. */
const FAKE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface RecordedCall {
  task: string;
  input: Record<string, unknown>;
}

interface RecordedEvent {
  event: string;
  payload: Record<string, unknown>;
  ctx: { gameId: string; teamId: string };
}

interface FakeAiOpts {
  /** montage_prompt throws this instead of resolving. */
  promptError?: Error;
  /** montage_image throws this instead of resolving. */
  imageError?: Error;
  /** EVERY task throws this first (budget guard fires before any call). */
  budgetError?: Error;
  /** Hold montage_image on a deferred until releaseImage() is called. */
  holdImage?: boolean;
}

/** Controllable fake implementing the accumulator's MontageAi surface. */
function createFakeAi(opts: FakeAiOpts = {}): {
  ai: MontageAi;
  calls: RecordedCall[];
  releaseImage: () => void;
} {
  const calls: RecordedCall[] = [];
  let releaseImage: () => void = () => {};
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const ai: MontageAi = {
    async run(task, input) {
      calls.push({ task, input: { ...input } });
      if (opts.budgetError) throw opts.budgetError;
      if (task === "montage_prompt") {
        if (opts.promptError) throw opts.promptError;
        return { data: { prompt: "a joyful balloon poster" } };
      }
      // montage_image (the only other task the accumulator calls).
      if (opts.imageError) throw opts.imageError;
      if (opts.holdImage) await imageGate;
      return { data: null, imageBase64: FAKE_PNG_B64, imageMime: "image/png" };
    },
  };
  return { ai, calls, releaseImage };
}

interface Setup {
  repo: MemoryRepo;
  hub: GameHub;
  gameId: string;
  teamId: string;
  round: number;
  storageDir: string;
  events: RecordedEvent[];
  emit: LayoutEmit;
}

async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const hub = new GameHub(repo, { to: () => ({ emit: () => {} }) });
  const { game, teams } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 1 });
  await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Balloon party", now: START });
  const joined = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });

  // One sized READY sticker — the accumulator's minimum poster input.
  const item = await repo.createItem({
    teamId: joined.team.id,
    playerId: joined.player.id,
    round: game.round,
    promptRaw: "red balloon",
    status: "READY",
  });
  await repo.updateItem(item.id, { width: 512, height: 512, visualWeight: 1 });

  const storageDir = await mkdtemp(path.join(tmpdir(), "cc-montage-"));
  const events: RecordedEvent[] = [];
  const emit: LayoutEmit = (event, payload, ctx) => events.push({ event, payload, ctx });
  return {
    repo,
    hub,
    gameId: game.id,
    teamId: joined.team.id,
    round: game.round,
    storageDir,
    events,
    emit,
  };
}

/** Fresh temp storage dir per test (cleaned up in afterEach). */
const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runMontageAccumulator", () => {
  beforeEach(() => {
    // The dedup map is module-level — clear it between tests.
    resetMontageAccumulatorInFlight();
  });

  it("(a) dedups concurrent triggers per team+round — two triggers → ONE AI pass", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ holdImage: true });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai: fake.ai,
      mockMode: false,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    // Two overlapping triggers — the second must rejoin the SAME in-flight
    // promise (no second AI pass), not queue a duplicate pipeline.
    const p1 = runMontageAccumulator(deps, s.gameId);
    const p2 = runMontageAccumulator(deps, s.gameId);

    // Exactly one pass is in flight: montage_prompt ran once and
    // montage_image is held on its deferred.
    await vi.waitFor(() => {
      expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(1);
      expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(1);
    });

    fake.releaseImage();
    await Promise.all([p1, p2]);

    // Still exactly one AI pass after everything settled.
    expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(1);
    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
  });

  it("(b) montage_prompt failure → FALLBACK + fallbackUsed, montage:updated {status:\"fallback\"}", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ promptError: new Error("prompt model down") });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai: fake.ai,
      mockMode: false,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    await runMontageAccumulator(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("FALLBACK");
    expect(row?.fallbackUsed).toBe(true);
    expect(row?.imageUrl).toBeNull();
    // The image task is never attempted after the prompt failure.
    expect(fake.calls.some((c) => c.task === "montage_image")).toBe(false);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      round: s.round,
      teamId: s.teamId,
      status: "fallback",
    });
    expect(updates[0]!.ctx).toEqual({ gameId: s.gameId, teamId: s.teamId });
  });

  it("(b2) montage_image failure → FALLBACK + fallbackUsed, montage:updated {status:\"fallback\"}", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ imageError: new Error("image provider outage") });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai: fake.ai,
      mockMode: false,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    await runMontageAccumulator(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("FALLBACK");
    expect(row?.fallbackUsed).toBe(true);
    expect(row?.imageUrl).toBeNull();
    expect(fake.calls.some((c) => c.task === "montage_image")).toBe(true);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ status: "fallback" });
  });

  it("(c) AiBudgetExceededError → FALLBACK with ZERO AI image calls", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({
      budgetError: new AiBudgetExceededError({ gameId: s.gameId, spentUsd: 5, budgetUsd: 5 }),
    });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai: fake.ai,
      mockMode: false,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    await runMontageAccumulator(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("FALLBACK");
    expect(row?.fallbackUsed).toBe(true);
    // Budget guard fires BEFORE any provider work — the image task is never
    // even attempted (zero spend).
    expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(0);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ status: "fallback" });
  });

  it("(d) mock mode runs end-to-end → READY, PNG persisted under storageDir, montage:updated {status:\"ready\"}", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const ai = await createAiRouter({
      repo: s.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai,
      mockMode: true,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    await runMontageAccumulator(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.fallbackUsed).toBe(false);
    expect(row?.imageUrl ?? "").toMatch(/^\/static\/montages\//);
    expect(row?.promptText).toBeTruthy();
    // The procedural poster bytes are persisted under the storage dir
    // (game/team subdir, one PNG file).
    const files = await readdir(path.join(s.storageDir, s.gameId, s.teamId));
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".png")).toBe(true);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      round: s.round,
      teamId: s.teamId,
      status: "ready",
      imageUrl: row?.imageUrl,
    });
  });

  it("(e) patches GENERATING + emits montage:generating BEFORE the AI calls", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ holdImage: true });
    const deps: MontageAccumulatorDeps = {
      repo: s.repo,
      ai: fake.ai,
      mockMode: false,
      emit: s.emit,
      storageDir: s.storageDir,
    };

    const p = runMontageAccumulator(deps, s.gameId);
    // Hold the image call open so the in-flight state is observable.
    await vi.waitFor(() => {
      expect(fake.calls.some((c) => c.task === "montage_image")).toBe(true);
    });

    // The row is GENERATING and the heads-up already landed while the AI
    // call is still pending.
    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("GENERATING");
    const generating = s.events.filter((e) => e.event === "montage:generating");
    expect(generating).toHaveLength(1);
    expect(generating[0]!.payload).toMatchObject({ round: s.round, teamId: s.teamId });
    expect(generating[0]!.ctx).toEqual({ gameId: s.gameId, teamId: s.teamId });

    fake.releaseImage();
    await p;
    const settled = await s.repo.getMontageState(s.teamId, s.round);
    expect(settled?.status).toBe("READY");
  });
});