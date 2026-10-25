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
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

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

/** A stand-in "AI poster": 64×64 flat-color PNG drawn on a real canvas —
 *  big enough that the composited lower-third band is pixel-probeable. */
function fakePosterPng(color = "#2244cc"): Buffer {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  return canvas.toBuffer("image/png");
}

/** RGBA pixel at (x, y) from a raw decode. */
function pixelAt(raw: Buffer, x: number, y: number, width: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!];
}
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

  it("(g) real mode composites the greeting onto the poster — the raw AI output is never persisted as-is", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    // The card's greeting — the playtest bug was that montage posters shipped
    // without it because the raw generated image was served as-is.
    await s.repo.createGreeting({
      teamId: s.teamId,
      round: s.round,
      text: "Cheers to you, Linda!",
    });
    const raw = fakePosterPng();
    const fake = createFakeAi({ imageBase64: raw.toString("base64") });
    const deps = depsOf(s, fake.ai);

    await finalizeMontageAll(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.lastError).toBeNull();
    const file = path.join(s.storageDir, s.gameId, s.teamId, path.basename(row!.imageUrl!));
    const persisted = await readFile(file);
    // Compositing ran: the persisted bytes differ from the raw AI output…
    expect(persisted.equals(raw)).toBe(false);
    // …and decode as a PNG at the poster's native dimensions.
    const meta = await sharp(persisted).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    // Pixel probe: the lower-third band center is no longer the flat poster
    // color (translucent paper band + dark greeting text drawn over it),
    // while the upper artwork stage is untouched (the neutral style-derived
    // grading is pixel-identity away from the corners).
    const rawPx = await sharp(persisted).ensureAlpha().raw().toBuffer();
    expect(pixelAt(rawPx, 32, 8, 64)).toEqual([34, 68, 204, 255]);
    expect(pixelAt(rawPx, 32, 54, 64)).not.toEqual([34, 68, 204, 255]);
  });

  it("(g2) mock mode does NOT double-composite — the compositing seam is never called", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    const ai = await createAiRouter({
      repo: s.repo,
      env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
    });
    const deps = depsOf(s, ai, true);
    // The mock poster already bakes the greeting lower-third — the seam must
    // never run in mock mode (compositing again would double-draw the text).
    let composeCalls = 0;
    deps.composeGreeting = async (poster) => {
      composeCalls++;
      return poster;
    };

    await finalizeMontageAll(deps, s.gameId);

    expect(composeCalls).toBe(0);
    const row = await s.repo.getMontageState(s.teamId, s.round);
    expect(row?.status).toBe("READY");
    expect(row?.lastError).toBeNull();
    // The procedural mock poster persists as-is (native 800×1120, decodes).
    const files = await readdir(path.join(s.storageDir, s.gameId, s.teamId));
    expect(files).toHaveLength(1);
    const persisted = await readFile(path.join(s.storageDir, s.gameId, s.teamId, files[0]!));
    const meta = await sharp(persisted).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1120);
  });

  it("(g3) compositing failure → the RAW poster is persisted and the pass still completes READY (degraded, no lastError)", async () => {
    const s = await setup();
    tempDirs.push(s.storageDir);
    await s.repo.createGreeting({
      teamId: s.teamId,
      round: s.round,
      text: "Cheers to you, Linda!",
    });
    const raw = fakePosterPng();
    const fake = createFakeAi({ imageBase64: raw.toString("base64") });
    const deps = depsOf(s, fake.ai);
    deps.composeGreeting = async () => {
      throw new Error("canvas decode exploded");
    };

    await finalizeMontageAll(deps, s.gameId);

    const row = await s.repo.getMontageState(s.teamId, s.round);
    // Degraded-but-ready: the poster SUCCEEDED — only the text overlay
    // failed — so the row is READY with NO lastError (not FALLBACK).
    expect(row?.status).toBe("READY");
    expect(row?.lastError).toBeNull();
    expect(row?.fallbackUsed).toBe(false);
    // The raw AI bytes are persisted byte-identically (a poster without the
    // greeting text beats no poster).
    const file = path.join(s.storageDir, s.gameId, s.teamId, path.basename(row!.imageUrl!));
    expect((await readFile(file)).equals(raw)).toBe(true);
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