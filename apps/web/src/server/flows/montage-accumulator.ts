/**
 * Montage accumulator (poster step) — STAGING-DRIVEN poster generation.
 *
 * Lifecycle per team+round:
 *   1. STAGE — the prompt pipeline calls {@link stageMontageInput} for EVERY
 *      validated (ACCEPTED) submission, regardless of the sticker image
 *      outcome. The input is atomically appended to the montage row's
 *      stagedInputs (seq++ in the same operation) and a gen pass is started
 *      if none is running (dedup).
 *   2. GEN PASS — reads the CURRENT stagedInputs snapshot (falling back to
 *      sized READY items only when nothing was ever staged — legacy/seeded
 *      cards), patches GENERATING + emits `montage:generating` BEFORE any AI
 *      work, runs montage_prompt → montage_image under the per-pass timeout
 *      (deps.timeoutMs, default 90s; the greeting rides BOTH inputs — the
 *      poster prompt renders it as part of the artwork per the montage_prompt
 *      template, and the image task receives it directly), applies the
 *      style-derived grading to the poster (gradePoster — BOTH modes; the
 *      mock poster already bakes the greeting, real mode gets it from the
 *      image model itself; on grading failure the raw poster is persisted
 *      READY with a non-fatal lastError marker), normalizes the final bytes
 *      to the game's card ratio (normalizePosterToCardRatio — sharp resize
 *      fit "cover" to the exact card-ratio box, e.g. 800×1067 for the 3:4
 *      default; the UI box is locked to that ratio, so the persisted file
 *      must match it even when grading fell back to raw bytes. For default
 *      games this is a pure backstop — the pipeline generates natively at
 *      3:4 — but it stays for non-3:4 sources), persists the bytes exactly
 *      like item-image.ts and sets status READY + imageSeq = the SNAPSHOT seq
 *      (NOT the round) + promptText = the EXACT montageImagePrompt output.
 *   3. TRAILING EDGE — staging that lands DURING a pass is picked up by the
 *      next loop iteration (seq > imageSeq again), so the poster converges
 *      on the final staged set without duplicate concurrent passes.
 *   4. FAIL-OPEN — on ANY failure (AI error, timeout, AiBudgetExceededError,
 *      moderation/no-input) the row is patched FALLBACK + lastError and
 *      `montage:updated` {status:"fallback", error, promptText} is emitted;
 *      promptText carries the ATTEMPTED prompt when one was generated so the
 *      GM's "View prompt" toggle works even after an image failure. The pass
 *      also advances imageSeq to the snapshot seq so a failing pass cannot
 *      loop forever (new staging re-arms a retry naturally).
 *   5. FINALIZE — {@link finalizeMontageAll} runs in the hub's preScoring
 *      hook: teams with an in-flight pass get ONE guaranteed extra pass over
 *      the staged-at-that-moment inputs (finalPending); idle teams with
 *      un-posted staging (or no row at all — legacy/seeded content, or a
 *      team with nothing, which fails open to FALLBACK exactly like the old
 *      unconditional accumulator) get one final gen; already-current teams
 *      are skipped (no gen, no montage:updated).
 *
 * Budget: the AiRouter's budget guard runs BEFORE any provider call and
 * throws AiBudgetExceededError when the game's committed + reserved spend is
 * already at the ceiling — the pass catches it and converts to FALLBACK
 * without spending a cent.
 *
 * MOCK MODE: unlike layout/montage.ts (which short-circuits silently), the
 * accumulator runs end-to-end in mock mode — the mock provider is
 * deterministic and costs $0, so demo games still get a poster. Mock mode
 * flows through the SAME loop (deps.mockMode is informational only).
 *
 * Note on how this relates to runMontagePass: the layout-level montage pass
 * (layout/montage.ts) re-SOLVES the card's item PLACEMENTS as a poster; this
 * accumulator produces the standalone full-bleed POSTER IMAGE (montage_prompt
 * → montage_image) and persists it in the montage row for reload via
 * sync:full. They are sibling passes that both fire around scoring entry.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { montagePromptSchema, type MontageGrading } from "@cardcrafters/shared";

import { montageImagePrompt } from "../ai/openrouter-provider";
import type { Repository, MontageInput } from "../repo/repository";
import { AiBudgetExceededError } from "../ai/errors";
import type { MontageAi } from "../layout/montage";
import type { LayoutEmit } from "../layout/engine";
import { gradePoster, deriveGradingFromStyle } from "../render/card-render";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/server/flows

/** Default storage dir for montage posters: apps/web/public/static/montages
 *  (Next public dir — same pattern as item-image's DEFAULT_ITEMS_DIR). */
export const DEFAULT_MONTAGE_DIR = path.resolve(here, "../../../public/static/montages");

/** Default per-gen-pass AI timeout (Promise.race around the AI chain). */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Canonical poster width for the persisted montage PNG. The procedural mock
 * poster renders at 800×1066 (3:4) and the card stage draws at the same
 * scale, so 800 is the natural base width for the normalized file.
 */
const POSTER_TARGET_WIDTH = 800;

/** Aspect tolerance below which a source already counts as card-ratio. */
const POSTER_ASPECT_TOLERANCE = 0.01;

/**
 * Normalize the AI poster to the game's card ratio — the hard guarantee that
 * the PERSISTED file matches the UI box, independent of gradePoster. Real
 * image models return whatever aspect they choose (often 1024×1024 square or
 * landscape); the UI renders the poster in a box locked to
 * cardRatioW/cardRatioH with object-fit: cover, which crops the model's
 * output on the client and cuts off the lower-third greeting. Fixing the
 * aspect SERVER-SIDE means every consumer (card face, rating carousel,
 * presenter stage) sees the exact ratio with zero client-side cropping.
 *
 * Target dims: width fixed at {@link POSTER_TARGET_WIDTH} (800), height
 * derived from the game's cardRatioW/H — for the default 3:4 card that is
 * 800×1067 (Math.round of 1066.67), matching the card ratio within a
 * half-pixel. `fit: "cover"` + `position: "bottom"` crops the source into
 * that box: a wider-than-3:4 source loses its sides equally (the greeting
 * is centered, so it survives); a taller-than-3:4 source is anchored at the
 * BOTTOM, so only decorative top scenery is trimmed and the greeting band
 * at the bottom is always kept in full.
 *
 * For default games this is a PURE BACKSTOP: the pipeline generates posters
 * natively at the card ratio (3:4 is natively supported by the Gemini image
 * endpoints and requested via aspect_ratio), so native 3:4 sources at
 * canonical-or-larger width skip normalization via the checks below. The
 * resize only kicks in for non-3:4 sources (fallback models, custom card
 * ratios, degraded paths) and for sub-canonical sources that gradePoster's
 * crop-only pass shrank to a tiny exact-ratio file (e.g. a 64×64 square
 * fixture center-cropped to 48×64 — exact ratio, but far below the
 * canonical width the persisted poster must carry).
 *
 * Returns null (no-op) when the ratio is missing/invalid, the bytes don't
 * decode, or the source is already card-ratio within tolerance at
 * canonical-or-larger width — the caller then persists the bytes as-is
 * (fail-open, same philosophy as gradePoster's cropToCardRatio). Callers
 * should wrap in try/catch anyway: any throw here means the raw bytes get
 * persisted instead.
 */
export async function normalizePosterToCardRatio(
  bytes: Buffer,
  cardRatioW?: number,
  cardRatioH?: number,
): Promise<Buffer | null> {
  if (!cardRatioW || !cardRatioH || cardRatioW <= 0 || cardRatioH <= 0) return null;
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) return null;
  const targetW = POSTER_TARGET_WIDTH;
  const targetH = Math.round((POSTER_TARGET_WIDTH * cardRatioH) / cardRatioW);
  if (targetW < 1 || targetH < 1) return null;
  // Already canonical: exactly at the target box, or card-ratio within
  // tolerance at canonical-or-larger width (e.g. the mock's procedural
  // 800×1066 poster — its 0.7505 aspect is within tolerance of the exact
  // 800×1067 box) → no re-encode needed. A sub-canonical exact-ratio file
  // (tiny fixture or a cropped-down thumbnail) is still upscaled to the
  // canonical box: the persisted poster must always be 800-wide.
  const nativeAspect = meta.width / meta.height;
  const targetAspect = cardRatioW / cardRatioH;
  if (
    (meta.width === targetW && meta.height === targetH) ||
    (Math.abs(nativeAspect - targetAspect) <= POSTER_ASPECT_TOLERANCE &&
      meta.width >= targetW)
  ) {
    return null;
  }
  return sharp(bytes)
    .resize(targetW, targetH, { fit: "cover", position: "bottom" })
    .png()
    .toBuffer();
}

/**
 * Computed text-size hint for the montage_prompt template, from the greeting's
 * character count (trimmed). The image model renders the greeting at a FIXED
 * size regardless of length, so a long greeting overflows the lower-third band
 * and gets cropped at the bottom edge. The hint scales INVERSELY with the
 * character count (more chars → smaller text) and is passed as the
 * `textSizeHint` input so the template can tell the model how LARGE to render
 * the text so it always fits.
 *
 * Tier boundaries (20/40/80) are sized so the text always fits: the
 * lower-third band is ~33% of the image height; at the 3:4 card ratio with a
 * 3:4 native render (800×1066) the band is ~355px tall (1066/3), so at 4% per line
 * that's ~8 lines of headroom — plenty. The key constraint is
 * N_chars / chars_per_line × line_height_pct ≤ 33%.
 */
export function textSizeHint(greeting: string): string {
  const n = greeting.trim().length;
  if (n <= 20) {
    return "Render the greeting text LARGE — each line approximately 10% of the image height, fitting the full greeting in 1-2 lines within the lower-third band.";
  }
  if (n <= 40) {
    return "Render the greeting text at MEDIUM size — each line approximately 6% of the image height, fitting the full greeting in 2 lines within the lower-third band.";
  }
  if (n <= 80) {
    return "Render the greeting text at SMALL size — each line approximately 4% of the image height, fitting the full greeting in 2-3 lines within the lower-third band.";
  }
  return "Render the greeting text at COMPACT size — each line approximately 2.5% of the image height, fitting the full greeting in 3-4 tightly-spaced lines within the lower-third band. Do NOT let the text extend below the lower-third boundary.";
}

export interface MontageAccumulatorDeps {
  repo: Repository;
  /** Null AI → fail-open straight to FALLBACK without AI calls. */
  ai: MontageAi | null;
  /** True when the resolved provider is the deterministic mock (informational —
   *  mock mode flows through the same loop; nothing short-circuits here). */
  mockMode: boolean;
  /** Full-routing emitter — same shape as the layout engine's emit. */
  emit: LayoutEmit;
  /** Montage storage dir override (tests). Default: DEFAULT_MONTAGE_DIR. */
  storageDir?: string;
  /** Per-gen-pass AI timeout (Promise.race). Default: 90s. */
  timeoutMs?: number;
  /** Poster grading seam (tests): defaults to gradePoster
   *  (render/card-render). Inject a failing or observing fn to exercise the
   *  grading fallback / skip paths. The game's cardRatioW/H are forwarded so
   *  the real gradePoster can center-crop the poster to the card ratio at
   *  the source (real image models return varying aspects — often square). */
  gradePoster?: (
    posterPng: Buffer,
    grading: MontageGrading,
    cardRatioW?: number,
    cardRatioH?: number,
  ) => Promise<Buffer>;
}

/** What the prompt pipeline stages per ACCEPTED submission. */
export interface StageMontageInput {
  itemId: string;
  promptRaw: string;
  subject: string;
  playerId: string;
  nickname: string;
}

/** In-flight per team+round (module-level so repeated triggers dedup). */
const inFlight = new Map<string, Promise<void>>();

/** Keys whose finalize requested ONE guaranteed extra pass (see finalizeMontageAll). */
const finalPending = new Set<string>();

const keyOf = (gameId: string, teamId: string, round: number): string =>
  `${gameId}:${teamId}:${round}`;

/** Test-only escape hatch: clear the dedup state between tests. */
export function resetMontageAccumulatorInFlight(): void {
  inFlight.clear();
  finalPending.clear();
}

// ---------------------------------------------------------------------------
// Staging + triggering
// ---------------------------------------------------------------------------

/**
 * Append one accepted player input to the team's montage row for the CURRENT
 * round and start a gen pass if none is running (dedup). The staged entry's
 * `seq` mirrors the row's post-append seq counter (a concurrent staging from
 * a teammate can interleave the read/write — benign: the row's own seq stays
 * the source of truth, the entry seq is informational).
 */
export async function stageMontageInput(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  input: StageMontageInput,
): Promise<void> {
  const game = await deps.repo.getGame(gameId);
  if (!game) return;
  const round = game.round;
  const current = await deps.repo.getMontageState(teamId, round);
  await deps.repo.upsertMontageState(teamId, round, {
    input: { ...input, seq: (current?.seq ?? 0) + 1 },
  });
  await maybeStart(deps, gameId, teamId, round);
}

/**
 * Start a gen pass for the team+round unless one is already running or the
 * row is already current (seq === imageSeq). Awaits the pass it starts (all
 * production callers either void this or are finalize) so staging latency is
 * observable; never rejects — the pass converts failures to FALLBACK.
 */
export async function maybeStart(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  round: number,
): Promise<void> {
  const key = keyOf(gameId, teamId, round);
  if (inFlight.has(key)) return;
  const state = await deps.repo.getMontageState(teamId, round);
  // A row that doesn't exist yet is always "un-posted" — the pass fails open
  // to FALLBACK for teams with nothing (same as the old unconditional pass).
  if (state && state.seq <= (state.imageSeq ?? 0)) return;
  await ensureRunning(deps, gameId, teamId, round);
}

/**
 * Run the team's gen loop until the montage row is current: one pass, then —
 * trailing edge — another whenever staging landed during the previous pass
 * (seq > imageSeq again). The loop (not the caller) owns the in-flight
 * lifecycle so finalize can await the WHOLE trailing chain deterministically.
 */
async function driveTeam(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  round: number,
): Promise<void> {
  const key = keyOf(gameId, teamId, round);
  for (;;) {
    const state = await deps.repo.getMontageState(teamId, round);
    const unposted = state === null || state.seq > (state.imageSeq ?? 0);
    const finalPass = finalPending.has(key);
    if (!unposted && !finalPass) return;
    // Consume the finalize request: ONE guaranteed extra pass, no further loop.
    if (finalPass) finalPending.delete(key);
    await runGenPass(deps, gameId, teamId, round, {
      seq: state?.seq ?? 0,
      stagedInputs: state ? [...state.stagedInputs] : [],
    });
  }
}

/** Start the team's gen loop if not running; returns the loop's promise. */
function ensureRunning(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  round: number,
): Promise<void> {
  const key = keyOf(gameId, teamId, round);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = driveTeam(deps, gameId, teamId, round).catch((err) =>
    console.warn(`[montage-accumulator] team ${teamId} (game ${gameId}) failed:`, err),
  );
  inFlight.set(key, p);
  void p.finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  return p;
}

// ---------------------------------------------------------------------------
// Finalize (preScoring hook)
// ---------------------------------------------------------------------------

/**
 * Final montage pass at SCORING entry, per team:
 *   - in flight → set finalPending: when the running gen completes it runs
 *     ONE more pass over the staged-at-that-moment inputs (consumed by the
 *     loop; no further loop);
 *   - idle + un-posted staging (seq > imageSeq) or no row → one final gen;
 *   - idle + current (seq === imageSeq) → skip (no gen, no montage:updated).
 * Resolves when every team's chain has settled; NEVER rejects.
 */
export async function finalizeMontageAll(
  deps: MontageAccumulatorDeps,
  gameId: string,
): Promise<void> {
  const game = await deps.repo.getGame(gameId);
  if (!game) return;
  const round = game.round;
  const teams = await deps.repo.listTeams(gameId);
  if (teams.length === 0) return;
  await Promise.allSettled(
    teams.map(async (team) => {
      const key = keyOf(gameId, team.id, round);
      const running = inFlight.get(key);
      if (running) {
        // If the loop already exited before the flag landed, the
        // ensureRunning below consumes it instead — either way exactly one
        // extra pass runs.
        finalPending.add(key);
        await running;
      }
      await ensureRunning(deps, gameId, team.id, round);
    }),
  );
}

// ---------------------------------------------------------------------------
// One gen pass
// ---------------------------------------------------------------------------

/** The stagedInputs snapshot a gen pass was started against. */
interface GenSnapshot {
  seq: number;
  stagedInputs: MontageInput[];
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One team poster pipeline over the given snapshot — NEVER throws (the
 * caller's loop also catches, belt & braces).
 */
async function runGenPass(
  deps: MontageAccumulatorDeps,
  gameId: string,
  teamId: string,
  round: number,
  snapshot: GenSnapshot,
): Promise<void> {
  const { repo } = deps;
  // The EXACT user prompt the image model was asked (montageImagePrompt over
  // the poster prompt + style hint) — persisted + emitted even on failure so
  // the GM's "View prompt" transparency toggle survives an image outage.
  let attemptedPromptText: string | null = null;
  try {
    const game = await repo.getGame(gameId);
    const greeting = (await repo.listGreetings(gameId, round)).find(
      (g) => g.teamId === teamId,
    );
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
    // Text-size hint for the greeting: scales INVERSELY with the greeting's
    // character count so the image model renders it small enough to stay
    // inside the lower-third band (long greetings were cropped at the bottom
    // edge when the model used its default fixed size).
    const sizeHint = textSizeHint(greeting?.text ?? "");

    // Subjects come from the stagedInputs snapshot taken when this pass was
    // scheduled; sized READY items are the fallback ONLY when nothing was
    // ever staged (legacy/seeded cards).
    let subjects: string[];
    if (snapshot.stagedInputs.length > 0) {
      subjects = snapshot.stagedInputs.map((i) => i.subject);
    } else {
      const items = await repo.listItems(teamId, round, ["READY"]);
      const sized = items.filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0);
      if (sized.length === 0 || !game) {
        // Nothing to poster-ize → fail-open straight to FALLBACK (no AI spend).
        throw new Error("no sized READY items to montage");
      }
      subjects = sized.map((r) => r.subject ?? "");
    }

    if (!deps.ai) {
      throw new Error("AI router unavailable — cannot generate poster");
    }

    // (a) GENERATING + emit BEFORE any AI work (clients show the
    // "Generating poster…" indicator while the pass is in flight).
    await repo.upsertMontageState(teamId, round, { patch: { status: "GENERATING" } });
    deps.emit("montage:generating", { round, teamId }, { gameId, teamId });

    // -- Budget: the AiRouter checks committed + reserved BEFORE each call
    //    and throws AiBudgetExceededError before spending — caught in the
    //    catch below, converting this team's pass to FALLBACK at zero cost.

    // (b)+(c) montage_prompt → montage_image under the per-pass timeout
    // (deps.timeoutMs, default 90s). The EXACT image-model prompt is computed
    // by the same montageImagePrompt helper the real provider uses and is
    // captured as soon as it exists (survives an image-stage failure/timeout).
    // tsc CFA note: assigning through the outer `let` inside the async
    // callback leaves the variable narrowed to its `null` initializer after
    // the await (never at the guard below) — return the result through the
    // promise instead so the type flows out of withTimeout.
    const imageRes = await withTimeout(
      (async () => {
        const promptRes = await deps.ai!.run(
          "montage_prompt",
          {
            theme,
            greeting: greeting?.text ?? "",
            subjects,
            styleHint,
            textSizeHint: sizeHint,
          },
          { gameId },
        );
        // The router already validates montage_prompt through TASK_SCHEMAS and
        // returns the PARSED data; this re-parse is belt & braces against fakes.
        const parsed = montagePromptSchema.parse(promptRes.data);
        const posterPrompt = parsed.prompt;
        attemptedPromptText = montageImagePrompt({ prompt: posterPrompt, styleHint });
        return await deps.ai!.run(
          "montage_image",
          {
            prompt: posterPrompt,
            styleHint,
            theme,
            greeting: greeting?.text ?? "",
            subjects,
          },
          { gameId },
        );
      })(),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "montage AI chain",
    );
    if (!imageRes || !imageRes.imageBase64 || !imageRes.imageMime) {
      throw new Error("montage_image returned no image bytes");
    }
    const { imageBase64, imageMime } = imageRes;
    const rawBytes = Buffer.from(imageBase64, "base64");

    // POSTER GRADING — BOTH modes run the style-derived grading pass so real
    // and mock posters carry the same color cast/vignette treatment (the
    // greeting itself now arrives INSIDE the artwork: the montage_prompt
    // template tells the image model to render it verbatim as the lower-third
    // title treatment, and the mock's procedural poster bakes it too — no
    // client-side compositing step anymore).
    // Degraded-but-ready: if grading throws (decode failure, canvas error)
    // the RAW poster bytes are persisted anyway — an ungraded poster beats
    // no poster — and the pass still completes READY with a NON-FATAL
    // lastError marker ("poster saved without grading: …") so the GM can see
    // why the poster looks ungraded (surfaced via sync:full, which includes
    // lastError for GM rows regardless of status). The marker is non-fatal:
    // the state is READY, not FALLBACK.
    let posterBytes: Buffer = rawBytes;
    let gradeErrorMessage: string | null = null;
    try {
      const grade = deps.gradePoster ?? gradePoster;
      // The game's card ratio rides along: the real gradePoster grades AND
      // center-crops the poster to cardRatioW/H (source-side aspect
      // normalization — every UI box assumes the card ratio, so the persisted
      // file must match it). game may be null (fail-open path below keeps
      // the raw bytes anyway).
      posterBytes = await grade(
        rawBytes,
        deriveGradingFromStyle(style, teamId),
        game?.config.cardRatioW,
        game?.config.cardRatioH,
      );
    } catch (err) {
      posterBytes = rawBytes;
      gradeErrorMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        `[montage-accumulator] game ${gameId} team ${teamId} round ${round} poster grading failed — persisting the raw poster READY without grading:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
    const lastErrorMessage =
      gradeErrorMessage === null
        ? null
        : `poster saved without grading: ${gradeErrorMessage}`;

    // ASPECT NORMALIZATION (runGenPass) — the hard guarantee that the
    // persisted file matches the game's card ratio, applied to the FINAL
    // bytes regardless of how grading went. gradePoster already center-crops
    // on the success path, but its failure fallback persists the RAW bytes at
    // the model's arbitrary aspect (square/landscape) — the exact bug this
    // step closes: the UI box is locked to cardRatioW/H with object-fit:
    // cover, so an off-ratio file gets client-cropped and the lower-third
    // greeting is cut off. Resize to the exact target box (800×1067 for the
    // 3:4 card) with fit cover / position bottom — a pure backstop now that
    // the pipeline generates natively at 3:4 (non-3:4 sources are bottom-
    // anchored, so the crop trims decorative top scenery only and never the
    // greeting band at the bottom); on any sharp failure fall
    // open to the bytes as-is (graced or raw) with a warning.
    try {
      const normalized = await normalizePosterToCardRatio(
        posterBytes,
        game?.config.cardRatioW,
        game?.config.cardRatioH,
      );
      if (normalized) posterBytes = normalized;
    } catch (err) {
      console.warn(
        `[montage-accumulator] game ${gameId} team ${teamId} round ${round} poster aspect normalization failed — persisting the poster at its native aspect:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }

    // (d) Persist image bytes — the SAME storage pattern as item-image.ts:
    // PNG under the public/static storage root, subdir per game/team,
    // served at the matching /static/ URL (no user text in the path).
    const storageDir = deps.storageDir ?? DEFAULT_MONTAGE_DIR;
    // A successfully graded poster is a fresh PNG encode at the game's card
    // ratio (gradePoster normalizes through sharp + center-crops to
    // cardRatioW/H), and a successfully normalized poster is too (the resize
    // always encodes PNG at the target dims) — the ext must be .png for both.
    // The unchanged fallback (grading AND normalization both skipped/failed)
    // keeps the mime-derived ext.
    const ext =
      posterBytes !== rawBytes ? "png" : imageMime === "image/jpeg" ? "jpg" : "png";
    const fileName = `montage-${teamId}-${round}-${Date.now()}.${ext}`;
    const dir = path.join(storageDir, gameId, teamId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), posterBytes);
    const imageUrl = `/static/montages/${gameId}/${teamId}/${fileName}`;

    await repo.upsertMontageState(teamId, round, {
      patch: {
        status: "READY",
        // promptText = the EXACT image-model prompt (poster prompt + style
        // hint) — the montage_prompt output is embedded verbatim inside it —
        // surfaced to the GM via sync:full + montage:updated ("View prompt").
        promptText: attemptedPromptText,
        imageUrl,
        // The SNAPSHOT seq this pass was generated from — NOT the round — so
        // any staging that lands later (seq++) re-arms exactly one pass.
        imageSeq: snapshot.seq,
        // Non-fatal grading marker on the degraded-but-ready path (READY
        // + lastError): the GM sees WHY the poster shipped without the
        // grading pass via sync:full (GM rows include lastError regardless of
        // status) — without it a degraded READY row is indistinguishable
        // from a fully graded one. A clean pass clears it back to null.
        lastError: lastErrorMessage,
        fallbackUsed: false,
      },
    });
    deps.emit(
      "montage:updated",
      {
        round,
        teamId,
        status: "ready",
        imageUrl,
        promptText: attemptedPromptText,
        // (No error field on the ready payload — the GM's visible cue for a
        // degraded-but-ready poster is the persisted lastError via
        // sync:full; the store clears montageError on the ready branch.)
      },
      { gameId, teamId },
    );
  } catch (err) {
    // (e) Fail-open: ANY failure → FALLBACK (AiBudgetExceededError included —
    // logged distinctly since it means zero AI spend happened). lastError +
    // the attempted promptText (if any) are persisted and emitted so the GM
    // keeps prompt transparency even after an image failure.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AiBudgetExceededError) {
      console.warn(
        `[montage-accumulator] game ${gameId} team ${teamId} skips AI — budget exceeded: ${message}`,
      );
    } else {
      console.warn(
        `[montage-accumulator] game ${gameId} team ${teamId} falls back: ${message}`,
      );
    }
    await repo.upsertMontageState(teamId, round, {
      patch: {
        status: "FALLBACK",
        fallbackUsed: true,
        imageUrl: null,
        lastError: message,
        // Advance imageSeq to the snapshot seq so a failing pass cannot loop
        // forever; new staging (seq++) naturally re-arms a retry.
        imageSeq: snapshot.seq,
        ...(attemptedPromptText !== null ? { promptText: attemptedPromptText } : {}),
      },
    });
    deps.emit(
      "montage:updated",
      { round, teamId, status: "fallback", error: message, promptText: attemptedPromptText },
      { gameId, teamId },
    );
  }
}

