"use client";

/**
 * PresenterTeamStage — the presenter's one-at-a-time stage content for
 * REVEAL/RESULTS: the viewed team's TWO cards side by side (AI-montage
 * poster left, composed sticker CardCanvas right — single column ≤720px),
 * with a prompt-transparency accordion under each card:
 *
 *   .cc-stage-banner (conditional, stacked — winner first)
 *     - isWinner        → .cc-stage-banner-winner  "🏆 WINNER <name>" (brass)
 *     - isPeoplesChoice → .cc-stage-banner-peoples-choice "👏 Crowd
 *                          Favourite <name>" (sage tone). Only the VIEWED
 *                          team's honours show — cycle to another team and
 *                          its own banner (if any) takes their place.
 *   .cc-stage-cards (grid 1fr 1fr)
 *     - LEFT  "AI-montage poster": the finished poster image when the
 *             montage pass is ready, otherwise the composed CardCanvas +
 *             a "Generating poster…" indicator (same fallback as
 *             TeamShowcase). Accordion below: the EXACT image-model prompt
 *             the accumulator sent (team.montagePromptText).
 *     - RIGHT "Sticker card": the composed CardCanvas. Accordion below:
 *             the sticker prompts list (ONLY items actually on the card —
 *             status "ready" — as `"promptRaw" — nickname` rows, matching
 *             TeamJudgeCard).
 *
 * Pure projection component: everything comes from the ClientTeam snapshot
 * plus the two boolean flags the caller derives from the snapshot — no
 * sockets, no store access. CardCanvas is imported dynamically (ssr:false)
 * like every other consumer: react-konva must never evaluate during SSR.
 */

import { useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";

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

  return (
    <div className="cc-stage" data-testid={stageTestId} aria-label={`${team.name} stage`}>
      {isWinner ? (
        <section
          className="cc-stage-banner cc-stage-banner-winner"
          role="status"
          aria-label="the winner"
          data-testid="stage-winner-banner"
        >
          <p className="cc-stage-banner-kicker">🏆 WINNER</p>
          <p className="cc-stage-banner-name">{team.name}</p>
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
          <p className="cc-stage-banner-name">{team.name}</p>
        </section>
      ) : null}

      <div className="cc-stage-cards">
        {/* LEFT — the AI-montage poster (or the composed CardCanvas stand-in
            while the poster pass is in flight / on fallback). */}
        <div className="cc-stage-card-col">
          <h3 className="cc-stage-card-title">AI-montage poster</h3>
          {posterReady ? (
            <div
              className="cc-montage"
              style={{
                aspectRatio: `${cardRatioW} / ${cardRatioH}`,
                "--card-ratio-w": cardRatioW,
                "--card-ratio-h": cardRatioH,
              } as CSSProperties}
              aria-label={`poster for ${team.name}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={team.montageImageUrl ?? ""}
                alt={`Finished poster for ${team.name}`}
                className="cc-montage-img"
              />
            </div>
          ) : (
            <>
              <CardCanvas
                items={team.items}
                layout={team.layout}
                greeting={team.greeting.text}
                cardRatioW={cardRatioW}
                cardRatioH={cardRatioH}
                ariaLabel={`${team.name} card — ${readyCount} stickers placed`}
              />
              {team.montageStatus === "generating" ? (
                <p className="cc-montage-status" aria-live="polite">
                  Generating poster…
                </p>
              ) : null}
            </>
          )}
          {/* Poster prompt accordion — the EXACT image-model prompt the
              accumulator sent for this team's poster. */}
          <button
            type="button"
            className="cc-btn cc-btn-small"
            aria-expanded={showMontagePrompt}
            aria-controls={`stage-montage-prompt-${team.id}`}
            aria-label={`view montage prompt for ${team.name}`}
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
        </div>

        {/* RIGHT — the composed sticker card (CardCanvas). */}
        <div className="cc-stage-card-col">
          <h3 className="cc-stage-card-title">Sticker card</h3>
          <CardCanvas
            items={team.items}
            layout={team.layout}
            greeting={team.greeting.text}
            cardRatioW={cardRatioW}
            cardRatioH={cardRatioH}
            ariaLabel={`${team.name} sticker card — ${readyCount} stickers placed`}
          />
          {/* Sticker prompts accordion — only stickers actually on the card
              (status "ready"), with real submitter nicknames. */}
          <button
            type="button"
            className="cc-btn cc-btn-small"
            aria-expanded={showStickerPrompts}
            aria-controls={`stage-sticker-prompts-${team.id}`}
            aria-label={`view sticker prompts for ${team.name}`}
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
        </div>
      </div>
    </div>
  );
}
