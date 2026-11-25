/**
 * ActivityFeed SSR (react-dom/server) — terminal-state rows.
 *
 * Verifies (string-level, no DOM) the component half of the terminal feed
 * contract: entries whose store ledger went REJECTED / FAILED / WITHDRAWN
 * (status flipped by the itemRejected/itemFailed/itemWithdrawn reducers)
 * NEVER render a live "Find on card" button (the sticker will never be on
 * the card — locating it would be a dead no-op). Their row text carries the
 * struck-through class and a muted parenthetical note; rejected rows surface
 * the owner-only `reason` transported by the item:rejected event.
 *
 * Pending / ready / legacy (no-status) entries keep the button unchanged.
 * No jsdom: SSR string assertions only (pattern: TeamJudgeCard.ssr.test.tsx).
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ActivityFeed from "@/components/player/ActivityFeed";
import type { ClientActivityEntry } from "@/lib/store";

function makeEntry(overrides: Partial<ClientActivityEntry> = {}): ClientActivityEntry {
  return {
    itemId: "item-1",
    text: "Ada added “a sleepy cat”",
    ts: 1,
    ...overrides,
  };
}

/** onHighlight stub — the BUILD wiring the component receives in the app. */
function renderFeed(entries: ClientActivityEntry[]): string {
  return renderToStaticMarkup(
    <ActivityFeed entries={entries} onHighlight={() => {}} />,
  );
}

describe("ActivityFeed SSR — terminal entries", () => {
  it("a rejected entry renders struck text + the transported reason, with no button", () => {
    const reason = "Keep it family-friendly — try a different subject.";
    const html = renderFeed([
      makeEntry({ status: "rejected", reason }),
    ]);

    expect(html).toContain("cc-feed-struck");
    expect(html).toContain(`(rejected: ${reason}`);
    // The locate button is gone — the item will never be on the card.
    expect(html).not.toContain("Find on card");
  });

  it("a rejected entry without a reason still renders the struck note (graceful fallback)", () => {
    const html = renderFeed([makeEntry({ status: "rejected", reason: "" })]);
    expect(html).toContain("cc-feed-struck");
    expect(html).toContain("(rejected)");
    expect(html).not.toContain("Find on card");
  });

  it("a failed entry renders struck text + its retry note, with no button", () => {
    const html = renderFeed([makeEntry({ status: "failed" })]);

    expect(html).toContain("cc-feed-struck");
    expect(html).toContain("generate — try again");
    expect(html).not.toContain("Find on card");
  });

  it("a withdrawn entry renders struck text + its note, with no button", () => {
    const html = renderFeed([makeEntry({ status: "withdrawn" })]);

    expect(html).toContain("cc-feed-struck");
    expect(html).toContain("make it onto the card");
    expect(html).not.toContain("Find on card");
  });

  it("pending / ready / legacy (no-status) entries keep the Find on card button", () => {
    for (const entry of [
      makeEntry({ status: "pending" }),
      makeEntry({ status: "ready" }),
      // Legacy ledger rows predate the status field — unchanged behaviour.
      makeEntry({}),
    ]) {
      const html = renderFeed([entry]);
      expect(html).toContain("Find on card");
      expect(html).not.toContain("cc-feed-struck");
      expect(html).not.toContain("cc-feed-note");
    }
  });
});
