"use client";

/**
 * PresenterTeamStage — the presenter's one-at-a-time stage content for
 * SCORING/JUDGING/REVEAL/RESULTS: the viewed team's TWO cards side by side
 * (AI-montage poster left, composed sticker CardCanvas right — single column
 * ≤720px), with optional prompt-transparency accordions under each card:
 *
 *   .cc-stage-banner (conditional, stacked — winner first)
 *     - isWinner        → .cc-stage-banner-winner  "🏆 WINNER <name>" (brass)
 *     - isPeoplesChoice → .cc-stage-banner-peoples-choice "👏 Crowd
 *                          Favourite <name>" (sage tone). Only the VIEWED
 *                          team's honours show — cycle to another team and
 *                          its own banner (if any) takes their place.
 *   .cc-stage-meta (conditional — card label / live score tally chip)
 *     - cardLabel → a .cc-badge ("Card A" …) — SCORING cards carry the
 *                   round's card label (label identity only, no team names).
 *     - tally     → the shared JudgeScoreChip ("7.5 avg · 3 votes" /
 *                   "no votes yet") — passed during SCORING/JUDGING where
 *                   live tallies are public; omitted (undefined) on
 *                   REVEAL/RESULTS where no chip renders at all.
 *   .cc-stage-cards (grid 1fr 1fr)
 *     - LEFT  "AI-montage poster": the finished poster image when the
 *             montage pass is ready, otherwise the composed CardCanvas +
 *             a "Generating poster…" indicator (same fallback as
 *             TeamShowcase). Accordion below (when enabled): the EXACT
 *             image-model prompt the accumulator sent
 *             (team.montagePromptText).
 *     - RIGHT "Sticker card": the composed CardCanvas. Accordion below
 *             (when enabled): the sticker prompts list (ONLY items
 *             actually on the card — status "ready" — as
 *             `"promptRaw" — nickname` rows, matching TeamJudgeCard).
 *
 * Face geometry — the SAME contract as TeamMiniCanvas/TeamJudgeCard: BOTH
 * card faces (poster img / CardCanvas) live inside a `.cc-montage` wrapper
 * carrying the shared `montageFaceStyle` inline geometry (aspect-ratio +
 * --card-ratio-w/--card-ratio-h), and the sticker CardCanvas runs with
 * `fillContainer` so the Konva stage fills the measured wrapper instead of
 * doing its own viewport math. The wrapper owns the geometry (NO
 * justify-items:center — a content-sized child in a content-sized wrapper
 * deadlocks at 0); the columns therefore render pixel-identical cards by
 * construction. This is what lets SCORING/JUDGING reuse this REVEAL/RESULTS
 * layout: a 0-prompt team shows the greeting + the phase-aware finished
 * note (lib/empty-card-note.ts, building={false}) on BOTH faces instead of
 * a blank scoring card.
 *
 * Pure projection component: everything comes from the ClientTeam snapshot
 * plus the caller-derived flags — no sockets, no store access. CardCanvas
 * is imported dynamically (ssr:false) like every other consumer:
 * react-konva must never evaluate during SSR.
 */

import { useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";

import { montageFaceStyle } from "@/components/CardBack";
import { JudgeScoreChip } from "@/components/TeamJudgeCard";
import type { ClientTeam } from "@/lib/store";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});

export default function PresenterTeamStage({
  team,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
  testId,
  isWinner,
  isPeoplesChoice,
  tally = undefined,
  cardLabel = null,
  showPromptAccordions = true,
}: {
  team: ClientTeam;
  /** Card aspect ratio (game config) — both the montage poster box and the
   *  CardCanvas sticker card lock to the SAME ratio so the side-by-side
   *  columns render identically sized cards. */
  cardRatioW?: number;
  cardRatioH?: number;
  testId?: string;
  /** The viewed team is the round winner (snapshot.winnerTeamId) — shows
   *  the brass WINNER banner above the cards. */
  isWinner: boolean;
  /** The viewed team is the crowd favourite (snapshot.peoplesChoiceTeamId)
   *  — shows the sage Crowd Favourite banner above the cards. */
  isPeoplesChoice: boolean;
  /** The team's live score tally. undefined = no chip at all (REVEAL/
   *  RESULTS); null = chip showing "no votes yet"; otherwise the
   *  "{avg} avg · {count} vote(s)" chip (SCORING/JUDGING). */
  tally?: { avg: number; count: number } | null;
  /** The scoring card's label ("Card A", …) — shown as a badge in the stage
   *  meta row (SCORING stage cards). Null/absent = no badge. */
  cardLabel?: string | null;
  /** Whether the prompt-transparency accordions render under the cards.
   *  Default true (JUDGING/REVEAL/RESULTS — prompts are public from JUDGING
   *  onward); SCORING passes false (prompts are still anonymous there). */
  showPromptAccordions?: boolean;
}) {
  // Prompt accordions (one per column) — collapsed by default (the same
  // pattern as the console/judge boxes' "View prompt").
  const [showMontagePrompt, setShowMontagePrompt] = useState(false);
  const [showStickerPrompts, setShowStickerPrompts] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The finished poster image is on screen only when the montage pass is
  // ready; otherwise the composed CardCanvas stands in (with a "Generating
  // poster…" indicator while the accumulator runs).
  const posterReady = team.montageStatus === "ready" && !!team.montageImageUrl;
  // Sticker prompts: ONLY the stickers actually on the card (status "ready")
  // — pending/rejected/failed items never made it onto the render.
  const readyItems = team.items.filter((i) => i.status === "ready");

  const stageTestId = testId ? `${testId}-${team.id}` : undefined;
  // Label identity — real team names are GM-only; the big screen shows
  // "Team A"-style labels.
  const identityLabel = `Team ${team.label}`;

  return (
    <div className="cc-stage" data-testid={stageTestId} aria-label={`${identityLabel} stage`}>
      {isWinner ? (
        <section
          className="cc-stage-banner cc-stage-banner-winner"
          role="status"
          aria-label="the winner"
          data-testid="stage-winner-banner"
        >
          <p className="cc-stage-banner-kicker">🏆 WINNER</p>
          <p className="cc-stage-banner-name">{identityLabel}</p>
        </section>
      ) : null}
      {isPeoplesChoice ? (
        <section
          className="cc-stage-banner cc-stage-banner-peoples-choice"
          role="status"
          aria-label="crowd favourite"
          data-testid="stage-peoples-choice"
        >
          <p className="cc-stage-banner-kicker">👏 Crowd Favourite</p>
          <p className="cc-stage-banner-name">{identityLabel}</p>
        </section>
      ) : null}

      {cardLabel || tally !== undefined ? (
        <div className="cc-stage-meta">
          {cardLabel ? <span className="cc-badge">{cardLabel}</span> : null}
          {tally !== undefined ? <JudgeScoreChip tally={tally} /> : null}
        </div>
      ) : null}

      <div className="cc-stage-cards">
        {/* LEFT — the AI-montage poster (or the composed CardCanvas stand-in
            while the poster pass is in flight / on fallback). BOTH faces sit
            in the SAME .cc-montage wrapper (shared montageFaceStyle): the
            wrapper owns the geometry and fillContainer makes the Konva
            stage fill it, so poster and sticker columns are pixel-identical
            by construction (TeamMiniCanvas contract). */}
        <div className="cc-stage-card-col">
          <h3 className="cc-stage-card-title">AI-montage poster</h3>
          {posterReady ? (
            <div
              className="cc-montage"
              style={montageFaceStyle(cardRatioW, cardRatioH)}
              aria-label={`poster for ${identityLabel}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={team.montageImageUrl ?? ""}
                alt={`Finished poster for ${identityLabel}`}
                className="cc-montage-img"
              />
            </div>
          ) : (
            <>
              <div className="cc-montage" style={montageFaceStyle(cardRatioW, cardRatioH)}>
                <CardCanvas
                  items={team.items}
                  layout={team.layout}
                  greeting={team.greeting.text}
                  cardRatioW={cardRatioW}
                  cardRatioH={cardRatioH}
                  fillContainer
                  building={false}
                  ariaLabel={`${identityLabel} card — ${readyCount} stickers placed`}
                />
              </div>
              {team.montageStatus === "generating" ? (
                <p className="cc-montage-status" aria-live="polite">
                  Generating poster…
                </p>
              ) : null}
            </>
          )}
          {/* Poster prompt accordion — the EXACT image-model prompt the
              accumulator sent for this team's poster. Suppressed on the
              SCORING stage (prompts are still anonymous there). */}
          {showPromptAccordions ? (
            <>
              <button
                type="button"
                className="cc-btn cc-btn-small"
                aria-expanded={showMontagePrompt}
                aria-controls={`stage-montage-prompt-${team.id}`}
                aria-label={`view montage prompt for ${identityLabel}`}
                onClick={() => setShowMontagePrompt((v) => !v)}
              >
                {showMontagePrompt ? "Hide prompt" : "View montage prompt"}
              </button>
              {showMontagePrompt ? (
                team.montagePromptText ? (
                  <pre id={`stage-montage-prompt-${team.id}`} className="cc-prompt-view">
                    {team.montagePromptText}
                  </pre>
                ) : (
                  <p id={`stage-montage-prompt-${team.id}`} className="cc-hint">
                    Montage prompt not available yet.
                  </p>
                )
              ) : null}
            </>
          ) : null}
        </div>

        {/* RIGHT — the composed sticker card (CardCanvas). Same shared
            .cc-montage wrapper geometry as the poster column; fillContainer
            lets the Konva stage fill that wrapper's box exactly (the
            wrapper's inline aspect-ratio owns the geometry — NO per-face
            viewport math). building={false}: a 0-prompt team shows the
            greeting + the phase-aware finished note (EMPTY_CARD_FINISHED)
            on this face too — never the BUILD teaser, never a blank card. */}
        <div className="cc-stage-card-col">
          <h3 className="cc-stage-card-title">Sticker card</h3>
          <div className="cc-montage" style={montageFaceStyle(cardRatioW, cardRatioH)}>
            <CardCanvas
              items={team.items}
              layout={team.layout}
              greeting={team.greeting.text}
              cardRatioW={cardRatioW}
              cardRatioH={cardRatioH}
              fillContainer
              building={false}
              ariaLabel={`${identityLabel} sticker card — ${readyCount} stickers placed`}
            />
          </div>
          {/* Sticker prompts accordion — only stickers actually on the card
              (status "ready"), with real submitter nicknames. Suppressed on
              the SCORING stage (prompts are still anonymous there). */}
          {showPromptAccordions ? (
            <>
              <button
                type="button"
                className="cc-btn cc-btn-small"
                aria-expanded={showStickerPrompts}
                aria-controls={`stage-sticker-prompts-${team.id}`}
                aria-label={`view sticker prompts for ${identityLabel}`}
                onClick={() => setShowStickerPrompts((v) => !v)}
              >
                {showStickerPrompts ? "Hide prompts" : "View sticker prompts"}
              </button>
              {showStickerPrompts ? (
                <div id={`stage-sticker-prompts-${team.id}`} className="cc-judge-prompt-content">
                  <h4 className="cc-judge-prompts-title">Sticker prompts</h4>
                  {readyItems.length > 0 ? (
                    <ul className="cc-showcase-prompts">
                      {readyItems.map((item) => (
                        <li key={item.id}>
                          “{item.promptRaw}” — {item.nickname}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="cc-hint">No prompts yet.</p>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
