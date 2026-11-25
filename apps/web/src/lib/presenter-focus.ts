/**
 * presenter-focus — pure helpers for the GM judge-box "View" deep link
 * (`/present/<code>?card=<cardId>`).
 *
 * The GM console's judge boxes (SCORING/JUDGING) carry a View anchor that
 * opens the presenter in the same tab, focused on THAT team's card. The
 * scoring order is SHUFFLED per game+round (hub buildScoringOrder), so the
 * link must carry the exact `cardId` — never an index — and the presenter
 * must resolve the id against ITS snapshot's scoring order:
 *
 *  - SCORING: the resolved card's index positions the single-card carousel
 *    (unknown ids fall back to the default first card).
 *  - JUDGING (and the later stage phases): the resolved card's TEAM latches
 *    the one-at-a-time stage (teamId is present on the presenter's scoring
 *    payload from JUDGING onward; a unique LABEL-LETTER match is the
 *    fallback — "Card A" → team.label "A". Real team names never reach the
 *    presenter, so labels are the only anonymous identity available).
 *
 * These are pure functions so the param→index/team resolution is unit-testable
 * without mounting the client board (react-konva / socket dependencies).
 */

/** Structural subset of ClientScoringCard (lib/store) the helpers need.
 *  `label` is the card's anonymous display label ("Card A", "Card B", …). */
export interface FocusScoringCard {
  cardId: string;
  teamId?: string;
  label?: string;
}

/** Structural subset of ClientTeam (lib/store) the helpers need —
 *  `label` is the team's anonymous join label ("A", "B", …). */
export interface FocusTeam {
  id: string;
  label: string;
}

/**
 * Resolve a `?card=<cardId>` deep-link param to an index into `cards`.
 *
 * Returns the index of the card whose cardId matches EXACTLY; an
 * unknown/missing param falls back to `defaultIndex` (the carousel's default
 * first card). Pure — order comes from the caller's snapshot, so a shuffled
 * scoring order is handled naturally.
 */
export function resolvePresenterCardIndex(
  cards: ReadonlyArray<{ cardId: string }>,
  param: string | null | undefined,
  defaultIndex: number,
): number {
  if (!param) return defaultIndex;
  const idx = cards.findIndex((c) => c.cardId === param);
  return idx >= 0 ? idx : defaultIndex;
}

/**
 * Resolve a `?card=<cardId>` deep-link param to the scoring card itself
 * (null when the param is missing or matches no card in the snapshot —
 * callers ignore null and keep their default positioning).
 */
export function resolvePresenterCard(
  cards: ReadonlyArray<FocusScoringCard>,
  param: string | null | undefined,
): FocusScoringCard | null {
  if (!param) return null;
  return cards.find((c) => c.cardId === param) ?? null;
}

/**
 * Extract the team label LETTER from a card's display label
 * ("Card A" → "A"). Tolerates a bare letter ("A" → "A") and case
 * differences on the "Card" prefix.
 */
function labelLetter(cardLabel: string): string {
  return cardLabel.replace(/^Card\s+/i, "").trim();
}

/**
 * Resolve a `?card=<cardId>` deep-link param to the card's TEAM: prefer the
 * card's teamId (rides the presenter payload from JUDGING onward), else a
 * UNIQUE label-letter match ("Card A" → team.label "A" — the presenter's
 * payloads are label-only; real team names are stripped server-side). Null
 * when the param is unknown or neither resolves (snapshot race / team
 * removed) — callers keep their default stage positioning.
 */
export function resolvePresenterCardTeam(
  cards: ReadonlyArray<FocusScoringCard>,
  param: string | null | undefined,
  teams: ReadonlyArray<FocusTeam>,
): FocusTeam | null {
  const card = resolvePresenterCard(cards, param);
  if (!card) return null;
  if (card.teamId) {
    const byId = teams.find((t) => t.id === card.teamId);
    if (byId) return byId;
  }
  if (card.label) {
    const letter = labelLetter(card.label);
    const byLabel = teams.filter((t) => t.label === letter);
    if (byLabel.length === 1) return byLabel[0]!;
  }
  return null;
}
