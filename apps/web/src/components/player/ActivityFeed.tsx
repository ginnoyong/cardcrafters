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
          {entries.slice(0, ACTIVITY_FEED_MAX).map((entry) => (
            <li key={`${entry.itemId}-${entry.ts}`} data-testid="activity-feed-row">
              <span className="cc-feed-text">{entry.text}</span>
              {onHighlight && entry.itemId ? (
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
          ))}
        </ul>
      )}
    </section>
  );
}
