/**
 * Montage accumulator (poster step) — fire-and-forget pass at SCORING entry.
 *
 * For every team of a game, ONCE per team+round:
 *   (a) patch the montage row to GENERATING + emit `montage:generating`
 *       (GM + presenter rooms);
 *   (b) run the `montage_prompt` AI task (theme / greeting / subjects from
 *       the card state + a minimal style-pack color/mood hint);
 *   (c) run the `montage_image` task with the poster prompt + the same
 *       style hint (NEVER the sticker item_image suffix — see styleHint
 *       below); the exact user prompt is persisted as promptText;
 *   (d) persist the image bytes using the SAME storage pattern as
 *       item-image.ts (PNG under public/static, public URL) → status READY +
 *       imageUrl, emit `montage:updated` {status:"ready", imageUrl} (team +
 *       presenter + GM rooms);
 *   (e) on ANY failure — AI error, timeout, AiBudgetExceededError (caught
 *       explicitly), moderation rejection — patch status FALLBACK +
 *       fallbackUsed:true and emit `montage:updated` {status:"fallback"}.
 *       NEVER throws.
 *
 * Budget: the AiRouter's budget guard runs BEFORE any provider call and
 * throws AiBudgetExceededError when the game's committed + reserved spend is
 * already at the ceiling — the accumulator catches it and converts the whole
 * team pass into a FALLBACK without spending a cent.
 *
 * Dedup: a module-level map keyed `gameId:teamId:round` holds the in-flight
 * promise; a second trigger while one runs is a NO-OP (same promise).
 *
 * MOCK MODE: unlike layout/montage.ts (which short-circuits silently), the
 * accumulator still runs end-to-end — the mock provider is deterministic and
 * costs $0, so the poster pipeline persists a real (procedural) image and
 * emits `montage:updated` {status:"ready"} in mock mode too. The accumulator
 * does NOT delegate to runMontagePass (that pass keeps its own behavior —
 * including the mock short-circuit — intact and untouched).
 *
 * Note on how this relates to runMontagePass: the layout-level montage pass
 * (layout/montage.ts) re-SOLVES the card's item PLACEMENTS as a poster; this
 * accumulator produces the standalone full-bleed POSTER IMAGE (montage_prompt
 * → montage_image) and persists it in the montage row for reload via
 * sync:full. They are sibling passes that both fire at scoring entry.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { montagePromptSchema } from "@cardcrafters/shared";

import { montageImagePrompt } from "../ai/openrouter-provider";
import type { Repository, ItemRow } from "../repo/repository";
import { AiBudgetExceededError } from "../ai/errors";
import type { MontageAi } from "../layout/montage";
import type { LayoutEmit } from "../layout/engine";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/server/flows

/** Default storage dir for montage posters: apps/web/public/static/montages
 *  (Next public dir — same pattern as item-image's DEFAULT_ITEMS_DIR). */
export const DEFAULT_MONTAGE_DIR = path.resolve(here, "../../../public/static/montages");

export interface MontageAccumulatorDeps {
  repo: Repository;
  /** Null AI → fail-open straight to FALLBACK without AI calls. */
  ai: MontageAi | null;
  /** True when the resolved provider is the deterministic mock. */
  mockMode: boolean;
  /** Full-routing emitter — same shape as the layout engine's emit. */
  emit: LayoutEmit;
  /** Montage storage dir override (tests). Default: DEFAULT_MONTAGE_DIR. */
  storageDir?: string;
  /** Injectable per-team timeout for tests. */
  timeoutMs?: number;
}

/** In-flight per team+round (module-level so repeated triggers dedup). */
const inFlight = new Map<string, Promise<void>>();

/** Test-only escape hatch: clear the dedup map between tests. */
export function resetMontageAccumulatorInFlight(): void {
  inFlight.clear();
}

/**
 * Run the montage accumulator for every team of a game. Resolves when all
 * per-team passes have settled; NEVER rejects.
 */
export async function runMontageAccumulator(
  deps: MontageAccumulatorDeps,
  gameId: string,
): Promise<void> {
  const { repo } = deps;
  const teams = await repo.listTeams(gameId);
  if (teams.length === 0) return;
  const game = await repo.getGame(gameId);
  if (!game) return;
  const round = game.round;

  // Per-team fire-and-forget with in-flight dedup: a second trigger while one
  // runs returns the SAME promise (no-op). allSettled keeps one team's
  // rejection from affecting the others; the pass as a whole never throws.
  await Promise.allSettled(
    teams.map((team) => {
      const key = `${gameId}:${team.id}:${round}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const p = runForTeam(deps, gameId, team.id, round).catch((err) =>
        console.warn(`[montage-accumulator] team ${team.id} failed:`, err),
      );
      inFlight.set(key, p);
      void p.finally(() => {
        if (inFlight.get(key) === p) inFlight.delete(key);
      });
      return p;
    }),
  );
}

/** One team's full poster pipeline — never throws (the caller also catches). */
async function runForTeam(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  round: number,
): Promise<void> {
  const { repo } = deps;

  try {
    // -- Gather card state (mirrors layout/montage.ts's data-gathering) -----
    const game = await repo.getGame(gameId);
    const greeting = (await repo.listGreetings(gameId, round)).find((g) => g.teamId === teamId);
    const items = await repo.listItems(teamId, round, ["READY"]);
    const sized = items.filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0);
    const style = game?.style ?? null;
    // COHESION GUARD: the style pack's imagePromptSuffix is written for
    // STICKER item images ("flat vector sticker illustration, white outline")
    // and must never reach the poster tasks — that language is what turned
    // the full-bleed poster back into loose die-cut stickers. The poster
    // chain gets only a minimal color/mood hint derived from the SAME style
    // pack (palette hexes + mood), keeping the deck's identity without the
    // sticker framing.
    const styleHint = style
      ? `palette ${style.palette.join(", ")}, ${style.mood} mood`
      : "";
    const theme = game?.theme ?? "";

    if (sized.length === 0 || !game) {
      // Nothing to poster-ize → fail-open straight to FALLBACK (no AI spend).
      throw new Error("no sized READY items to montage");
    }

    // (a) GENERATING + emit BEFORE any AI work (clients show the
    // "Generating poster…" indicator while the pass is in flight).
    await repo.upsertMontageState(teamId, round, { patch: { status: "GENERATING" } });
    deps.emit("montage:generating", { round, teamId }, { gameId, teamId });

    // -- Budget: the AiRouter checks committed + reserved BEFORE each call
    //    and throws AiBudgetExceededError before spending — caught in the
    //    catch below, converting this team's pass to FALLBACK at zero cost.

    // (b) montage_prompt — theme/greeting/subjects from card state + style
    // pack (same input keys the mock provider's canned generator reads).
    const promptRes = await deps.ai!.run(
      "montage_prompt",
      {
        theme,
        greeting: greeting?.text ?? "",
        subjects: sized.map((r) => r.subject ?? ""),
        styleHint,
      },
      { gameId },
    );
    // The router already validates montage_prompt through TASK_SCHEMAS and
    // returns the PARSED data; this re-parse is belt & braces against fakes.
    const parsed = montagePromptSchema.parse(promptRes.data);
    const posterPrompt = parsed.prompt;

    // (c) montage_image — the poster prompt + the minimal style hint (plus
    // the theme/greeting/subjects keys the mock provider's generator reads).
    // The EXACT user prompt the real provider sends is computed by the same
    // montageImagePrompt helper the provider itself uses — persisted below so
    // the GM can see precisely what the image model was asked to draw.
    const imagePromptText = montageImagePrompt({ prompt: posterPrompt, styleHint });
    const imageRes = await deps.ai!.run(
      "montage_image",
      {
        prompt: posterPrompt,
        styleHint,
        theme,
        greeting: greeting?.text ?? "",
        subjects: sized.map((r) => r.subject ?? ""),
      },
      { gameId },
    );
    if (!imageRes.imageBase64 || !imageRes.imageMime) {
      throw new Error("montage_image returned no image bytes");
    }

    // (d) Persist image bytes — the SAME storage pattern as item-image.ts:
    // PNG under the public/static storage root, subdir per game/team,
    // served at the matching /static/ URL (no user text in the path).
    const storageDir = deps.storageDir ?? DEFAULT_MONTAGE_DIR;
    const ext = imageRes.imageMime === "image/jpeg" ? "jpg" : "png";
    const fileName = `montage-${teamId}-${round}-${Date.now()}.${ext}`;
    const dir = path.join(storageDir, gameId, teamId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), Buffer.from(imageRes.imageBase64, "base64"));
    const imageUrl = `/static/montages/${gameId}/${teamId}/${fileName}`;

    await repo.upsertMontageState(teamId, round, {
      patch: {
        status: "READY",
        // promptText = the EXACT image-model prompt (poster prompt + style
        // hint) — the montage_prompt output is embedded verbatim inside it —
        // surfaced to the GM via sync:full + montage:updated ("View prompt").
        promptText: imagePromptText,
        imageUrl,
        imageSeq: round,
        fallbackUsed: false,
      },
    });
    deps.emit(
      "montage:updated",
      { round, teamId, status: "ready", imageUrl, promptText: imagePromptText },
      { gameId, teamId },
    );
  } catch (err) {
    // (e) Fail-open: ANY failure → FALLBACK (AiBudgetExceededError included —
    // logged distinctly since it means zero AI spend happened).
    if (err instanceof AiBudgetExceededError) {
      console.warn(
        `[montage-accumulator] team ${teamId} skips AI — budget exceeded: ${err.message}`,
      );
    } else {
      console.warn(
        `[montage-accumulator] team ${teamId} falls back:`,
        err instanceof Error ? err.message : err,
      );
    }
    await repo.upsertMontageState(teamId, round, {
      patch: { status: "FALLBACK", fallbackUsed: true, imageUrl: null },
    });
    deps.emit("montage:updated", { round, teamId, status: "fallback" }, { gameId, teamId });
  }
}
