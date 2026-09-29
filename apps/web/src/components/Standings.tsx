"use client";

/**
 * Results-stage presentational bits shared by the GM console, the player
 * waiting screen and the presenter board:
 *
 *  - WinnerBanner — the big "🏆 Team X wins!" banner (plain language);
 *  - PeoplesChoiceBanner — the secondary "Crowd favourite" banner;
 *  - StandingsList — the round's public standings table (avg desc → count
 *    desc → label asc, already server-sorted via winnerAnnounced).
 *
 * All inputs come from the store's snapshot (winnerTeamId /
 * peoplesChoiceTeamId / standings) — nothing here talks to the socket.
 */

import type { ClientStanding } from "@/lib/store";

export function WinnerBanner({
  label,
  testId = "winner-banner",
}: {
  /** Winning team's display name/label. */
  label: string;
  testId?: string;
}) {
  return (
    <section className="cc-card cc-winner-banner" role="status" aria-label="the winner" data-testid={testId}>
      <p className="cc-winner-kicker">The winner is…</p>
      <p className="cc-winner-name">🏆 {label}</p>
    </section>
  );
}

export function PeoplesChoiceBanner({
  label,
  testId = "peoples-choice-banner",
}: {
  /** People's Choice team's display name/label. */
  label: string;
  testId?: string;
}) {
  return (
    <section className="cc-card cc-peoples-choice" role="status" aria-label="crowd favourite" data-testid={testId}>
      <p className="cc-hint">Crowd favourite (the players&apos; top score):</p>
      <p className="cc-winner-name cc-peoples-name">👏 {label}</p>
    </section>
  );
}

/**
 * Public standings table. Rows are rendered in the given order (the server
 * already sorts avg desc → count desc → label asc); the winner's row is
 * highlighted, and the People's Choice row gets a small tag.
 */
export function StandingsList({
  standings,
  winnerTeamId,
  peoplesChoiceTeamId,
  testId = "standings",
}: {
  standings: ClientStanding[];
  winnerTeamId: string | null;
  peoplesChoiceTeamId?: string | null;
  testId?: string;
}) {
  if (standings.length === 0) return null;
  return (
    <section className="cc-card cc-standings" aria-label="standings" data-testid={testId}>
      <h3>Standings</h3>
      <ol className="cc-standings-list">
        {standings.map((row, i) => (
          <li
            key={row.teamId}
            className={`${row.teamId === winnerTeamId ? " is-winner" : ""}${
              row.teamId === peoplesChoiceTeamId ? " is-peoples-choice" : ""
            }`}
          >
            <span className="cc-standings-rank" aria-hidden="true">
              {i + 1}.
            </span>{" "}
            <span className="cc-standings-label">{row.label}</span>
            <span className="cc-standings-score">
              {row.avg} avg · {row.count} vote{row.count === 1 ? "" : "s"}
            </span>
            {row.teamId === peoplesChoiceTeamId && row.teamId !== winnerTeamId ? (
              <span className="cc-badge">crowd favourite</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Resolve a team's display label from the snapshot's teams list. */
export function teamLabel(
  teams: Array<{ id: string; name: string; label: string }>,
  teamId: string | null | undefined,
): string {
  if (!teamId) return "";
  const team = teams.find((t) => t.id === teamId);
  return team ? team.name : "";
}