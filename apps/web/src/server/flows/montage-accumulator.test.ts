/**
 * Montage accumulator tests (STAGING-DRIVEN poster step) — the real
 * stageMontageInput / finalizeMontageAll against the MemoryRepo with a
 * controllable fake MontageAi (plus the real mock AiRouter for the mock-mode
 * end-to-end): staging → maybeStart dedup per team+round, the trailing-edge
 * re-arm (seq > imageSeq), finalize's one-guaranteed-extra-pass / skip
 * semantics, AI-error fail-open (FALLBACK) with lastError + attempted
 * promptText, budget-skip at zero AI spend, and the GENERATING patch +
 * `montage:generating` heads-up ordering.
 *
 * Trigger routing:
 *  - staging-path tests use stageMontageInput (maybeStart awaits the pass it
 *    starts, so one await settles the whole chain);
 *  - legacy/no-staging tests trigger via finalizeMontageAll (the hub's
 *    preScoring hook) — idle + un-posted or rowless teams get exactly one
 *    final gen there.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

import { deriveGradingFromStyle, gradePoster } from "../render/card-render";

import { AiBudgetExceededError } from "../ai/errors";
import { montageImagePrompt } from "../ai/openrouter-provider";
import { createAiRouter } from "../ai/router";
import { GameHub } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { MontageAi } from "../layout/montage";
import type { LayoutEmit } from "../layout/engine";
import {
  finalizeMontageAll,
  resetMontageAccumulatorInFlight,
  stageMontageInput,
  type MontageAccumulatorDeps,
  type StageMontageInput,
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
  /** montage_image returns this base64 instead of the 1×1 placeholder. */
  imageBase64?: string;
  /** montage_prompt returns a poster prompt EMBEDDING the input greeting
   *  (models the hardened montage_prompt template, which renders the
   *  greeting verbatim as the poster's title treatment). */
  greetingPrompt?: boolean;
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
        return {
          data: {
            prompt: opts.greetingPrompt
              ? `a joyful balloon poster whose lower-third title treatment reads: ${String(input.greeting ?? "")}`
              : "a joyful balloon poster",
          },
        };
      }
      // montage_image (the only other task the accumulator calls).
      if (opts.imageError) throw opts.imageError;
      if (opts.holdImage) await imageGate;
      return {
        data: null,
        imageBase64: opts.imageBase64 ?? FAKE_PNG_B64,
        imageMime: "image/png",
      };
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

  // One sized READY sticker — the accumulator's minimum poster input for the
  // legacy (no-staging) fallback path.
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

function depsOf(s: Setup, ai: MontageAi | null, mockMode = false): MontageAccumulatorDeps {
  return { repo: s.repo, ai, mockMode, emit: s.emit, storageDir: s.storageDir };
}

/** A synthetic staged player input (no FK validation on montage staging). */
function stagedInput(subject: string, nickname = "Alex"): StageMontageInput {
  return {
    itemId: `item-${subject.replace(/\s+/g, "-")}`,
    promptRaw: subject,
    subject,
    playerId: "player-1",
    nickname,
  };
}

/** Fresh temp storage dir per test (cleaned up in afterEach). */
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("montage accumulator (staging-driven)", () => {
  beforeEach(() => {
    // The dedup map is module-level — clear it between tests.
    resetMontageAccumulatorInFlight();
  });

  it("(a) two concurrent stageMontageInput with a held image → exactly ONE pass while held; the trailing edge converges (imageSeq === seq === 2, both subjects)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ holdImage: true });
    const deps = depsOf(s, fake.ai);

    // Two overlapping stagings — round 1's hop-2 concurrency case: seq 2 ≠
    // round 1, so the poster needs TWO staged inputs, and the second must
    // never fork a second concurrent pass.
    const p1 = stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));
    const p2 = stageMontageInput(deps, s.gameId, s.teamId, stagedInput("blue star"));

    // Exactly one pass is in flight: montage_prompt ran once and
    // montage_image is held on its deferred.
    await vi.waitFor(() => {
      expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(1);
      expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(1);
    });

    fake.releaseImage();
    await Promise.all([p1, p2]);
    // The staging promises don't cover the trailing-edge pass — wait for the
    // row to converge on the full staged set.
    await vi.waitFor(async () => {
      const row = await s.repo.getMontageState(s.teamId, s.round);
      expect(row?.status).toBe("READY");
      expect(row?.seq).toBe(2);
      expect(row?.imageSeq).toBe(2);
    });

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.imageSeq).toBe(row?.seq);
    // seq is the staging counter, NOT the round (round 1 got 2 staged inputs).
    expect(row?.imageSeq).not.toBe(s.round);

    // The LAST prompt call's subjects cover BOTH staged inputs (the trailing
    // pass re-snapshotted after the second staging landed).
    const promptCalls = fake.calls.filter((c) => c.task === "montage_prompt");
    const last = promptCalls[promptCalls.length - 1]!;
    const subjects = last.input.subjects as string[];
    expect(subjects).toContain("red balloon");
    expect(subjects).toContain("blue star");
  });

  it("(b) montage_prompt failure (finalize trigger) → FALLBACK + lastError, payload {status:\"fallback\", error, promptText: null}, no image call", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ promptError: new Error("prompt model down") });
    const deps = depsOf(s, fake.ai);

    // No staging — the legacy path (sized READY items) via the finalize hook.
    await finalizeMontageAll(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("FALLBACK");
    expect(row?.fallbackUsed).toBe(true);
    expect(row?.imageUrl).toBeNull();
    expect(row?.lastError).toBe("prompt model down");
    // No prompt was generated before the failure → promptText stays null.
    expect(row?.promptText).toBeNull();
    // The image task is never attempted after the prompt failure.
    expect(fake.calls.some((c) => c.task === "montage_image")).toBe(false);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      round: s.round,
      teamId: s.teamId,
      status: "fallback",
      error: "prompt model down",
      promptText: null,
    });
    expect(updates[0]!.ctx).toEqual({ gameId: s.gameId, teamId: s.teamId });
  });

  it("(b2/hop 1) montage_image failure → the ATTEMPTED promptText persists + lastError; the emit carries both", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ imageError: new Error("image provider outage") });
    const deps = depsOf(s, fake.ai);

    // Staging path: maybeStart awaits the (failing, fail-open) pass.
    await stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("FALLBACK");
    expect(row?.fallbackUsed).toBe(true);
    expect(row?.imageUrl).toBeNull();
    expect(row?.lastError).toBe("image provider outage");
    // The prompt DID run before the image failure — the exact image-model
    // prompt is persisted so the GM's "View prompt" toggle survives.
    expect(row?.promptText).toBe(
      montageImagePrompt({ prompt: "a joyful balloon poster", styleHint: "" }),
    );
    expect(fake.calls.some((c) => c.task === "montage_image")).toBe(true);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      status: "fallback",
      error: "image provider outage",
      promptText: row?.promptText,
    });
  });

  it("(hop 2) two inputs staged sequentially → imageSeq === 2 === row.seq (NOT the round)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi();
    const deps = depsOf(s, fake.ai);

    // Await each staging: the first pass settles (imageSeq 1), the second
    // staging re-arms exactly one more pass (imageSeq 2).
    await stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));
    await stageMontageInput(deps, s.gameId, s.teamId, stagedInput("blue star"));

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.seq).toBe(2);
    expect(row?.imageSeq).toBe(2);
    // The core hop-2 invariant: imageSeq tracks the STAGING counter, never
    // the round number.
    expect(row?.imageSeq).not.toBe(s.round);
    expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(2);
  });

  it("(hop 3) finalize skips an already-current team → still 1 prompt call, 1 montage:updated, row READY", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi();
    const deps = depsOf(s, fake.ai);

    await stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));
    // seq === imageSeq now — finalize must NOT gen again (no gen, no event).
    await finalizeMontageAll(deps, s.gameId);

    expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(1);
    const updates = s.events.filter((e) => e.event === "montage:updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ status: "ready" });
    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.imageSeq).toBe(row?.seq);
  });

  it("(hop 4) staging lands during a held pass + finalize → exactly 2 passes (the guaranteed extra one)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ holdImage: true });
    const deps = depsOf(s, fake.ai);

    // Fire-and-forget staging (production wires it the same way); the pass
    // parks on the held montage_image.
    void stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));
    await vi.waitFor(() => {
      expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(1);
    });

    // Finalize while the pass is in flight: flags ONE guaranteed extra pass,
    // then awaits the running loop.
    const fin = finalizeMontageAll(deps, s.gameId);
    fake.releaseImage();
    await fin;

    // Exactly 2 passes: the released in-flight one + the finalize extra.
    expect(fake.calls.filter((c) => c.task === "montage_prompt")).toHaveLength(2);
    expect(fake.calls.filter((c) => c.task === "montage_image")).toHaveLength(2);
    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.imageSeq).toBe(row?.seq);
  });

  it("(c) AiBudgetExceededError (finalize trigger) → FALLBACK with ZERO AI image calls", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({
      budgetError: new AiBudgetExceededError({ gameId: s.gameId, spentUsd: 5, budgetUsd: 5 }),
    });
    const deps = depsOf(s, fake.ai);

    await finalizeMontageAll(deps, s.gameId);

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

  it("(d) mock mode runs end-to-end (finalize trigger) → READY, PNG persisted under storageDir, montage:updated {status:\"ready\"}", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const ai = await createAiRouter({
      repo: s.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const deps = depsOf(s, ai, true);

    await finalizeMontageAll(deps, s.gameId);

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

  it("(g2) the grading seam runs ONCE per mode (real + mock) with the style-derived grading; persisted bytes decode at native size", async () => {
    // MOCK MODE — the procedural mock poster already bakes the greeting
    // (mockMontageImageResult), so the accumulator must NOT composite any
    // text; it only grades. Mock and real now share the same single
    // gradePoster seam (poster bytes + grading — no greeting parameter).
    const sMock = await setup();
    tempDirs.push(sMock.storageDir);
    const ai = await createAiRouter({
      repo: sMock.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const depsMock = depsOf(sMock, ai, true);
    // A style pack proves the grading is DERIVED FROM THE STYLE (not a fixed
    // neutral constant): the observed grading must equal deriveGradingFromStyle
    // over the same (style, teamId) pair — deterministic per team.
    const style = {
      styleName: "Crayon Pop",
      palette: ["#ff5a5f", "#ffd166"],
      lineWeight: "bold" as const,
      mood: "joyful",
      imagePromptSuffix: "flat vector sticker illustration, white outline",
    };
    await sMock.repo.updateGame(sMock.gameId, { style });
    const gradeCalls: Array<{ poster: Buffer; grading: unknown }> = [];
    depsMock.gradePoster = async (poster, grading) => {
      gradeCalls.push({ poster, grading });
      return gradePoster(poster, grading);
    };

    await finalizeMontageAll(depsMock, sMock.gameId);

    expect(gradeCalls).toHaveLength(1);
    expect(gradeCalls[0]!.grading).toEqual(deriveGradingFromStyle(style, sMock.teamId));
    const rowMock = await sMock.repo.getMontageState(sMock.teamId, sMock.round);
    expect(rowMock?.status).toBe("READY");
    expect(rowMock?.lastError).toBeNull();
    // The graded poster persists at the mock's native 800×1120 and decodes.
    const mockFiles = await readdir(path.join(sMock.storageDir, sMock.gameId, sMock.teamId));
    expect(mockFiles).toHaveLength(1);
    const persistedMock = await readFile(
      path.join(sMock.storageDir, sMock.gameId, sMock.teamId, mockFiles[0]!),
    );
    const metaMock = await sharp(persistedMock).metadata();
    expect(metaMock.format).toBe("png");
    expect(metaMock.width).toBe(800);
    expect(metaMock.height).toBe(1120);

    // REAL MODE — the same seam, once, with the neutral style-derived grading
    // (no style pack → the {0,1,1, vignette 0.15} default).
    const sReal = await setup();
    tempDirs.push(sReal.storageDir);
    const fake = createFakeAi();
    const depsReal = depsOf(sReal, fake.ai);
    const realCalls: Array<{ grading: unknown }> = [];
    depsReal.gradePoster = async (poster, grading) => {
      realCalls.push({ grading });
      return gradePoster(poster, grading);
    };

    await finalizeMontageAll(depsReal, sReal.gameId);

    expect(realCalls).toHaveLength(1);
    expect(realCalls[0]!.grading).toEqual(deriveGradingFromStyle(null, sReal.teamId));
    const rowReal = await sReal.repo.getMontageState(sReal.teamId, sReal.round);
    expect(rowReal?.status).toBe("READY");
    expect(rowReal?.lastError).toBeNull();
    const realFiles = await readdir(path.join(sReal.storageDir, sReal.gameId, sReal.teamId));
    expect(realFiles).toHaveLength(1);
    const persistedReal = await readFile(
      path.join(sReal.storageDir, sReal.gameId, sReal.teamId, realFiles[0]!),
    );
    const metaReal = await sharp(persistedReal).metadata();
    expect(metaReal.format).toBe("png");
    // The fake's 1×1 placeholder poster persists at its native size.
    expect(metaReal.width).toBe(1);
    expect(metaReal.height).toBe(1);
  });

  it("(g2b) mock mode WITHOUT the seam override — the real gradePoster re-encodes with grading (graded bytes differ from the raw mock poster, no greeting seam anywhere)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const ai = await createAiRouter({
      repo: s.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const deps = depsOf(s, ai, true);
    // Recording shim around the REAL gradePoster: capture the raw procedural
    // mock poster bytes the accumulator hands in, then let the real grading
    // run so the persisted bytes are genuinely graded.
    const rawMockPosters: Buffer[] = [];
    deps.gradePoster = async (poster, grading) => {
      rawMockPosters.push(poster);
      return gradePoster(poster, grading);
    };

    await finalizeMontageAll(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    // No greeting references in the failure channel — grading is the only
    // post-processing step left, and it succeeded here.
    expect(row?.lastError).toBeNull();
    const files = await readdir(path.join(s.storageDir, s.gameId, s.teamId));
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".png")).toBe(true);
    const persisted = await readFile(path.join(s.storageDir, s.gameId, s.teamId, files[0]!));
    // The neutral style-derived grading re-encodes (vignette 0.15), so the
    // persisted bytes differ from the RAW procedural mock poster captured at
    // the seam (the greeting-baked artwork is graded, not skipped).
    expect(rawMockPosters).toHaveLength(1);
    expect(persisted.equals(rawMockPosters[0]!)).toBe(false);
    const meta = await sharp(persisted).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1120);
  });

  it("(g2c) square AI poster + the game's card ratio → the persisted PNG is center-cropped to the card ratio (source-side aspect normalization)", async () => {
    // Real image models return varying aspects (often square); the persisted
    // poster must already match the game's card ratio so every UI box (5:7)
    // renders identically. The REAL gradePoster runs (no seam override) —
    // the accumulator forwards game.config.cardRatioW/H (the setup game uses
    // DEFAULT_CARD_CONFIG: 5/7).
    const s = await setup();
    tempDirs.push(s.storageDir);
    const squarePoster = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#2244cc" },
    })
      .png()
      .toBuffer();
    const fake = createFakeAi({ imageBase64: squarePoster.toString("base64") });
    const deps = depsOf(s, fake.ai);

    await finalizeMontageAll(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.lastError).toBeNull();
    const files = await readdir(path.join(s.storageDir, s.gameId, s.teamId));
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".png")).toBe(true);
    const persisted = await readFile(path.join(s.storageDir, s.gameId, s.teamId, files[0]!));
    const meta = await sharp(persisted).metadata();
    expect(meta.format).toBe("png");
    // Crop math: native 64×64 (aspect 1) vs 5/7 → width crops to
    // floor(64·5/7) = 45, height stays 64 (never upscaled).
    expect(meta.width).toBe(45);
    expect(meta.height).toBe(64);
    // Output ratio ≈ 5/7 within 2px of the exact box.
    expect(Math.abs(meta.width! / meta.height! - 5 / 7)).toBeLessThan(2 / 64);
  });

  it("(g4) greeting bleed-in: the greeting rides BOTH AI inputs, the image prompt embeds it, and the mock prompt ships it end-to-end", async () => {
    // Phase 1 — fake AI: the greeting reaches BOTH tasks verbatim, and the
    // montage_image input's prompt (what the image model actually receives)
    // embeds the greeting as the title treatment.
    const s = await setup();
    tempDirs.push(s.storageDir);
    await s.repo.createGreeting({
      teamId: s.teamId,
      round: s.round,
      text: "Cheers to you, Linda!",
    });
    const fake = createFakeAi({ greetingPrompt: true });
    const deps = depsOf(s, fake.ai);

    await finalizeMontageAll(deps, s.gameId);

    const promptCall = fake.calls.find((c) => c.task === "montage_prompt");
    const imageCall = fake.calls.find((c) => c.task === "montage_image");
    expect(promptCall).toBeDefined();
    expect(imageCall).toBeDefined();
    expect(promptCall!.input.greeting).toBe("Cheers to you, Linda!");
    // The montage_image input derives from the montage_prompt output — which
    // (per the hardened template) renders the greeting verbatim as the
    // poster's title treatment — so the image model sees the greeting inside
    // the poster prompt it is asked to paint.
    expect(String(imageCall!.input.prompt)).toContain("Cheers to you, Linda!");
    // The image task ALSO carries the greeting as a direct input field.
    expect(imageCall!.input.greeting).toBe("Cheers to you, Linda!");

    // Phase 2 — real mock router: the mock montage_prompt's canned string
    // CONTAINS the greeting text, proving the whole chain (accumulator →
    // router → mock provider → schema-validated prompt) carries it.
    const sMock = await setup();
    tempDirs.push(sMock.storageDir);
    await sMock.repo.createGreeting({
      teamId: sMock.teamId,
      round: sMock.round,
      text: "Cheers to you, Linda!",
    });
    const ai = await createAiRouter({
      repo: sMock.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const depsMock = depsOf(sMock, ai, true);

    await finalizeMontageAll(depsMock, sMock.gameId);

    const row = await sMock.repo.getMontageState(sMock.teamId, sMock.round);
    expect(row?.status).toBe("READY");
    expect(row?.promptText).toContain("Cheers to you, Linda!");
  });

  it("(e2) persists promptText === the EXACT montageImagePrompt output (poster prompt + style hint)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    // A style pack exercises the styleHint half of the persisted prompt (and
    // proves the sticker imagePromptSuffix is NOT what gets persisted).
    await s.repo.updateGame(s.gameId, {
      style: {
        styleName: "Crayon Pop",
        palette: ["#ff5a5f", "#ffd166"],
        lineWeight: "bold",
        mood: "joyful",
        imagePromptSuffix: "flat vector sticker illustration, white outline",
      },
    });
    const fake = createFakeAi();
    const deps = depsOf(s, fake.ai);

    await finalizeMontageAll(deps, s.gameId);

    const imageCall = fake.calls.find((c) => c.task === "montage_image");
    expect(imageCall).toBeDefined();
    const row = await s.repo.getMontageState(s.teamId, s.round);
    // promptText must be byte-identical to the string the real provider sends
    // (montageImagePrompt over the SAME poster prompt + styleHint inputs).
    expect(row?.promptText).toBe(
      montageImagePrompt({
        prompt: "a joyful balloon poster",
        styleHint: String(imageCall!.input.styleHint ?? ""),
      }),
    );
    // And the style hint is the palette/mood pair — NEVER the sticker suffix.
    expect(row?.promptText).toContain("palette #ff5a5f, #ffd166, joyful mood");
    expect(row?.promptText).not.toContain("sticker");
  });

  it("(e) staging patches GENERATING + emits montage:generating BEFORE the AI calls", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const fake = createFakeAi({ holdImage: true });
    const deps = depsOf(s, fake.ai);

    // Triggered via stageMontageInput — finalize would add a second pass, i.e.
    // a SECOND montage:generating that would break the toHaveLength(1) below.
    const p = stageMontageInput(deps, s.gameId, s.teamId, stagedInput("red balloon"));
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
    // No duplicate pass fired: still exactly one heads-up.
    expect(s.events.filter((e) => e.event === "montage:generating")).toHaveLength(1);
  });
});