/**
 * Layout-critique scheduler (vision pass) — after a team's layout commits,
 * wait out a trailing buffer, render the card to a PNG, ask the VISION model
 * to judge the composition, and broadcast the verdict to the GM room.
 *
 * Pacing (the 5s buffer is the PRIMARY gate):
 *  - Trailing buffer (LAYOUT_CRITIQUE_BUFFER_MS = 5s): `schedule()` re-arms the
 *    team's single pending timer to now+5s — a sticker arriving within the
 *    buffer does NOT create a second critique, it pushes the existing one back
 *    (trailing edge, exactly the layout debouncer's semantics). Bursts
 *    therefore collapse into ONE critique of the settled card.
 *  - Rate limit (LAYOUT_CRITIQUE_MIN_INTERVAL_MS = 45s): safety net checked at
 *    fire time — a critique never runs for a team whose last one is < 45s old,
 *    even if layouts keep landing just outside the buffer.
 *
 * Mock mode (AI_MODE=mock / no AI wired): deterministic SHORT-CIRCUIT — the
 * fixed verdict {score: 80, issues: [], focalOk: true} is emitted WITHOUT
 * rendering or calling the router, so tests and demo games get critique
 * events with zero cost and zero nondeterminism.
 *
 * Low-score handling (v1, documented scope cut): when score < 55 or !focalOk
 * the scheduler RE-EMITS the current layout through the normal layout:updated
 * routing with source "critique:flagged" and the verdict attached as a
 * passthrough `critique` field. An actual alternate re-solve (forcing the
 * solver off its first answer) is deliberately OUT OF SCOPE for v1 — the GM
 * sees the flagged layout + issues and can intervene manually.
 *
 * All AI/render failures are swallowed (logged) — a critique problem must
 * NEVER break the build flow.
 */

import {
  LAYOUT_CRITIQUE_BUFFER_MS,
  LAYOUT_CRITIQUE_LOW_SCORE,
  LAYOUT_CRITIQUE_MIN_INTERVAL_MS,
  layoutCritiqueSchema,
  type LayoutCritique,
} from "@cardcrafters/shared";

import type { Repository } from "../repo/repository";
import { renderCardPng, type RenderableItem } from "../render/card-render";

/** Structural AI surface (AiRouter satisfies; tests inject fakes). */
export interface CritiqueAi {
  run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<{ data: unknown }>;
}

/** GM-room-only emitter for verdicts (the ws layer hub-stamps the envelope). */
export type CritiqueEmit = (
  event: "layout:critique",
  payload: Record<string, unknown>,
  ctx: { gameId: string; teamId: string },
) => void;

/** Full-routing emitter (team + presenter + GM rooms) for the flagged-layout
 *  re-emit; same signature as the layout engine's LayoutEmit. */
export type CritiqueLayoutEmit = (
  event: "layout:updated",
  payload: Record<string, unknown>,
  ctx: { gameId: string; teamId: string },
) => void;

/** The fixed mock-mode verdict (kept in ONE place; the mock provider returns
 *  the same shape if ever called directly). */
export const MOCK_CRITIQUE_VERDICT: LayoutCritique = { score: 80, issues: [], focalOk: true };

export interface CritiqueSchedulerDeps {
  repo: Repository;
  /** Null (or mockMode) → short-circuit; never a hard dependency. */
  ai: CritiqueAi | null;
  /** True when the resolved provider is the deterministic mock. */
  mockMode: boolean;
  emitCritique: CritiqueEmit;
  emitLayout?: CritiqueLayoutEmit;
  /** Sticker storage dir override (tests). Default: render module's default. */
  storageDir?: string;
  /** Injectable pacing for tests (defaults: shared constants). */
  bufferMs?: number;
  minIntervalMs?: number;
  /** Render seam for tests (default: the real PNG renderer). */
  render?: typeof renderCardPng;
}

export interface CritiqueScheduler {
  /** Arm (or re-arm) the trailing critique for a team. Called by the ws layer
   *  AFTER each layout:updated emit. */
  schedule(ctx: { gameId: string; teamId: string }): void;
  /** Clear all pending timers (server shutdown). In-flight fires finish. */
  dispose(): void;
  /** Team ids with a pending timer (test introspection). */
  pending(): string[];
}

/** Per-team scheduler state. */
interface CritiqueState {
  gameId: string;
  timer: ReturnType<typeof setTimeout>;
}

export function createCritiqueScheduler(deps: CritiqueSchedulerDeps): CritiqueScheduler {
  const bufferMs = deps.bufferMs ?? LAYOUT_CRITIQUE_BUFFER_MS;
  const minIntervalMs = deps.minIntervalMs ?? LAYOUT_CRITIQUE_MIN_INTERVAL_MS;
  const render = deps.render ?? renderCardPng;
  /** teamId → pending timer. */
  const timers = new Map<string, CritiqueState>();
  /** teamId → epoch ms of the last critique that actually RAN (fire time). */
  const lastCritiqueAt = new Map<string, number>();

  function schedule(ctx: { gameId: string; teamId: string }): void {
    // Trailing edge: clear + restart the single timer per team.
    const existing = timers.get(ctx.teamId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(ctx.teamId);
      void fire(ctx).catch((err) =>
        console.error(`[critique] fire failed for team ${ctx.teamId}:`, err),
      );
    }, bufferMs);
    timers.set(ctx.teamId, { gameId: ctx.gameId, timer });
  }

  async function fire(ctx: { gameId: string; teamId: string }): Promise<void> {
    const now = Date.now();
    const last = lastCritiqueAt.get(ctx.teamId);
    if (last !== undefined && now - last < minIntervalMs) {
      // Rate-limit safety net — the 5s buffer already gates bursts; this only
      // stops back-to-back critiques when layouts keep landing ~5s apart.
      return;
    }
    lastCritiqueAt.set(ctx.teamId, now);

    // -- mock short-circuit (no render, no AI call) --------------------------
    if (deps.mockMode || !deps.ai) {
      deps.emitCritique("layout:critique", { teamId: ctx.teamId, ...MOCK_CRITIQUE_VERDICT }, ctx);
      return;
    }

    // -- gather current card state -------------------------------------------
    const team = (await deps.repo.listTeams(ctx.gameId)).find((t) => t.id === ctx.teamId);
    if (!team) return;
    const game = await deps.repo.getGame(ctx.gameId);
    if (!game) return;
    const round = game.round;
    const layout = await deps.repo.getLayoutState(ctx.teamId, round);
    if (!layout || layout.placements.length === 0) return;
    const items: RenderableItem[] = (await deps.repo.listItems(ctx.teamId, round, ["READY"]))
      .filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0)
      .map((r) => ({ itemId: r.id, imageUrl: r.imageUrl, width: r.width!, height: r.height! }));
    const greeting = (await deps.repo.listGreetings(ctx.gameId, round)).find(
      (g) => g.teamId === ctx.teamId,
    );

    // -- render + vision call -------------------------------------------------
    const png = await render(
      items,
      { placements: layout.placements },
      greeting?.text ?? "",
      {
        cardRatioW: game.config.cardRatioW,
        cardRatioH: game.config.cardRatioH,
        ...(deps.storageDir !== undefined ? { storageDir: deps.storageDir } : {}),
      },
    );
    const res = await deps.ai.run(
      "layout_critique",
      {
        imageBase64: png.toString("base64"),
        imageMime: "image/png",
        layoutSummary: summarizeLayout(layout.placements, greeting?.text ?? ""),
      },
      { gameId: ctx.gameId },
    );
    const verdict = layoutCritiqueSchema.parse(res.data);

    deps.emitCritique("layout:critique", { teamId: ctx.teamId, ...verdict }, ctx);

    // -- low-score signal (v1: re-emit + flag; no alternate re-solve) --------
    if (verdict.score < LAYOUT_CRITIQUE_LOW_SCORE || !verdict.focalOk) {
      console.warn(
        `[critique] team ${ctx.teamId} flagged (score=${verdict.score}, focalOk=${verdict.focalOk}) — ` +
          "re-emitting the layout flagged; alternate re-solve is out of scope (v1)",
      );
      deps.emitLayout?.(
        "layout:updated",
        {
          version: layout.version,
          placements: layout.placements,
          source: "critique:flagged",
          critique: verdict,
        },
        ctx,
      );
    }
  }

  return {
    schedule,
    dispose() {
      for (const state of timers.values()) clearTimeout(state.timer);
      timers.clear();
    },
    pending: () => [...timers.keys()],
  };
}

/** Compact placement summary for the prompt (count + hero + raw placements). */
function summarizeLayout(
  placements: Array<{ itemId: string; x: number; y: number; scale: number; zIndex: number }>,
  greeting: string,
): string {
  const hero = placements.reduce<{ itemId: string; scale: number } | null>((best, p) => {
    if (!best || p.scale > best.scale) return { itemId: p.itemId, scale: p.scale };
    return best;
  }, null);
  return JSON.stringify({
    greetingLength: greeting.length,
    stickerCount: placements.length,
    hero: hero?.itemId ?? null,
    placements: placements.map((p) => ({ id: p.itemId, x: p.x, y: p.y, scale: p.scale, z: p.zIndex })),
  });
}
