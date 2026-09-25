/**
 * Greetings flows (Step 6 server half) — the bridge between the AI router,
 * the repository and the game engine for the GREETINGS phase.
 *
 * Responsibilities:
 *  - generateGreetingsForGame: per-team AI greeting proposals at game/round
 *    start; one failure never aborts the batch (per-team result objects);
 *  - regenerateGreeting: explicit GM re-roll for ONE team (always replaces
 *    the current text, even an "edited" one — regeneration IS the GM's
 *    explicit intent, overriding any hand edit; documented here by design);
 *  - waitForGreetings: polling helper for callers (tests / bootstrapping)
 *    that fire generation in the background and need to await completion.
 *
 * Emission policy: these functions do NOT emit socket events themselves —
 * the caller (http api / ws handlers) owns the io server and broadcasts
 * `greeting:updated` with a hub-stamped envelope after persisting.
 */

import type { AiRouter } from "../ai/router";
import type { GameHub } from "../game/hub";
import type { GreetingRow, Repository } from "../repo/repository";

/** One team's outcome within a generation batch. */
export interface GreetingTeamResult {
  teamId: string;
  ok: boolean;
  /** Created greeting (only when ok). */
  greeting?: GreetingRow;
  /** Error message (only when !ok). */
  error?: string;
}

/** Result of a full generation batch. */
export interface GenerateGreetingsResult {
  gameId: string;
  round: number;
  results: GreetingTeamResult[];
  /** Greetings that were successfully persisted. */
  created: GreetingRow[];
}

/** Extract the string[] variations from an AiCallResult (schema-validated upstream). */
function variationsOf(data: unknown): string[] {
  const v = (data as { variations?: unknown })?.variations;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Generate + persist one greeting per team.
 *
 * Mock/openrouter both receive {theme, teamCount, teamIndex, count}; the
 * variation at index `teamIndex` is claimed by that team, so distinct teams
 * claim distinct positions. If a variation text collides with one already
 * used by another team in this batch, the first unused variation is taken
 * instead; when every variation is used the pick is kept as-is (best effort
 * — real providers are asked for `count = teamCount` distinct variations).
 */
export async function generateGreetingsForGame(
  hub: GameHub,
  repo: Repository,
  ai: AiRouter,
  gameId: string,
): Promise<GenerateGreetingsResult> {
  const state = await hub.runtimeState(gameId);
  const theme = state.theme ?? "";
  if (!theme) {
    throw new Error(`game ${gameId} has no theme — cannot generate greetings`);
  }
  const teams = await repo.listTeams(gameId);
  const teamCount = teams.length;
  const usedTexts = new Set<string>();
  const results: GreetingTeamResult[] = [];
  const created: GreetingRow[] = [];

  for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
    const team = teams[teamIndex]!;
    try {
      const res = await ai.run(
        "greeting_variations",
        { theme, teamCount, teamIndex, count: teamCount },
        { gameId },
      );
      const variations = variationsOf(res.data);
      if (variations.length === 0) throw new Error("AI returned no variations");
      // Preferred slot: the team's own index; re-pick the first unused
      // variation on collision so batch texts stay distinct.
      const preferred = teamIndex % variations.length;
      let pick = preferred;
      if (usedTexts.has(variations[pick]!)) {
        const unused = variations.findIndex((t) => !usedTexts.has(t));
        if (unused >= 0) pick = unused;
      }
      const text = variations[pick]!;
      usedTexts.add(text);
      const greeting = await upsertGreeting(repo, team.id, state.round, text, "proposed");
      results.push({ teamId: team.id, ok: true, greeting });
      created.push(greeting);
    } catch (err) {
      // One team failing must not sink the batch — record and continue.
      results.push({
        teamId: team.id,
        ok: false,
        error: err instanceof Error ? err.message : "greeting generation failed",
      });
    }
  }
  return { gameId, round: state.round, results, created };
}

/**
 * Persist a greeting for [teamId, round], upserting on the unique row
 * (createGreeting throws on duplicates — fall back to updateGreeting).
 */
async function upsertGreeting(
  repo: Repository,
  teamId: string,
  round: number,
  text: string,
  status: string,
): Promise<GreetingRow> {
  try {
    return await repo.createGreeting({ teamId, round, text, status });
  } catch {
    // Row already exists for [teamId, round] → replace text + status.
    return repo.updateGreeting(teamId, round, { text, status });
  }
}

/**
 * Regenerate ONE team's greeting: fresh AI run, persisted as a NEW "proposed"
 * row. NOTE: this deliberately replaces the text even when the current status
 * is "edited" — regeneration is an explicit GM intent that supersedes any
 * hand edit (documented trade-off from the approved plan).
 *
 * Returns the new text.
 */
export async function regenerateGreeting(
  hub: GameHub,
  repo: Repository,
  ai: AiRouter,
  gameId: string,
  teamId: string,
): Promise<string> {
  const state = await hub.runtimeState(gameId);
  const theme = state.theme ?? "";
  if (!theme) throw new Error(`game ${gameId} has no theme — cannot regenerate a greeting`);
  const teams = await repo.listTeams(gameId);
  const teamIndex = teams.findIndex((t) => t.id === teamId);
  if (teamIndex < 0) throw new Error(`team ${teamId} not found in game ${gameId}`);

  const res = await ai.run(
    "greeting_variations",
    { theme, teamCount: teams.length, teamIndex, count: teams.length },
    { gameId },
  );
  const variations = variationsOf(res.data);
  if (variations.length === 0) throw new Error("AI returned no variations");
  const text = variations[teamIndex % variations.length]!;
  await upsertGreeting(repo, teamId, state.round, text, "proposed");
  return text;
}

/**
 * Await background greeting generation by polling the repo until `count`
 * greetings exist for the game's current round (or timeout). Used by callers
 * that fired generateGreetingsForGame fire-and-forget (POST /api/games) and
 * by integration tests; mock mode resolves ~instantly.
 */
export async function waitForGreetings(
  repo: Repository,
  hub: GameHub,
  gameId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<GreetingRow[]> {
  const deadline = Date.now() + timeoutMs;
  const round = (await hub.runtimeState(gameId)).round;
  for (;;) {
    const rows = await repo.listGreetings(gameId, round);
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
