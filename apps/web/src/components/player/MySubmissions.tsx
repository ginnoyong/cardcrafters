"use client";

/**
 * MySubmissions — the player's OWN submission list for the build screen.
 *
 * Rows merge two sources (the store's owner ledger + the team's item rows):
 *  - the `myItems` ledger: EVERY accepted submission (ok ack `mySubmitted`)
 *    plus owner-only `item:rejected` / `item:failed` details (reason +
 *    exampleFix) — no status is ever lost;
 *  - the team's `items` rows: full `ClientItem` shape (imageUrl for the
 *    placed thumbnail, nickname…). Ledger fields win on conflict.
 *
 * Row states: "validating"/"generating" (animated pulse), "placed" (✓ +
 * small imageUrl thumbnail), "rejected" (✗ + reason + `Try: {exampleFix}`),
 * "failed" ("AI hiccup — didn't count against your limits"). Tapping a
 * PLACED row highlights it on the card canvas (onHighlight).
 */

import type { ClientItem, MyItemEvent } from "@/lib/store";

export interface MySubmissionsProps {
  /** THIS player's own item rows (see join-client's merge; ledger wins). */
  items: ClientItem[];
  /** Tap on a placed row → flash it on the card canvas. */
  onHighlight: (itemId: string) => void;
  /** Stable identity for tests (visual snapshot / DOM queries). */
  testId?: string;
}

/** One submission row: prompt + lifecycle chip (+ detail / thumbnail). */
export function MySubmissionRow({ item, onHighlight }: { item: ClientItem; onHighlight: (itemId: string) => void }) {
  const status = item.status;
  const placed = status === "ready" && Boolean(item.imageUrl);
  const clickable = placed && Boolean(onHighlight);
  return (
    <li
      className="cc-sub-row"
      data-testid="my-sub-row"
      data-item-id={item.id}
      data-status={status}
      aria-label={`Your sticker “${item.promptRaw}” — ${chipText(status)}`}
    >
      <span className="cc-sub-prompt" title={item.promptRaw}>
        {item.promptRaw}
      </span>
      <span className={`cc-chip cc-chip-${status}${status === "pending" ? " cc-chip-pulse" : ""}`}>
        <span aria-hidden="true">{chipIcon(status)}</span> {chipText(status)}
      </span>
      {status === "rejected" && item.reason ? (
        <span className="cc-sub-detail cc-sub-reject" data-testid="my-sub-reject">
          {item.reason}
          {item.exampleFix ? <> — Try: “{item.exampleFix}”</> : null}
        </span>
      ) : null}
      {status === "failed" ? (
        <span className="cc-sub-detail" data-testid="my-sub-failed">
          AI hiccup — didn’t count against your limits.
        </span>
      ) : null}
      {placed && item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- small local sticker thumb, no next/image pipeline needed
        <img className="cc-sub-thumb" src={item.imageUrl} alt="" width={36} height={36} />
      ) : null}
      {clickable ? (
        <button
          type="button"
          className="cc-btn cc-btn-small cc-sub-locate"
          onClick={() => onHighlight(item.id)}
          aria-label={`Show “${item.promptRaw}” on the card`}
        >
          Find on card
        </button>
      ) : null}
    </li>
  );
}

function chipIcon(status: ClientItem["status"]): string {
  switch (status) {
    case "ready":
      return "✓";
    case "rejected":
      return "✗";
    case "failed":
      return "!";
    default:
      return "⏳";
  }
}

function chipText(status: ClientItem["status"]): string {
  switch (status) {
    case "pending":
      return "drawing…";
    case "ready":
      return "placed";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
  }
}

export default function MySubmissions({ items, onHighlight, testId = "my-submissions" }: MySubmissionsProps) {
  return (
    <section className="cc-card cc-submissions" aria-label="your stickers" data-testid={testId}>
      <h3>Your stickers</h3>
      {items.length === 0 ? (
        <p className="cc-hint" data-testid="my-sub-empty">
          No stickers yet — type a prompt above and it appears on the card!
        </p>
      ) : (
        <ul className="cc-sub-list" data-testid="my-sub-list">
          {items.map((item) => (
            <MySubmissionRow key={item.id} item={item} onHighlight={onHighlight} />
          ))}
        </ul>
      )}
    </section>
  );
}
