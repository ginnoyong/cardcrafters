"use client";

/**
 * PromptBar — the build-phase prompt input + submit control for the player
 * build screen.
 *
 * Behaviour:
 *  - live "n/6" counter via shared word rules (wordCountState — byte-identical
 *    to the server's pre-filter, so the client can never disagree);
 *  - counter turns red + submit disables when the prompt is over
 *    MAX_PROMPT_WORDS (6) or empty/whitespace;
 *  - busy while awaiting the submit ack;
 *  - ok ack → clear input + onSubmitted(itemId); failed ack → friendly
 *    message via mapSubmitError (cooldown shows the remaining seconds);
 *    input is cleared on success ONLY.
 *
 * Socket wiring: the parent owns the socket, so the parent passes a `wiring`
 * object of two refs it owns:
 *  - `submitRef` — PromptBar reads it on submit to emit over the socket;
 *  - `deliverRef` — PromptBar writes its ack handler into it on mount (and
 *    null on unmount); the parent's socket ack handler calls it.
 * This keeps PromptBar a pure input component — no transport inside.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";

import { MAX_PROMPT_WORDS } from "@cardcrafters/shared";

import { mapSubmitError, wordCountState, type SubmitAckLike } from "@/lib/prompt-flow";

/** Shape of the player:submitPrompt ack (ok adds itemId). */
export type PromptSubmitAck = SubmitAckLike & { itemId?: string };

/** A parent-provided submit function: emits the prompt on the socket. */
export type SubmitFn = (promptRaw: string) => void;

/** PromptBar's ack handler: completes the submit flow (busy/message/clear). */
export type DeliverFn = (ack: PromptSubmitAck) => void;

export interface PromptBarWiring {
  /** Parent-owned ref: PromptBar reads the socket emitter from here. */
  submitRef: { current: SubmitFn | null };
  /** Parent-owned ref: PromptBar installs its ack handler here on mount. */
  deliverRef: { current: DeliverFn | null };
}

export interface PromptBarProps {
  /** Called after an accepted submission with the server's item id. */
  onSubmitted: (itemId: string) => void;
  /** Fired when a valid submit starts (parent may register it optimistically). */
  onSubmitStart?: (promptRaw: string) => void;
  /** Socket wiring (refs owned by the parent). */
  wiring?: PromptBarWiring;
  disabled?: boolean;
}

export default function PromptBar({ onSubmitted, onSubmitStart, wiring, disabled = false }: PromptBarProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submittedRef = useRef(onSubmitted);
  submittedRef.current = onSubmitted;
  const onSubmitStartRef = useRef(onSubmitStart);
  onSubmitStartRef.current = onSubmitStart;

  const count = wordCountState(text);
  const canSend = !disabled && !busy && count.ok;

  const finishOk = (itemId: string): void => {
    setText("");
    submittedRef.current?.(itemId);
  };

  // Install / remove this bar's ack handler on the parent-owned ref. The
  // handler must read fresh state through setters only (they're stable).
  useEffect(() => {
    if (!wiring) return;
    wiring.deliverRef.current = (ack) => {
      setBusy(false);
      if (ack.ok && typeof ack.itemId === "string") {
        finishOk(ack.itemId);
      } else {
        setError(mapSubmitError(ack as SubmitAckLike));
      }
    };
    return () => {
      wiring.deliverRef.current = null;
    };
    // finishOk reads only refs + stable setters — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiring]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!canSend) return;
    const promptRaw = text;
    setBusy(true);
    setError(null);
    onSubmitStartRef.current?.(promptRaw);
    if (wiring) {
      wiring.submitRef.current?.(promptRaw);
    }
  };

  return (
    <form
      className="cc-promptbar"
      aria-label="prompt submission"
      onSubmit={handleSubmit}
      data-testid="prompt-bar"
      data-busy={busy ? "true" : "false"}
    >
      <label className="cc-visually-hidden" htmlFor="cc-prompt-input">
        Describe a sticker (max {MAX_PROMPT_WORDS} words)
      </label>
      <input
        id="cc-prompt-input"
        name="prompt"
        type="text"
        value={text}
        placeholder="Describe a sticker… e.g. “a happy llama”"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
      />
      <span
        className={`cc-wordcount${count.over ? " over" : ""}`}
        aria-live="polite"
        data-testid="word-count"
      >
        {count.count}/{MAX_PROMPT_WORDS}
      </span>
      <button type="submit" className="cc-btn cc-btn-primary" disabled={!canSend} aria-label="Add sticker to the card">
        {busy ? "Sending…" : "Add"}
      </button>
      {error ? (
        <p role="alert" className="cc-promptbar-error" data-testid="prompt-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Imperative ack bridge kept for direct unit-testing of the ack mapping. */
export interface PromptBarHandle {
  /** Resolve a pending submit with the server's ack. */
  onAckResult(ack: PromptSubmitAck): void;
}

/** Build a handle bound to React state setters (used by tests). */
export function createPromptBarHandle(
  setBusy: (busy: boolean) => void,
  setError: (msg: string | null) => void,
  clearText: () => void,
  onSubmitted: (itemId: string) => void,
): PromptBarHandle {
  return {
    onAckResult(ack) {
      setBusy(false);
      if (ack.ok && typeof ack.itemId === "string") {
        clearText();
        onSubmitted(ack.itemId);
      } else {
        setError(mapSubmitError(ack));
      }
    },
  };
}
