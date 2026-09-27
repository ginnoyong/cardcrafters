"use client";

/**
 * ActivityFeed — the team's live activity strip for the build screen.
 *
 * Rows come straight from the store's per-team `activity` ledger (newest
 * first, capped at ACTIVITY_FEED_MAX=30): `item:pending` → "{nickname} added
 * '{prompt}'", `item:ready` → "{nickname}'s '{prompt}' is on the card". The
 * ledger is rebuilt live by the store reducer — this component is a pure
 * projection. Fixed max height, subtle scroll, newest on top.
 */

import { ACTIVITY_FEED_MAX, type ClientActivityEntry } from "@/lib/store";

export interface ActivityFeedProps {
  /** Newest-first activity entries (from the team's `activity` ledger). */
  entries: ClientActivityEntry[];
  /** Stable identity for tests (DOM queries). */
  testId?: string;
}

export default function ActivityFeed({ entries, testId = "activity-feed" }: ActivityFeedProps) {
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
              {entry.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
