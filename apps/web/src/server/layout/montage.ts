/**
 * Final montage pass (plan step 6) — after SCORING entry, re-arrange every
 * team's settled build-phase layout as a MOVIE POSTER:
 *
 *   1. Render the SETTLED card to a PNG (same render pattern as the critique
 *      scheduler — deliberately WITHOUT `finalPass`: the vision model judges
 *      GEOMETRY, not the polish; feathering + grading are applied by the
 *      renderer later when the final card is produced).
 *   2. Ask the `layout_montage` VISION task for poster composition hints
 *      (the layout_composition contract + strategy + relaxOverlap).
 *   3. Re-solve with those hints; when the AI opted into `relaxOverlap`, the
 *      solver's overlap caps are inflated by MONTAGE_OVERLAP_RELAX_FACTOR.
 *   4. ADOPT ALWAYS (user decision): the montage solve is persisted whenever
 *      it succeeded — there is deliberately NO score comparison against the
 *      settled layout (the montage pass IS the final polish).
 *   5. Emit `layout:updated` with source "montage" (engine's payload shape).
 *
 * Failure policy — a montage problem must NEVER break scoring: every team is
 * processed under Promise.allSettled inside a per-team timeout
 * (MONTAGE_PASS_TIMEOUT_MS, injectable for tests via deps.timeoutMs); ANY
 * failure (render, AI, schema, solve, stale version write) is logged with
 * console.warn and the team keeps its settled build-phase layout. The pass
 * never throws.
 *
 * MOCK MODE (deps.mockMode || !deps.ai): deterministic SHORT-CIRCUIT —
 * nothing happens at all. No render, no AI call, no re-solve, no persistence,
 * no emit; the settled layout simply ships as the final card. Same policy as
 * the critique scheduler: tests and demo games must stay free, deterministic
 * and silent. Documented here so the absence of montage events in mock mode
 * is understood as intentional, not a gap.
 */

import {
  layoutMontageSchema,
  MONTAGE_OVERLAP_RELAX_FACTOR,
  MONTAGE_PASS_TIMEOUT_MS,
  type ContentBox,
} from "@cardcrafters/shared";

import type { Repository, ItemRow } from "../repo/repository";
import { renderCardPng, type RenderableItem } from "../render/card-render";
import { cardBox, baseFit, COORD_DIMS, type LayoutItem, type CardBox } from "./constraints";
import { defaultTextZone, type LayoutEmit } from "./engine";
import { solveLayout, mulberry32, hashString, type SolveOptions, type SolveResult } from "./solver";

/** Structural AI surface (AiRouter satisfies; tests inject fakes). */
export interface MontageAi {
  run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<{ data: unknown }>;
}

export interface MontageDeps {
  repo: Repository;
  /** Null (or mockMode) → short-circuit; never a hard dependency. */
  ai: MontageAi | null;
  /** True when the resolved provider is the deterministic mock. */
  mockMode: boolean;
  /** Full-routing emitter — same shape as the layout engine's emit. */
  emit: LayoutEmit;
  /** Sticker storage dir override (tests). Default: render module's default. */
  storageDir?: string;
  /**
   * Injectable per-team timeout for tests. Default MONTAGE_PASS_TIMEOUT_MS.
   * (Deviation note: the shared constant is NOT hardcoded here so the
   * timeout path can be exercised in milliseconds instead of 30s.)
   */
  timeoutMs?: number;
  /** Render seam for tests (default: the real PNG renderer). */
  render?: typeof renderCardPng;
}

/** Map repo item rows onto the solver's LayoutItem shape — the EXACT filter
 *  + mapping the layout engine uses (READY + sized only; orderIndex = list
 *  index; the repo already sorts by createdAt). */
function toLayoutItems(rows: Array<{
  id: string;
  width: number | null;
  height: number | null;
  visualWeight: number | null;
  subject: string | null;
  contentBox?: ContentBox | null;
}>): LayoutItem[] {
  return rows
    .filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0)
    .map((r, orderIndex) => ({
      id: r.id,
      imgW: r.width!,
      imgH: r.height!,
      visualWeight: r.visualWeight ?? 0,
      orderIndex,
      subject: r.subject ?? undefined,
      contentBox: r.contentBox ?? undefined,
    }));
}

/** Reject (or resolve) after ms; the underlying work keeps running in the
 *  background either way — a timed-out team's late result is simply ignored. */
function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[montage] ${label}: timed out after ${ms}ms`)), ms);
  });
  const work = run();
  // The timed-out work continues in the background; this swallow guarantees a
  // late rejection can never surface as an unhandledRejection (the race also
  // attaches its own handlers — this is belt & braces).
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run the final montage pass for every team of a game. Resolves when all
 * per-team passes have settled; NEVER rejects (failures are logged and the
 * affected team keeps its settled build-phase layout).
 */
export async function runMontagePass(deps: MontageDeps, gameId: string): Promise<void> {
  // -- MOCK MODE SHORT-CIRCUIT (see module doc) -----------------------------
  if (deps.mockMode || !deps.ai) return;

  const { repo } = deps;
  const teams = await repo.listTeams(gameId);
  if (teams.length === 0) return;
  const game = await repo.getGame(gameId);
  if (!game) return;
  const round = game.round;
  // Card geometry is game-level state; compute ONCE for the whole pass (the
  // engine computes it per team only because it runs per team).
  const card: CardBox = cardBox(COORD_DIMS, game.config.cardRatioW, game.config.cardRatioH);
  const render = deps.render ?? renderCardPng;
  const timeoutMs = deps.timeoutMs ?? MONTAGE_PASS_TIMEOUT_MS;

  // Sized READY items per team — game+round state, listed once and shared
  // with the worker (same listing order the engine's compute sees).
  const prepared = await Promise.all(
    teams.map(async (team) => ({
      teamId: team.id,
      rows: (await repo.listItems(team.id, round, ["READY"])).filter(
        (r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0,
      ),
    })),
  );
  // Gate: with NO team holding a sized READY item there is nothing to
  // montage — return silently (no render, no AI call, no emit).
  if (!prepared.some((p) => p.rows.length > 0)) return;

  // Per-team isolation: allSettled + per-team timeout + per-team catch — one
  // team's montage failure never affects (or waits on the rejection of)
  // another's, and the pass as a whole never throws.
  await Promise.allSettled(
    prepared.map((p) =>
      withTimeout(`team ${p.teamId}`, timeoutMs, () =>
        runForTeam(deps, gameId, p.teamId, round, game, card, p.rows, render),
      ).catch((err) =>
        console.warn(`[montage] team ${p.teamId} keeps its settled layout:`, err),
      ),
    ),
  );
}

/** The full montage pipeline for ONE team (gather → render → AI → solve →
 *  persist → emit). Throws are caught by the caller's per-team handler.
 *  `deps.ai` is non-null here — runMontagePass short-circuits before calling. */
async function runForTeam(
  deps: MontageDeps,
  gameId: string,
  teamId: string,
  round: number,
  game: NonNullable<Awaited<ReturnType<Repository["getGame"]>>>,
  card: CardBox,
  rows: ItemRow[],
  render: typeof renderCardPng,
): Promise<void> {
  const { repo } = deps;
  const items = toLayoutItems(rows);
  if (items.length === 0) return;

  // (a) The SETTLED build-phase layout — without one there is nothing to
  // improve (and no version to build on).
  const settled = await repo.getLayoutState(teamId, round);
  if (!settled) return;

  const k = baseFit(card);
  const textZone = defaultTextZone(card);
  const greeting = (await repo.listGreetings(gameId, round)).find((g) => g.teamId === teamId);

  // (b) Render the SETTLED card for the vision model — the critique
  // scheduler's exact call pattern, NO finalPass/grading: the AI judges
  // geometry, not the final polish.
  const png = await render(
    rows.map((r): RenderableItem => ({
      itemId: r.id,
      imageUrl: r.imageUrl,
      width: r.width!,
      height: r.height!,
    })),
    { placements: settled.placements },
    greeting?.text ?? "",
    {
      cardRatioW: game.config.cardRatioW,
      cardRatioH: game.config.cardRatioH,
      ...(deps.storageDir !== undefined ? { storageDir: deps.storageDir } : {}),
    },
  );

  // (c) Vision call — critique's image var naming (imageBase64/imageMime)
  // plus the layout_composition text vars the prompt template inlines.
  const res = await deps.ai!.run(
    "layout_montage",
    {
      imageBase64: png.toString("base64"),
      imageMime: "image/png",
      cardWidth: card.w,
      cardHeight: card.h,
      textHint: greeting?.text ?? "",
      items: items.map((i) => ({
        id: i.id,
        w: i.imgW,
        h: i.imgH,
        visualWeight: i.visualWeight,
        orderIndex: i.orderIndex,
        subject: i.subject ?? "",
      })),
    },
    { gameId },
  );
  // The AiRouter already validates layout_montage output through
  // TASK_SCHEMAS (and returns the PARSED data) — this re-parse is deliberate
  // belt & braces: injected fakes / custom routers can bypass that
  // validation, and the re-parse is what converts an unparseable payload
  // into the settled-layout fallback. Re-parsing an already-parsed payload
  // is idempotent and free.
  const hints = layoutMontageSchema.parse(res.data);

  // (d) Re-solve with the montage hints — the engine's exact call shape
  // (cardDims/k/textZone/rng), seeded distinctly ("montage" suffix) so the
  // final arrangement is not bit-identical to the build-phase solve.
  const opts: SolveOptions = {
    cardDims: card,
    k,
    textZone,
    hints,
    rng: mulberry32(hashString(`${teamId}:${round}:montage`)),
    ...(hints.relaxOverlap
      ? { overlapCapFactor: MONTAGE_OVERLAP_RELAX_FACTOR }
      : {}),
  };
  let solved: SolveResult;
  try {
    solved = solveLayout(items, opts);
  } catch (err) {
    console.warn(`[montage] solver failed for team ${teamId}:`, err);
    return;
  }
  if (solved.placements.length === 0) {
    console.warn(`[montage] team ${teamId}: solver placed nothing — keeping settled layout`);
    return;
  }

  // (f) ADOPT ALWAYS (user decision): the montage solve wins whenever it
  // succeeded — no score comparison. Version-monotonic write (the repo
  // rejects stale versions; a concurrent writer just wins this race).
  const version = settled.version + 1;
  try {
    await repo.upsertLayoutState(teamId, round, {
      version,
      placements: solved.placements,
      source: "montage",
      // greetingStyle parity with the engine: left undefined (fixed text
      // zone; the repo preserves any existing greetingStyle).
    });
  } catch (err) {
    console.warn(`[montage] stale write rejected for team ${teamId} — keeping settled layout:`, err);
    return;
  }

  // (g) Broadcast with the engine's payload shape, source stamped "montage".
  deps.emit(
    "layout:updated",
    { version, placements: solved.placements, source: "montage" },
    { gameId, teamId },
  );
}