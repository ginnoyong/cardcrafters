/**
 * team-label-sort — ascending card-label order for the GM console's bottom
 * mini grid (TeamMiniCanvas).
 *
 * The grid used to map the raw `snapshot.teams` array, whose order is
 * snapshot/arrival order — after scoring:started the server's buildScoringOrder
 * SHUFFLES the card order, and multi-round resets can drift the array away
 * from card-label order. The grid must always read "Card A → Card B → …".
 *
 * Ordering key: the team's short label ("A"…"J" — see TEAM_LABELS in
 * apps/web/src/server/game/hub.ts; MAX_TEAMS = 10, single letters only).
 * The comparator is written label-suffix-wise so both label styles sort the
 * same way ("A" and "Card A" land in identical order), the numeric fallback
 * labels ("Card 11" for pools beyond the letter pool) still compare
 * numerically, and the team label ("A" < "J") and card label ("Card B" <
 * "Card J") orders agree. Pure — the caller maps over a sorted COPY, the
 * snapshot array itself is never mutated.
 */

/** Sort key extracted from a label's trailing suffix token. */
interface LabelSortKey {
  /** Uppercased trailing letters ("A", "CARD A" → last token "A"). */
  letters: string;
  /** Trailing number when present ("Card 11" → 11), else 0. */
  num: number;
}

function labelSortKey(label: string): LabelSortKey {
  const token = label.trim().split(/\s+/).pop() ?? "";
  const m = /^([A-Za-z]*)(\d*)$/.exec(token);
  if (!m) return { letters: token.toUpperCase(), num: 0 };
  return { letters: m[1]!.toUpperCase(), num: m[2] ? Number(m[2]) : 0 };
}

/** Ascending label-suffix comparison (letters, then numeric suffix). */
export function compareTeamLabels(a: string, b: string): number {
  const ka = labelSortKey(a);
  const kb = labelSortKey(b);
  if (ka.letters !== kb.letters) return ka.letters < kb.letters ? -1 : 1;
  return ka.num - kb.num;
}

/**
 * A new array of `teams` sorted ascending by label suffix (A → B → …).
 * Stable for equal labels (Array.prototype.sort is stable in Node/modern
 * engines); the input array is NOT mutated.
 */
export function sortByTeamLabel<T extends { label: string }>(teams: readonly T[]): T[] {
  return [...teams].sort((a, b) => compareTeamLabels(a.label, b.label));
}
