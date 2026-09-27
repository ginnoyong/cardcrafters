/**
 * Item-image worker handler (build-phase step 2) — the ImageQueue's job body.
 *
 * Flow for one job (the queue guarantees at-least-once, no retries at the
 * queue level — the AiRouter owns model retries/fallbacks):
 *   1. Load the item; STATUS GUARD: anything not GENERATING (e.g. REMOVED by
 *      the GM meanwhile) is skipped silently.
 *   2. ai.run('item_image', {prompt, subject}, {gameId}) — primary → retry →
 *      fallback happens inside the router.
 *   3. On success: decode base64 → ensureTransparentPng (bg-removal fallback
 *      for opaque results; already-transparent PNGs pass through untouched) →
 *      write public/static/items/{itemId}.png (filename = itemId only — a
 *      safe cuid, no user text in the path) → persist READY with imageUrl
 *      `/static/items/{itemId}.png` + real width/height (sharp metadata) +
 *      visualWeight → emit `item:ready` to the TEAM room.
 *   4. On ANY failure (AiTaskError after the chain, or unexpected): the item
 *      becomes FAILED + failReason and `item:failed` is emitted OWNER-ONLY
 *      (deps.emit ctx.playerId). Unexpected errors also console.error.
 *
 * LIMIT CONSUMPTION (verified inference, do not "fix" by refunding):
 *  - prompt-pipeline counts in-flight items from STATUS ROWS
 *    (VALIDATING|GENERATING, see its step 4). Once the row is FAILED it stops
 *    counting automatically — there is NOTHING to refund.
 *  - The submit cooldown is anchored at ACCEPT time (when the row became
 *    GENERATING) and is never touched by image generation outcomes.
 *
 * PROD NOTE (static files): items are written to apps/web/public/static/items
 * and served by Next from the public dir in dev AND prod (`next build` copies
 * public/, but files written AFTER the build are still served by the Next
 * server in dev; in a containerized prod build the dir must be writable and
 * ideally volume-mounted — TODO if the compose layout changes: the compose
 * file already only mounts the image build, so a volume for
 * /app/apps/web/public/static/items may be needed).
 * TODO(build-phase step 3): team + game (style) derivation lands with the
 * layout engine step — until then item_image is called WITHOUT a styleSuffix.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { ensureTransparentPng } from "../image/bg-remove";
import { computeVisualWeight } from "../image/weight";
import type { ImageJob } from "../queue/queue";
import type { Repository } from "../repo/repository";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/server/flows

/** Default storage dir: apps/web/public/static/items (Next public dir). */
export const DEFAULT_ITEMS_DIR = path.resolve(here, "../../../public/static/items");

/** Emission callback for worker outcomes; the ws layer maps ctx → rooms. */
export type ItemImageEmit = (
  event: "item:ready" | "item:failed",
  payload: Record<string, unknown>,
  ctx: { gameId: string; teamId: string; playerId: string },
) => void;

/** Structural AI surface (AiRouter satisfies; tests inject fakes). */
export interface ItemImageAi {
  run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<{
    data: unknown;
    imageBase64?: string;
    imageMime?: string;
    imageWidth?: number;
    imageHeight?: number;
  }>;
}

export interface ItemImageHandlerDeps {
  repo: Repository;
  ai: ItemImageAi;
  /** Socket-wired emitter (queue-level, not per-socket like the pipeline's). */
  emit: ItemImageEmit;
  /** Override for tests; default apps/web/public/static/items. */
  storageDir?: string;
}

/**
 * Build the worker handler for an ImageQueue. One instance per server; safe
 * to run concurrently (the queue caps parallelism, item rows are the truth).
 */
export function createItemImageHandler(
  deps: ItemImageHandlerDeps,
): (job: ImageJob) => Promise<void> {
  const storageDir = deps.storageDir ?? DEFAULT_ITEMS_DIR;

  return async function handleItemJob(job: ImageJob): Promise<void> {
    const ctx = { gameId: job.gameId, teamId: job.teamId, playerId: job.playerId };

    // Status guard: only a GENERATING item may be worked on (a resurrected or
    // REMOVED row is silently skipped — the pipeline re-enqueues on resubmit).
    const item = await deps.repo.getItem(job.itemId);
    if (!item || item.status !== "GENERATING") return;

    // TODO(build-phase step 3): derive styleSuffix from the game/theme
    // (style_derivation task) once the layout engine step lands.
    try {
      const res = await deps.ai.run(
        "item_image",
        { prompt: job.prompt, subject: job.subject },
        { gameId: job.gameId },
      );
      if (!res.imageBase64) throw new Error("provider returned no image data");

      const decoded = Buffer.from(res.imageBase64, "base64");
      const { buf } = await ensureTransparentPng(decoded, res.imageMime ?? "image/png");

      await mkdir(storageDir, { recursive: true });
      const fileName = `${job.itemId}.png`;
      await writeFile(path.join(storageDir, fileName), buf);

      // Dimensions from the FINAL buffer (authoritative after post-processing);
      // fall back to the provider-reported size if sharp can't read it.
      let width = res.imageWidth;
      let height = res.imageHeight;
      try {
        const meta = await sharp(buf).metadata();
        if (meta.width) width = meta.width;
        if (meta.height) height = meta.height;
      } catch {
        // keep provider dims
      }
      const visualWeight = await computeVisualWeight(buf);

      // Re-check the status: the GM may have REMOVED the item while the image
      // was generating — never resurrect a removed/terminal row.
      const fresh = await deps.repo.getItem(job.itemId);
      if (!fresh || fresh.status !== "GENERATING") return;

      const imageUrl = `/static/items/${fileName}`;
      await deps.repo.updateItem(job.itemId, {
        status: "READY",
        imageUrl,
        width: width ?? null,
        height: height ?? null,
        visualWeight,
      });
      deps.emit(
        "item:ready",
        {
          itemId: job.itemId,
          imageUrl,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
        ctx,
      );
    } catch (err) {
      // AiTaskError = the whole model chain failed (router already audited the
      // attempts in ai_calls). Anything else is unexpected — log it louder.
      if (!isAiTaskError(err)) {
        console.error(`[item-image] unexpected error for item ${job.itemId}:`, err);
      }
      const detail = err instanceof Error ? err.message : String(err);
      try {
        await deps.repo.updateItem(job.itemId, {
          status: "FAILED",
          failReason: detail,
        });
      } catch (updateErr) {
        console.error(`[item-image] could not mark item ${job.itemId} FAILED:`, updateErr);
        return;
      }
      // Owner-only: the team never sees other players' failures; the owner's
      // own UI clears the pending state. No live socket → skip (state is
      // visible on the next sync:full).
      deps.emit("item:failed", { itemId: job.itemId, reason: detail }, ctx);
    }
  };
}

function isAiTaskError(err: unknown): boolean {
  return err instanceof Error && err.name === "AiTaskError";
}