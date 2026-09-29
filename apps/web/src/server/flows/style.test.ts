/**
 * Style flow tests — theme → style pack → per-sticker prompt injection.
 * Mock AI router; MemoryRepo; deterministic.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG, type StyleDerivation } from "@cardcrafters/shared";

import type { AiRouter } from "../ai/router";
import { createAiRouter } from "../ai/router";
import { GameHub } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";

import { createItemImageHandler } from "./item-image";
import { deriveGameStyle } from "./style";

/** RoomEmitter stub: hub emits land nowhere (these tests read state only). */
const silentIo = { to: () => ({ emit: () => {} }) };

async function setup() {
  const repo = new MemoryRepo();
  const hub = new GameHub(repo, silentIo);
  const ai = await createAiRouter({
    repo,
    env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
  });
  const { game } = await hub.createGame(DEFAULT_CARD_CONFIG, { teamCount: 2 });
  return { repo, hub, ai, gameId: game.id };
}

describe("deriveGameStyle", () => {
  it("derives + persists a style pack from the theme", async () => {
    const s = await setup();
    await s.hub.applyEvent(s.gameId, { type: "gm:setTheme", theme: "Noel's 70th birthday", now: 1000 });

    const res = await deriveGameStyle(s.hub, s.repo, s.ai, s.gameId);
    expect(res.ok).toBe(true);
    expect(res.style).toMatchObject({
      styleName: expect.any(String),
      imagePromptSuffix: expect.any(String),
    });

    const row = await s.repo.getGame(s.gameId);
    expect(row?.style).toMatchObject({ imagePromptSuffix: expect.any(String) });
  });

  it("is non-fatal on AI failure (ok:false, nothing persisted)", async () => {
    const s = await setup();
    await s.hub.applyEvent(s.gameId, { type: "gm:setTheme", theme: "T", now: 1000 });
    const failing: AiRouter = {
      run: () => Promise.reject(new Error("mock AI outage")),
    } as unknown as AiRouter;
    const res = await deriveGameStyle(s.hub, s.repo, failing, s.gameId);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("outage");
    expect((await s.repo.getGame(s.gameId))?.style).toBeNull();
  });

  it("without a theme → ok:false", async () => {
    const s = await setup();
    expect((await deriveGameStyle(s.hub, s.repo, s.ai, s.gameId)).ok).toBe(false);
  });

  it("the image worker injects the style suffix into item_image input", async () => {
    const s = await setup();
    await s.hub.applyEvent(s.gameId, { type: "gm:setTheme", theme: "Noel's 70th", now: 1000 });
    await deriveGameStyle(s.hub, s.repo, s.ai, s.gameId);
    const style = ((await s.repo.getGame(s.gameId))?.style ?? null) as StyleDerivation | null;

    const team = (await s.repo.listTeams(s.gameId))[0]!;
    const item = await s.repo.createItem({
      teamId: team.id,
      playerId: "p1",
      round: 1,
      promptRaw: "golden retriever",
      subject: "golden retriever",
      status: "GENERATING",
    });

    let captured: Record<string, unknown> | null = null;
    const capturingAi: AiRouter = {
      run: async (task: Parameters<AiRouter["run"]>[0], input: Record<string, unknown>, opts?: { gameId?: string }) => {
        if (task === "item_image") {
          captured = input;
          // No image data → the worker's failure path (item FAILED) — fine:
          // the capture happened first, which is what this test asserts.
          return { data: {} };
        }
        return s.ai.run(task, input, opts);
      },
    } as unknown as AiRouter;

    const handler = createItemImageHandler({
      repo: s.repo,
      ai: capturingAi,
      emit: () => {},
      getStyle: async () => style,
    });
    await handler({
      itemId: item.id,
      gameId: s.gameId,
      teamId: team.id,
      playerId: "p1",
      round: 1,
      prompt: "golden retriever",
      subject: "golden retriever",
    });

    expect(captured).not.toBeNull();
    expect((captured as unknown as { styleSuffix?: string }).styleSuffix).toBe(style?.imagePromptSuffix);
  });
});