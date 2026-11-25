/**
 * scoring-card-extras — per-card data the SCORING payload carries BEYOND the
 * anonymous cardId/label/teamName (server-side helpers; nothing here is
 * itself audience-aware — the callers decide what rides to players):
 *
 *   - `latestGreetingText` — the team's greeting resolved with the SAME
 *     round-fallback rule renderTeamCardPng applies (apps/web/src/server/
 *     http/api.ts): greeting rows only ever exist for round 1 (generated
 *     once at game creation; per-team AI failures drop even those), so
 *     round-2+ lookups walk DOWNWARD from the runtime round and keep the
 *     first row found. The greeting TEXT is public on the composed card
 *     artwork anyway — delivering it keyed by cardId leaks nothing new.
 *
 *   - `scoringMontageView` — the team's montage (AI poster) state for the
 *     round, surfaced as `{ status: "ready", imageUrl }` ONLY when a READY
 *     poster file exists; null otherwise (generating / FALLBACK / missing).
 *
 * Privacy: the montage imageUrl is a public /static/... URL, but its path
 * embeds the RAW teamId ("/static/montages/{gameId}/{teamId}/{file}") — so
 * imageUrl may ride ONLY to trusted audiences (GM). Player/presenter copies
 * must strip it (use the cardId-keyed scoring-card endpoint with
 * `variant=poster` instead, which serves the same file byte-for-byte without
 * naming the team).
 */

import type { Repository } from "../repo/repository";

/** A READY montage poster view — imageUrl present only for trusted copies. */
export interface ScoringCardMontageView {
  status: "ready";
  /** Public /static path — PLAYER- and presenter-safe (the path leaks no
   *  teamId to clients; only the server resolves it to the file). */
  imageUrl: string;
}

/**
 * The team's LATEST greeting text at `round` (round-fallback walk; "" when
 * the team has no greeting row in any round — e.g. a 0-prompt team whose
 * greeting generation failed).
 */
export async function latestGreetingText(
  repo: Repository,
  gameId: string,
  teamId: string,
  round: number,
): Promise<string> {
  for (let r = round; r >= 1; r--) {
    const row = (await repo.listGreetings(gameId, r)).find((g) => g.teamId === teamId);
    if (row) return row.text;
  }
  return "";
}

/**
 * The team's READY montage poster for `round`, or null when the poster pass
 * has not landed (still generating, FALLBACK, or never ran).
 */
export async function scoringMontageView(
  repo: Repository,
  teamId: string,
  round: number,
): Promise<ScoringCardMontageView | null> {
  const montage = await repo.getMontageState(teamId, round);
  return montage && montage.status === "READY" && montage.imageUrl
    ? { status: "ready", imageUrl: montage.imageUrl }
    : null;
}
