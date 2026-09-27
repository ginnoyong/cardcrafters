"use client";

/**
 * NoUndoNotice — one-time "prompts can't be undone" heads-up card shown before
 * the player's first accepted submission (persisted via localStorage
 * `cc_noundo_ack`, so it stays dismissed across reconnects).
 */

import { useState } from "react";

export const NOUNDO_ACK_KEY = "cc_noundo_ack";

export interface NoUndoNoticeProps {
  /** Stable identity for tests (DOM queries). */
  testId?: string;
}

function alreadyAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(NOUNDO_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export default function NoUndoNotice({ testId = "no-undo-notice" }: NoUndoNoticeProps) {
  // Lazy init reads localStorage once; in jsdom-less SSR contexts the try/catch
  // in alreadyAcknowledged() keeps this safe.
  const [visible, setVisible] = useState<boolean>(() => !alreadyAcknowledged());

  if (!visible) return null;
  return (
    <aside className="cc-notice" aria-label="important notice" data-testid={testId}>
      <p>
        Heads-up: prompts can’t be edited, undone, or deleted once accepted — the AI draws
        what you send.
      </p>
      <button
        type="button"
        className="cc-btn cc-btn-small"
        data-testid="no-undo-got-it"
        onClick={() => {
          try {
            window.localStorage.setItem(NOUNDO_ACK_KEY, "1");
          } catch {
            // private mode — dismiss for this session only
          }
          setVisible(false);
        }}
      >
        Got it
      </button>
    </aside>
  );
}
