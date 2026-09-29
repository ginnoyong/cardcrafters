/**
 * Item-image worker tests (build-phase step 2) — the real image worker handler
 * end-to-end with the memory queue + mock AI (NO redis, NO real provider):
 * persistence, static file writes (temp-dir override), bg-removal passthrough,
 * visual weight, and the item:ready / item:failed event contracts.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CARD_CONFIG, itemFailedSchema, itemReadySchema, type CardConfig } from "@cardcrafters/shared";

import { AiTaskError } from "../ai/errors";
import { drawMockSticker } from "../ai/mock-provider";
import { createAiRouter, type AiRouter } from "../ai/router";
import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import type { ItemRow } from "../repo/repository";
import { createItemImageHandler, type ItemImageEmit } from "./item-image";
import { createMemoryImageQueue, type ImageJob } from "../queue/queue";
import { createPromptPipelineDeps, submitPrompt } from "./prompt-pipeline";
import { ensureTransparentPng } from "../image/bg-remove";
import { computeVisualWeight } from "../image/weight";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

const START = 1_700_000_000_000;

interface RecordedEmit {
  event: "item:ready" | "item:failed";
  payload: Record<string, unknown>;
  ctx: { gameId: string; teamId: string; playerId: string };
}

interface Setup {
  repo: MemoryRepo;
  hub: GameHub;
  ai: AiRouter;
  gameId: string;
  teamId: string;
  playerId: string;
  storageDir: string;
  events: RecordedEmit[];
  emit: ItemImageEmit;
  handler: (job: ImageJob) => Promise<void>;
}

async function setup(): Promise<Setup> {
  const repo = new MemoryRepo();
  const io: RoomEmitter = { to: () => ({ emit() {} }) };
  const hub = new GameHub(repo, io);
  const { game, teams } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 1 });
  const joined = await hub.joinPlayer({ joinToken: teams[0]!.joinToken, nickname: "Alex" });
  await hub.applyEvent(game.id, { type: "gm:setTheme", theme: "Birthday", now: START });
  await hub.applyEvent(game.id, { type: "gm:approveGreetings", now: START });

  const ai = await createAiRouter({
    repo,
    env: { AI_MODE: "mock", MOCK_AI_DELAY_MS: "0", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
  });

  const storageDir = await mkdtemp(path.join(tmpdir(), "cc-items-"));
  const events: RecordedEmit[] = [];
  const emit: ItemImageEmit = (event, payload, ctx) => events.push({ event, payload, ctx });
  const handler = createItemImageHandler({ repo, ai, emit, storageDir });

  return {
    repo,
    hub,
    ai,
    gameId: game.id,
    teamId: joined.team.id,
    playerId: joined.player.id,
    storageDir,
    events,
    emit,
    handler,
  };
}

/** Fresh temp storage dir per test. */
const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function newStorageDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-items-"));
  tempDirs.push(dir);
  return dir;
}

async function itemsOf(repo: MemoryRepo, teamId: string): Promise<ItemRow[]> {
  return repo.listItems(teamId, 1);
}

describe("item-image worker (end-to-end: pipeline → queue → handler)", () => {
  it("mock path → item READY, file written, dims + visualWeight persisted, item:ready to the team", async () => {
    const s = await setup();
    const storageDir = await newStorageDir();
    const handler = createItemImageHandler({ repo: s.repo, ai: s.ai, emit: s.emit, storageDir });
    const queue = createMemoryImageQueue(handler);

    const deps = createPromptPipelineDeps({
      hub: s.hub,
      repo: s.repo,
      ai: s.ai,
      queue,
      emit: () => {},
      now: () => START,
      limits: { cooldownMs: 0 },
    });
    const res = await submitPrompt(deps, { gameId: s.gameId, playerId: s.playerId }, "a red balloon dog");
    expect(res).toMatchObject({ ok: true });
    const itemId = (res as { itemId: string }).itemId;

    // The queue drains in the background — poll for READY.
    await vi.waitFor(async () => {
      const rows = await itemsOf(s.repo, s.teamId);
      expect(rows[0]?.status).toBe("READY");
    });

    const item = (await itemsOf(s.repo, s.teamId))[0]!;
    const imageUrl = `/static/items/${itemId}.png`;
    expect(item).toMatchObject({
      status: "READY",
      imageUrl,
      width: expect.any(Number), // final (cropped) buffer — not the 256 source
      height: expect.any(Number),
      failReason: null,
    });
    expect(item.visualWeight).toBeGreaterThan(0);
    expect(item.visualWeight!).toBeLessThanOrEqual(1);

    // The file really exists at the storage dir and equals what the URL serves.
    const written = await readFile(path.join(storageDir, `${itemId}.png`));
    expect(written.length).toBeGreaterThan(0);

    // Exactly one worker event: item:ready to the TEAM (no owner-only).
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toEqual({
      event: "item:ready",
      payload: { itemId, imageUrl, width: expect.any(Number), height: expect.any(Number) },
      ctx: { gameId: s.gameId, teamId: s.teamId, playerId: s.playerId },
    });
    expect(itemReadySchema.parse(s.events[0].payload)).toBeTruthy();
  });

  it("AI outage → FAILED + item:failed to the OWNER only, no file, and FAILED does not count as in-flight", async () => {
    const s = await setup();
    const storageDir = await newStorageDir();
    const failingAi: AiRouter = {
      run: async (
        task: string,
        input: Record<string, unknown>,
        opts?: { gameId?: string },
      ) => {
        if (task === "item_image") {
          throw new AiTaskError({
            task: "item_image",
            retryable: false,
            message: "all image models failed",
          });
        }
        return s.ai.run(task, input, opts);
      },
    } as unknown as AiRouter;
    const handler = createItemImageHandler({ repo: s.repo, ai: failingAi, emit: s.emit, storageDir });
    const queue = createMemoryImageQueue(handler);

    const deps = createPromptPipelineDeps({
      hub: s.hub,
      repo: s.repo,
      ai: failingAi,
      queue,
      emit: () => {},
      now: () => START,
      limits: { cooldownMs: 0, maxInflightPerPlayer: 1 }, // 1 in-flight would block a 2nd
    });

    // Validation + moderation still pass (they delegate to the mock router);
    // the image step fails afterwards.
    const res = await submitPrompt(deps, { gameId: s.gameId, playerId: s.playerId }, "a red balloon dog");
    expect(res).toMatchObject({ ok: true });
    const itemId = (res as { itemId: string }).itemId;

    await vi.waitFor(async () => {
      const rows = await itemsOf(s.repo, s.teamId);
      expect(rows[0]?.status).toBe("FAILED");
    });
    const item = (await itemsOf(s.repo, s.teamId))[0]!;
    expect(item.failReason).toBe("all image models failed");
    expect(item.imageUrl).toBeNull();

    // No file written for the failed generation.
    expect(await readdir(storageDir)).toEqual([]);

    // Owner-only item:failed (the handler is the only s.events source here —
    // the pipeline's per-call emit is a no-op in these tests).
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toEqual({
      event: "item:failed",
      payload: { itemId, reason: "all image models failed" },
      ctx: { gameId: s.gameId, teamId: s.teamId, playerId: s.playerId },
    });
    expect(itemFailedSchema.parse(s.events[0].payload)).toBeTruthy();

    // Limits inference: FAILED stops counting as in-flight, so a resubmission
    // passes the maxInflightPerPlayer=1 cap (nothing to refund).
    const again = await submitPrompt(deps, { gameId: s.gameId, playerId: s.playerId }, "a snowman with a scarf");
    expect(again).toMatchObject({ ok: true });
  });

  it("REMOVED item (GM removed meanwhile) → skipped silently, no file, no events", async () => {
    const s = await setup();
    const storageDir = await newStorageDir();
    const handler = createItemImageHandler({ repo: s.repo, ai: s.ai, emit: s.emit, storageDir });

    const item = await s.repo.createItem({
      teamId: s.teamId,
      playerId: s.playerId,
      round: 1,
      promptRaw: "a red balloon dog",
      subject: "a red balloon dog",
      status: "GENERATING",
    });
    await s.repo.updateItem(item.id, { status: "REMOVED" });

    await handler({
      itemId: item.id,
      gameId: s.gameId,
      teamId: s.teamId,
      playerId: s.playerId,
      round: 1,
      prompt: "a red balloon dog",
      subject: "a red balloon dog",
    });

    expect((await s.repo.getItem(item.id))?.status).toBe("REMOVED");
    expect(await readdir(storageDir)).toEqual([]);
    expect(s.events).toEqual([]);
  });
});

describe("bg-removal", () => {
  it("mock stickers (already transparent) pass through byte-identical", async () => {
    const { base64 } = drawMockSticker("a red balloon dog");
    const buf = Buffer.from(base64, "base64");
    const res = await ensureTransparentPng(buf, "image/png");
    expect(res.changed).toBe(false);
    expect(res.mime).toBe("image/png");
    expect(res.buf.equals(buf)).toBe(true);
  });

  it("opaque PNG gets chroma-keyed to a transparent PNG", async () => {
    // 64x64 opaque WHITE background with a RED subject square in the middle.
    const sharp = (await import("sharp")).default;
    const bg = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    const subject = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    const opaque = await sharp(bg).composite([{ input: subject, top: 22, left: 22 }]).png().toBuffer();
    const res = await ensureTransparentPng(opaque, "image/png");
    expect(res.changed).toBe(true);
    const meta = await sharp(res.buf).metadata();
    expect(meta.hasAlpha).toBe(true);
    // White corners keyed out, red subject kept.
    const { data } = await sharp(res.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // top-left alpha
    const center = (32 * 64 + 32) * 4 + 3;
    expect(data[center]).toBe(255);
  });
});

describe("visual weight", () => {
  it("orders fully-opaque vivid > 30%-covered vivid > transparent", async () => {
    const sharp = (await import("sharp")).default;
    const red = { r: 255, g: 0, b: 0 };

    const opaque = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { ...red, alpha: 1 } },
    })
      .png()
      .toBuffer();

    // 30% coverage: red rows on top, fully transparent below.
    const partial = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 64, height: 20, channels: 4, background: { ...red, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const transparent = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const [wOpaque, wPartial, wTransparent] = await Promise.all([
      computeVisualWeight(opaque),
      computeVisualWeight(partial),
      computeVisualWeight(transparent),
    ]);
    expect(wOpaque).toBe(1); // pure red: coverage 1 × saturation 1
    expect(wPartial).toBeGreaterThan(0);
    expect(wPartial).toBeLessThan(wOpaque);
    expect(wTransparent).toBe(0);
  });

  it("is deterministic for the same input", async () => {
    const { base64 } = drawMockSticker("a birthday cake with candles");
    const buf = Buffer.from(base64, "base64");
    expect(await computeVisualWeight(buf)).toBe(await computeVisualWeight(buf));
  });
});

describe("die-cut post-processing in the worker", () => {
  it("full-bleed AI image → READY with frame-size dims, written file has transparent edges", async () => {
    const sharp = (await import("sharp")).default;
    const s = await setup();
    const storageDir = await newStorageDir();

    // Fake AI returning a FULL-BLEED transparent PNG: 128×128 canvas, opaque
    // artwork touching all 4 edges (transparent corners only).
    const raw = Buffer.alloc(128 * 128 * 4, 0);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        if (Math.abs(x - 64) < 20 || Math.abs(y - 64) < 20) {
          const p = (y * 128 + x) * 4;
          raw[p] = 200;
          raw[p + 1] = 30;
          raw[p + 2] = 30;
          raw[p + 3] = 255;
        }
      }
    }
    const fullBleed = await sharp(raw, { raw: { width: 128, height: 128, channels: 4 } })
      .png()
      .toBuffer();
    const fullBleedAi = {
      run: async () => ({
        data: {},
        imageBase64: fullBleed.toString("base64"),
        imageMime: "image/png",
      }),
    } as unknown as AiRouter;

    const item = await s.repo.createItem({
      teamId: s.teamId,
      playerId: s.playerId,
      round: 1,
      promptRaw: "a red balloon dog",
      subject: "a red balloon dog",
      status: "GENERATING",
    });
    const handler = createItemImageHandler({ repo: s.repo, ai: fullBleedAi, emit: s.emit, storageDir });
    await handler({
      itemId: item.id,
      gameId: s.gameId,
      teamId: s.teamId,
      playerId: s.playerId,
      round: 1,
      prompt: "a red balloon dog",
      subject: "a red balloon dog",
    });

    // USER DECISION (content crop): full-bleed content touching ALL edges →
    // nothing to crop → the final buffer IS the original frame (128×128);
    // its edge midpoints hold artwork (the crop removed margins, not added
    // them). Only the cross's transparent corners stay transparent.
    const row = await s.repo.getItem(item.id);
    expect(row).toMatchObject({ status: "READY", width: 128, height: 128 });
    expect(row?.imageUrl).toBe(`/static/items/${item.id}.png`);

    const written = await readFile(path.join(storageDir, `${item.id}.png`));
    const { data } = await sharp(written).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * 128 + x) * 4 + 3];
    expect(at(0, 0)).toBe(0); // cross's transparent corner
    expect(at(127, 127)).toBe(0);
    expect(at(64, 0)).toBe(255); // edge midpoint holds artwork (full-bleed)
    expect(at(0, 64)).toBe(255);
    expect(at(64, 64)).toBe(255);
  });
});