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
 *   - `resolveCardGreeting` — the deterministic LAST-RESORT greeting for a
 *     scoring card: a real AI-generated greeting is ALWAYS preferred — this
 *     helper only guarantees that no card is ever blank (a team whose
 *     greeting generation failed in every round has NO greeting row at all,
 *     so `latestGreetingText` returns "" and the composed PNG would render
 *     paper-only). Falls back to a themed one-liner built from public data
 *     (game theme + team name — both already printed on the card).
 *
 *   - `scoringCardIsEmpty` — whether the team's card for the round is BLANK
 *     (no renderable READY stickers), matching renderTeamCardPng's item
 *     filter exactly; surfaced as the payload `empty` flag so client
 *     surfaces can render their own empty-card treatment in parity.
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
 * LAST-RESORT card greeting (see module doc): `text` passthrough when it is
 * non-empty after trim + whitespace collapse; otherwise a themed fallback
 * one-liner built ONLY from public data — `Happy <theme>, <teamName>!` when
 * the game has a theme, `For <teamName>!` when it does not. Pure function.
 */
export function resolveCardGreeting(text: string, theme: string | null, teamName: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean) return clean;
  const cleanTheme = (theme ?? "").trim().replace(/\s+/g, " ");
  const cleanName = teamName.trim().replace(/\s+/g, " ");
  return cleanTheme ? `Happy ${cleanTheme}, ${cleanName}!` : `For ${cleanName}!`;
}

/**
 * Whether the team's card for `round` is BLANK — no RENDERABLE READY stickers
 * (the same width/height>0 filter renderTeamCardPng applies before composing,
 * so server payload and server artwork can never disagree about emptiness).
 */
export async function scoringCardIsEmpty(
  repo: Repository,
  teamId: string,
  round: number,
): Promise<boolean> {
  const items = await repo.listItems(teamId, round, ["READY"]);
  return !items.some((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0);
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
