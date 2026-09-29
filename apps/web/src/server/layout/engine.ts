/**
 * Layout engine (build-phase step 3) — IO orchestration around the pure
 * solver: gather READY items + greeting, ask the LLM for composition hints
 * (best-effort), solve, persist a versioned LayoutState and emit
 * `layout:updated`.
 *
 * Per compute (computeAndPersistLayout):
 *   1. Resolve team → game (round + card ratio from the GameRow config).
 *   2. Items: repo.listItems(teamId, round, ["READY"]) with real width/height,
 *      ordered by createdAt (the repo already sorts); orderIndex = list index.
 *   3. Greeting text zone: FIXED reserved rect — top third of the card,
 *      {x: 10%, y: 6%, w: 80%, h: 16%} of the card's normalized w/h. The
 *      greeting itself is rendered by the UI (step 4); the solver only needs
 *      the reserved area. (A measured text box can replace this later.)
 *   4. AI hints: ai.run('layout_composition', {cardWidth, cardHeight,
 *      textHint, items:[{id, w, h, visualWeight, orderIndex, subject}]},
 *      {gameId}) — ANY failure (AiTaskError, schema reject, budget) → hints = null and
 *      the layout proceeds solver-only. A layout NEVER fails because of AI.
 *   5. Solve with hints AND without; keep the better scoreLayout score
 *      (scored against the same ctx). source: "llm+solver" | "solver".
 *      (layoutUpdatedSchema's source is a free string; the LayoutSource
 *      union in types.ts predates this and is only used by client UIs.)
 *   6. Persist via repo.upsertLayoutState (version = previous + 1; the repo
 *      rejects stale versions, a race here just loses this write).
 *
 * Debounce (createLayoutDebouncer): per-team trailing-edge timer of
 * LAYOUT_DEBOUNCE_MS (1.5s) — rapid item:ready bursts collapse into ONE
 * compute. flushAll() runs every pending compute immediately (tests, shutdown).
 *
 * TODO(layout): greetingStyle is left undefined for now (fixed text zone);
 * wire suggestedGreetingStyle from the hints once the UI consumes it.
 */

import {
  layoutCompositionSchema,
  LAYOUT_DEBOUNCE_MS,
  type Placement,
  type ContentBox,
} from "@cardcrafters/shared";

import type { Repository } from "../repo/repository";
import { cardBox, baseFit, COORD_DIMS, type LayoutItem, type Rect } from "./constraints";
import { solveLayout, mulberry32, hashString } from "./solver";
import { scoreLayout, type ScoreContext } from "./score";

/** Structural AI surface (AiRouter satisfies; tests inject fakes). */
export interface LayoutAi {
  run(
    task: string,
    input: Record<string, unknown>,
    opts?: { gameId?: string },
  ): Promise<{ data: unknown }>;
}

/** Server→client emitter wired by the ws layer (hub stamps the envelope). */
export type LayoutEmit = (
  event: "layout:updated",
  payload: Record<string, unknown>,
  ctx: { gameId: string; teamId: string },
) => void;

export interface LayoutEngineDeps {
  repo: Repository;
  /** Optional: when absent (or failing) the layout runs solver-only. */
  ai: LayoutAi | null;
  emit: LayoutEmit;
}

export interface ComputedLayout {
  version: number;
  placements: Placement[];
  source: "llm+solver" | "solver";
}

/**
 * The FIXED reserved greeting zone: top third of the card — {x: 10%, y: 6%,
 * w: 80%, h: 16%} of the card's normalized width/height respectively.
 * Documented here so a future measured zone can replace it one-for-one.
 */
export function defaultTextZone(card: { w: number; h: number }): Rect {
  return { x: 0.1 * card.w, y: 0.06 * card.h, w: 0.8 * card.w, h: 0.16 * card.h };
}

/** Map repo item rows onto the solver's LayoutItem shape (READY + sized only). */
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

/**
 * Compute + persist + emit the layout for one team's current round.
 * Returns null when there is nothing to lay out, the team/game vanished, or
 * a concurrent writer already committed a newer version.
 */
export async function computeAndPersistLayout(
  deps: LayoutEngineDeps,
  gameId: string,
  teamId: string,
): Promise<ComputedLayout | null> {
  const { repo } = deps;
  const team = (await repo.listTeams(gameId)).find((t) => t.id === teamId);
  if (!team) return null;
  const game = await repo.getGame(gameId);
  if (!game) return null;
  const round = game.round;

  const items = toLayoutItems(await repo.listItems(teamId, round, ["READY"]));
  if (items.length === 0) return null;

  const card = cardBox(COORD_DIMS, game.config.cardRatioW, game.config.cardRatioH);
  const k = baseFit(card);
  const textZone = defaultTextZone(card);

  // Greeting text (only used as the LLM's textHint; the zone stays fixed).
  const greeting = (await repo.listGreetings(gameId, round)).find((g) => g.teamId === teamId);

  // -- AI hints (best-effort; NEVER fail the layout) -------------------------
  let hints = null;
  if (deps.ai) {
    try {
      const res = await deps.ai.run(
        "layout_composition",
        {
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
      hints = layoutCompositionSchema.parse(res.data);
    } catch {
      hints = null; // AiTaskError / budget / schema — solver-only fallback
    }
  }

  // -- Solve (with hints AND without; keep the better score) -----------------
  const sctx: ScoreContext = {
    card,
    k,
    textZone,
    focalPoint: hints?.focalPoint ?? null,
    clustered: hints ? hints.groups.length > 1 : false,
  };
  const seed = hashString(`${teamId}:${round}`);
  const scored = (r: { placements: Placement[]; score: number }): number => {
    // Re-score against the SAME ctx so the comparison is apples-to-apples.
    return scoreLayout(r.placements, items, sctx);
  };

  let winner: { placements: Placement[]; source: ComputedLayout["source"] };
  if (hints) {
    const withHints = solveLayout(items, {
      cardDims: card,
      k,
      textZone,
      hints,
      rng: mulberry32(seed),
    });
    const withoutHints = solveLayout(items, {
      cardDims: card,
      k,
      textZone,
      rng: mulberry32(seed),
    });
    winner =
      scored(withHints) <= scored(withoutHints)
        ? { placements: withHints.placements, source: "llm+solver" }
        : { placements: withoutHints.placements, source: "solver" };
  } else {
    const solo = solveLayout(items, { cardDims: card, k, textZone, rng: mulberry32(seed) });
    winner = { placements: solo.placements, source: "solver" };
  }

  // -- Persist (versioned, stale-writes rejected by the repo) ----------------
  const existing = await repo.getLayoutState(teamId, round);
  const version = (existing?.version ?? 0) + 1;
  try {
    await repo.upsertLayoutState(teamId, round, {
      version,
      placements: winner.placements,
      source: winner.source,
      // TODO(layout): wire hints?.suggestedGreetingStyle once the UI step
      // consumes greetingStyle (fixed text zone for now → leave undefined).
    });
  } catch (err) {
    // A concurrent compute won the version race — its state is newer, keep it.
    console.error(`[layout] stale write rejected for team ${teamId}:`, err);
    return null;
  }

  deps.emit("layout:updated", { version, placements: winner.placements, source: winner.source }, {
    gameId,
    teamId,
  });
  return { version, placements: winner.placements, source: winner.source };
}

// ---------------------------------------------------------------------------
// Debouncer
// ---------------------------------------------------------------------------

export interface LayoutDebouncer {
  /** Schedule (or reschedule) the trailing-edge compute for a team. */
  schedule(ctx: { gameId: string; teamId: string }): void;
  /** Run every pending compute immediately and clear the timers. */
  flushAll(): Promise<void>;
  /** Team keys with a pending timer (test introspection). */
  pending(): string[];
}

/**
 * Per-team trailing-edge debounce (LAYOUT_DEBOUNCE_MS = 1.5s): a new schedule
 * for the same team clears + restarts the timer, so a burst of item:ready
 * events collapses into one compute for the LAST call.
 */
export function createLayoutDebouncer(
  run: (ctx: { gameId: string; teamId: string }) => Promise<unknown>,
): LayoutDebouncer {
  const timers = new Map<string, { gameId: string; timer: ReturnType<typeof setTimeout> }>();

  function schedule(ctx: { gameId: string; teamId: string }): void {
    const existing = timers.get(ctx.teamId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(ctx.teamId);
      run(ctx).catch((err) =>
        console.error(`[layout] compute failed for team ${ctx.teamId}:`, err),
      );
    }, LAYOUT_DEBOUNCE_MS);
    timers.set(ctx.teamId, { gameId: ctx.gameId, timer });
  }

  async function flushAll(): Promise<void> {
    // Copy + clear first so late schedules start a fresh timer cycle.
    const entries = [...timers.entries()];
    for (const [, v] of entries) clearTimeout(v.timer);
    timers.clear();
    await Promise.allSettled(
      entries.map(([teamId, v]) =>
        run({ gameId: v.gameId, teamId }).catch((err) =>
          console.error(`[layout] flush compute failed for team ${teamId}:`, err),
        ),
      ),
    );
  }

  return { schedule, flushAll, pending: () => [...timers.keys()] };
}
