"use client";

/**
 * RatingPanel — the player's SCORING surface.
 *
 * Binding decisions (see phase spec):
 *  - ONE card at a time, browsed with prev/next ("Card B · 2 / 3"); cards are
 *    labeled with their real team name (decision 2a), but never the teamId
 *    mapping (that stays server-side);
 *  - the player's OWN team's card is skipped entirely (own-card guard) —
 *    it never appears in the rateable list;
 *  - each card shows its LIVE anonymous average + vote count (scores:update);
 *  - poster-first preview: the card image defaults to the team's AI poster
 *    (variant=poster) and can be flipped to the sticker card;
 *  - TEN large buttons, 1–10;
 *  - a tap shows a brief confirm ("Rate Card B: 7?") — confirming submits the
 *    rating as FINAL (no undo, no re-rating) and auto-advances to the next
 *    unrated card;
 *  - when every rateable card has been rated: "All rated — waiting for the
 *    game master".
 *
 * No sound anywhere (party game, phones on silent anyway). All copy is
 * plain language — no jargon.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";

import type { ClientScoring, ClientScoreTally } from "@/lib/store";
import { friendlyScoreError } from "@/lib/socket";

/** Outcome of one FINAL submit (delivered by the parent's socket ack). */
export interface ScoreSubmitOutcome {
  ok: boolean;
  /** Machine-readable rejection stage (own_card / already_rated / …). */
  reason?: string;
  /** Pre-formatted friendly error (parent uses friendlyScoreError). */
  error?: string;
}

export interface RatingPanelProps {
  scoring: ClientScoring;
  /** Live anonymous tallies (scores:update), keyed by cardId. */
  scores: Record<string, ClientScoreTally>;
  /** THIS player's already-submitted ratings (cardId → 1..10). */
  myScores: Record<string, number>;
  /** FINAL submit — the parent emits score:submit over the socket. */
  onSubmit: (cardId: string, value: number) => Promise<ScoreSubmitOutcome>;
  /** Game code — for the scoring-card PNG preview URL. */
  gameCode: string;
  /** Player session token — auth for the scoring-card PNG preview. */
  sessionToken: string;
  /** Cache-bust version for the scoring-card PNG URL (bumped by the store
   *  on layout/scoring changes — the montage pass re-renders the card at
   *  BUILD→SCORING). */
  cardVersion?: number;
  /** Phase countdown label ("4:37") shown beside the heading; null/undefined
   *  when no timer is running. */
  remainingLabel?: string | null;
  /** Card aspect ratio (game config) — the preview box locks to the SAME
   *  ratio as the CardCanvas sticker card. Defaults to the shared 5/7. */
  cardRatioW?: number;
  cardRatioH?: number;
  testId?: string;
}

/** How long the confirm affordance waits before collapsing (ms). */
const CONFIRM_RESET_MS = 6000;

export default function RatingPanel({
  scoring,
  scores,
  myScores,
  onSubmit,
  gameCode,
  sessionToken,
  cardVersion,
  remainingLabel,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
  testId = "rating-panel",
}: RatingPanelProps) {
  // Rateable cards: everything EXCEPT our own team's card (own-card guard —
  // the server would refuse it with own_card anyway).
  const rateable = useMemo(
    () => scoring.cards.filter((c) => c.cardId !== scoring.yourTeamCardId),
    [scoring.cards, scoring.yourTeamCardId],
  );
  const ownCard = scoring.cards.find((c) => c.cardId === scoring.yourTeamCardId) ?? null;

  // Which card is on screen (index into `rateable`).
  const [index, setIndex] = useState(0);
  // Pending tap: the value awaiting its brief confirm (null = no pending tap).
  const [pending, setPending] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Auto-collapse the confirm affordance if the player doesn't confirm.
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setPending(null), CONFIRM_RESET_MS);
    return () => clearTimeout(t);
  }, [pending]);

  // Clamp the index when the card list changes (scores/rounds stay stable
  // within SCORING, but resyncs can shrink the list defensively).
  useEffect(() => {
    if (index >= rateable.length) setIndex(0);
  }, [rateable.length, index]);

  const card = rateable[index] ?? null;
  const mine = card ? myScores[card.cardId] : undefined;
  const tally = card ? scores[card.cardId] : undefined;

  // Card preview image state: opacity fades in once loaded; a failed fetch
  // (403 expired session, 409 phase change, render failure) shows a hint
  // instead of a broken-image glyph.
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  // Poster-first flip: the preview defaults to the team's AI poster and can
  // be flipped to the sticker card. Resets when the card changes.
  const [variant, setVariant] = useState<"poster" | "sticker">("poster");
  useEffect(() => {
    setImgLoaded(false);
    setImgFailed(false);
    setVariant("poster");
  }, [card?.cardId, cardVersion]); // cardVersion bump → fresh render, re-fade

  if (rateable.length === 0) {
    return (
      <section className="cc-card" aria-label="rate the cards" data-testid={testId}>
        <h3>Rate other teams' cards</h3>
        <p className="cc-hint">No cards to rate this round.</p>
      </section>
    );
  }

  // Done = every rateable card has a FINAL rating.
  const allRated = rateable.length > 0 && rateable.every((c) => myScores[c.cardId] !== undefined);

  if (allRated) {
    return (
      <section className="cc-card" aria-label="all cards rated" data-testid={testId} role="status">
        <h3>All rated — waiting for the game master</h3>
        <p className="cc-hint">
          Your scores are in. The host will pick the winner next.
        </p>
        {ownCard ? (
          <p className="cc-hint">
            Your own team's card ({ownCard.teamName ?? ownCard.label}) can't be rated by you.
          </p>
        ) : null}
      </section>
    );
  }

  if (!card) return null;

  // Real team name (decision 2a) — falls back to the anonymous label only if
  // the payload somehow lacks a teamName.
  const cardName = card.teamName ?? card.label;
  const imageUrl =
    `/api/games/${gameCode}/scoring-card/${card.cardId}?token=${sessionToken}&v=${cardVersion ?? 0}` +
    (variant === "poster" ? "&variant=poster" : "");

  const go = (delta: number): void => {
    setPending(null);
    setError(null);
    setIndex((i) => (i + delta + rateable.length) % rateable.length);
  };

  const confirmAndSubmit = async (): Promise<void> => {
    if (pending === null || submitting) return;
    const value = pending;
    setSubmitting(true);
    setError(null);
    const outcome = await onSubmit(card.cardId, value);
    setSubmitting(false);
    setPending(null);
    if (!outcome.ok) {
      setError(outcome.error ?? friendlyScoreError(outcome.reason));
      return;
    }
    // FINAL — registered client-side by the parent (myScoreSubmitted) from
    // the ack; auto-advance to the next UNRATED card (this card just became
    // rated, and React may not have re-rendered myScores yet — treat it as
    // rated explicitly).
    const rated = new Set(Object.keys(myScores));
    rated.add(card.cardId);
    const nextIdx = rateable.findIndex((c) => !rated.has(c.cardId));
    if (nextIdx !== -1) setIndex(nextIdx);
  };

  return (
    <section className="cc-card cc-rating" aria-label="rate the cards" data-testid={testId}>
      <div className="cc-rating-title-row">
        <h3>Rate other teams' cards</h3>
        {remainingLabel ? (
          <span className="cc-timer-sm" role="timer" aria-label="time remaining">
            ⏱ {remainingLabel}
          </span>
        ) : null}
      </div>
      <div className="cc-rating-head">
        {rateable.length > 1 ? (
          <button
            type="button"
            className="cc-btn cc-btn-small"
            aria-label="previous card"
            disabled={submitting}
            onClick={() => go(-1)}
          >
            ‹ Prev
          </button>
        ) : null}
        <h3>
          {cardName}{" "}
          <span className="cc-muted">
            · {index + 1} / {rateable.length}
          </span>
        </h3>
        {rateable.length > 1 ? (
          <button
            type="button"
            className="cc-btn cc-btn-small"
            aria-label="next card"
            disabled={submitting}
            onClick={() => go(1)}
          >
            Next ›
          </button>
        ) : null}
      </div>

      {/* Finished-card preview (server renders the team's actual card):
          poster-first — tap the image or the flip button to switch between
          the AI poster and the sticker card. */}
      {!imgFailed ? (
        <>
          <div
            className="cc-rating-image-box"
            style={{
              aspectRatio: `${cardRatioW} / ${cardRatioH}`,
              "--card-ratio-w": cardRatioW,
              "--card-ratio-h": cardRatioH,
            } as CSSProperties}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              key={`${card.cardId}:${cardVersion ?? 0}:${variant}`}
              data-testid="rating-card-image"
              alt={`The card you are rating: ${cardName}`}
              className={`cc-rating-image${imgLoaded ? " is-loaded" : ""}`}
              role="button"
              aria-label={variant === "poster" ? "show sticker card" : "show poster"}
              onClick={() => setVariant((v) => (v === "poster" ? "sticker" : "poster"))}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgFailed(true)}
            />
          </div>
          <button
            type="button"
            className="cc-btn cc-flip-btn"
            data-testid="rating-card-flip"
            disabled={submitting}
            onClick={() => setVariant((v) => (v === "poster" ? "sticker" : "poster"))}
          >
            {variant === "poster" ? "Show sticker card" : "Show poster"}
          </button>
        </>
      ) : (
        <p className="cc-hint">Card preview unavailable.</p>
      )}

      {/* Live running average + vote count. */}
      <p className="cc-hint" aria-live="polite">
        {tally
          ? `Score so far: ${tally.avg} from ${tally.count} vote${tally.count === 1 ? "" : "s"}`
          : "No votes yet — be the first!"}
      </p>

      {mine !== undefined ? (
        <p className="cc-hint" role="status">
          You rated this card {mine} — locked in.
        </p>
      ) : pending !== null ? (
        <div className="cc-rating-confirm" role="group" aria-label="confirm your rating">
          <p>
            Rate {cardName}: <strong>{pending}</strong>? This can't be changed after.
          </p>
          <div className="cc-btn-row">
            <button
              type="button"
              className="cc-btn cc-btn-primary"
              disabled={submitting}
              onClick={() => void confirmAndSubmit()}
            >
              {submitting ? "Sending…" : "Yes, rate it"}
            </button>
            <button
              type="button"
              className="cc-btn"
              disabled={submitting}
              onClick={() => setPending(null)}
            >
              Pick again
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}

      {/* TEN large buttons, 1–10 (hidden once this card is finally rated —
          ratings are FINAL, no undo). */}
      {mine === undefined ? (
        <div className="cc-rating-buttons" role="group" aria-label={`rate ${cardName} from 1 to 10`}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((value) => (
            <button
              key={value}
              type="button"
              className={`cc-btn cc-btn-rate${pending === value ? " is-pending" : ""}`}
              disabled={submitting}
              aria-label={`rate ${cardName} ${value}`}
              onClick={() => {
                setError(null);
                setPending(value);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}