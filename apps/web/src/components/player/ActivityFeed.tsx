"use client";

/**
 * ActivityFeed — the team's live activity strip for the build screen.
 *
 * Rows come straight from the store's per-team `activity` ledger (newest
 * first, capped at ACTIVITY_FEED_MAX=30): `item:pending` → "{nickname} added
 * '{prompt}'", `item:ready` → "{nickname}'s '{prompt}' is on the card". The
 * ledger is rebuilt live by the store reducer — this component is a pure
 * projection. Fixed max height, subtle scroll, newest on top.
 *
 * When `onHighlight` is provided (the BUILD single-card stage passes the
 * join-client highlight wiring), every entry that carries an itemId gets a
 * small "Find on card" button (same look as the old MySubmissions locate
 * button) that flashes that sticker on the card canvas. Without the prop
 * (locked phases) the feed renders plain text rows.
 *
 * TERMINAL ENTRIES (rejected/failed/withdrawn — status flipped by the store's
 * itemRejected/itemFailed/itemWithdrawn reducers) never offer "Find on card":
 * the sticker will never be on the card, so locating it would be a dead
 * no-op. Their row text is struck through and a muted parenthetical note
 * carries the outcome (the owner-only rejection reason where present).
 */

import { ACTIVITY_FEED_MAX, type ClientActivityEntry } from "@/lib/store";

export interface ActivityFeedProps {
  /** Newest-first activity entries (from the team's `activity` ledger). */
  entries: ClientActivityEntry[];
  /** Optional "Find on card" wiring — when present, entries with an itemId
   *  render a small locate button that flashes the sticker on the canvas. */
  onHighlight?: (itemId: string) => void;
  /** Stable identity for tests (DOM queries). */
  testId?: string;
}

export default function ActivityFeed({ entries, onHighlight, testId = "activity-feed" }: ActivityFeedProps) {
  return (
    <section
      className="cc-card cc-feed-card"
      aria-label="team activity"
      data-testid={testId}
      data-count={entries.length}
    >
      <h3>Team activity</h3>
      {entries.length === 0 ? (
        <p className="cc-hint" data-testid="activity-feed-empty">
          Team updates appear here as stickers are made.
        </p>
      ) : (
        <ul className="cc-feed" data-testid="activity-feed-list">
          {entries.slice(0, ACTIVITY_FEED_MAX).map((entry) => {
            // Terminal states (owner's row survived the item:withdrawn
            // broadcast): no locate button, struck text + outcome note.
            // Legacy entries (no status) and pending/ready keep the button.
            const terminal =
              entry.status === "rejected" ||
              entry.status === "failed" ||
              entry.status === "withdrawn";
            const note =
              entry.status === "rejected"
                ? entry.reason
                  ? `(rejected: ${entry.reason})`
                  : "(rejected)"
                : entry.status === "failed"
                  ? "(couldn't generate — try again)"
                  : entry.status === "withdrawn"
                    ? "(didn't make it onto the card)"
                    : null;
            return (
              <li key={`${entry.itemId}-${entry.ts}`} data-testid="activity-feed-row">
                <span
                  className={terminal ? "cc-feed-text cc-feed-struck" : "cc-feed-text"}
                >
                  {entry.text}
                </span>
                {note ? <span className="cc-feed-note">{note}</span> : null}
                {onHighlight && entry.itemId && !terminal ? (
                  <button
                    type="button"
                    className="cc-btn cc-btn-small cc-sub-locate"
                    onClick={() => onHighlight(entry.itemId)}
                    aria-label="Show this sticker on the card"
                  >
                    Find on card
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
