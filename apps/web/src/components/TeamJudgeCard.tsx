"use client";

/**
 * TeamJudgeCard — the GM's per-team JUDGING/SCORING box: poster-first flip
 * view as the ONLY content column (full width) with the phase actions along
 * the bottom (JUDGING: score chip + View link + Pick winner; SCORING: score
 * chip + View link). Mirrors TeamShowcase's structure
 * ("use client", dynamic CardCanvas with ssr:false) with a click-to-flip
 * visual:
 *
 *   .cc-judge-card
 *     .cc-team-name   team name + (card label)
 *     .cc-greeting    the team's greeting, quoted
 *     .cc-judge-visual  the visual — when the AI poster is ready it is a
 *                       button-like flip control (poster ↔ composed sticker
 *                       card); without a poster it is a static CardCanvas
 *                       hero. Under it sits the prompt-transparency
 *                       accordion, whose content follows the flip state:
 *                       montage view → the AI-montage prompt; sticker view →
 *                       the sticker prompts list (ONLY items actually on the
 *                       card — status "ready", with real submitter
 *                       nicknames).
 *     .cc-judge-actions  the caller's action node (score chip / View / Pick).
 *
 * Pure projection component: everything comes from the ClientTeam snapshot —
 * no sockets, no store access. CardCanvas is imported dynamically (ssr:false)
 * like every other consumer: react-konva must never evaluate during SSR.
 */

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";

import CardBack, { montageFaceStyle } from "@/components/CardBack";
import type { ClientTeam } from "@/lib/store";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});

/**
 * JudgeScoreChip — the "{avg} avg · {n} vote(s)" line (or "no votes yet"),
 * aria-live so live score updates are announced. Shared by the judge boxes
 * (rendered inside the caller's actions node).
 */
export function JudgeScoreChip({
  tally,
}: {
  tally: { avg: number; count: number } | null;
}) {
  return (
    <span className="cc-judge-score" aria-live="polite">
      {tally
        ? `${tally.avg} avg · ${tally.count} vote${tally.count === 1 ? "" : "s"}`
        : "no votes yet"}
    </span>
  );
}

export default function TeamJudgeCard({
  team,
  cardLabel,
  tally,
  actions,
  testId,
  cardKind = "judging",
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
}: {
  team: ClientTeam;
  /** The scoring card's label ("Card A", …) when one exists. */
  cardLabel: string | null;
  /** The team's live score tally (null = no votes / no scoring row). */
  tally: { avg: number; count: number } | null;
  /** Bottom action row (score chip + View link + Pick winner button). */
  actions: ReactNode;
  testId?: string;
  /** Honest accessible name: "judging" in JUDGING, "scoring" in SCORING. */
  cardKind?: "judging" | "scoring";
  /** Card aspect ratio (game config) — the montage poster box locks to the
   *  SAME ratio as the CardCanvas sticker card so the flip never resizes
   *  and poster/sticker faces render at identical dimensions. */
  cardRatioW?: number;
  cardRatioH?: number;
}) {
  // Flip state: false = the default face (the AI-montage poster when it is
  // ready, otherwise the composed sticker CardCanvas), true = the other face
  // (sticker card / CardBack placeholder respectively).
  const [flipped, setFlipped] = useState(false);
  // Poster <img> load failure → permanently swap the poster face to the
  // CardBack placeholder (greeting + team note) so an unreadable poster file
  // can never show an empty styled box. Keyed on the URL: a NEW poster URL
  // (regenerated montage) gets a fresh chance.
  const [brokenPosterUrl, setBrokenPosterUrl] = useState<string | null>(null);
  // Prompt transparency accordion: collapsed by default (same pattern as the
  // console's TeamCard "View prompt").
  const [showPrompt, setShowPrompt] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The poster face is the real AI montage only when it actually landed
  // (and hasn't failed to load — see brokenPosterUrl).
  const posterReady =
    team.montageStatus === "ready" &&
    !!team.montageImageUrl &&
    team.montageImageUrl !== brokenPosterUrl;
  // ALWAYS flippable now: with a ready poster the poster is the default face
  // and the flip target is the sticker CardCanvas; without one the sticker
  // card is the default and the flip target is the CardBack placeholder
  // (greeting text on a card back) — a team without a poster still gets a
  // real two-face flip instead of a single static card. Either way the
  // sticker CardCanvas lives in the SECOND face slot (one stable DOM
  // position — it never remounts when the poster arrives).
  const showingSticker = posterReady ? flipped : !flipped;
  // Sticker prompts: ONLY the stickers actually on the card (status "ready")
  // — pending/rejected/failed items never made it onto the render.
  const readyItems = team.items.filter((i) => i.status === "ready");

  return (
    <section
      className="cc-judge-card"
      data-testid={testId}
      aria-label={`${team.name} ${cardKind} card`}
    >
      <h3 className="cc-team-name">
        {team.name} <span className="cc-muted">({cardLabel ?? team.label})</span>
      </h3>

      <p className="cc-greeting">“{team.greeting.text}”</p>

      {/* The visual: the ONLY content column (full width). Always a
          button-like flip control (click/Enter/Space, aria-pressed mirrors
          the flipped state): ready poster ↔ sticker card, or sticker card ↔
          CardBack placeholder when there is no poster. A "Generating
          poster…" indicator runs under the flip while the accumulator works. */}
      <div className="cc-judge-visual is-flippable">
          {/* Button-like flip control (same role/tabIndex/Enter/Space
               pattern as TeamMiniCanvas's flip cards): one toggle whose
               label announces what the NEXT click shows. Poster/card-back
               face first, sticker CardCanvas second. */}
          <div
              role="button"
              tabIndex={0}
              aria-pressed={flipped}
              aria-label={
                flipped
                  ? posterReady
                    ? `show AI montage version for ${team.name}`
                    : `show sticker version for ${team.name}`
                  : posterReady
                    ? `show sticker version for ${team.name}`
                    : `show card back for ${team.name}`
              }
              data-testid={testId ? `${testId}-visual` : undefined}
              onClick={() => setFlipped((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFlipped((v) => !v);
                }
              }}
            >
              {/* BOTH faces stay mounted (poster/card-back first, sticker
                  CardCanvas second — ONE stable DOM position, so the canvas
                  never remounts when the poster arrives); the flip toggles
                  them with CSS `display`. A remount sized the fresh Konva
                  stage into a zero-dimension container → blank canvas. The
                  canvas re-measures via its ResizeObserver (which re-fires
                  when the hidden face is revealed) plus a resizeSignal bump
                  on every flip as a belt-and-braces re-measure. */}
              <div style={{ display: showingSticker ? "none" : undefined }}>
                {posterReady ? (
                  <div
                    className="cc-montage"
                    style={montageFaceStyle(cardRatioW, cardRatioH)}
                    aria-label={`poster for ${team.name}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={team.montageImageUrl ?? ""}
                      alt={`Finished poster for ${team.name}`}
                      className="cc-montage-img"
                      onError={() => setBrokenPosterUrl(team.montageImageUrl ?? null)}
                    />
                  </div>
                ) : (
                  <CardBack
                    greeting={team.greeting.text}
                    montageStatus={team.montageStatus}
                    cardRatioW={cardRatioW}
                    cardRatioH={cardRatioH}
                  />
                )}
              </div>
              <div style={{ display: showingSticker ? undefined : "none" }}>
                {/* The sticker face lives in the SAME .cc-montage wrapper the
                    poster/CardBack faces use (shared montageFaceStyle) — all
                    three faces are dimensionally identical by construction.
                    fillContainer lets the Konva stage fill that wrapper's box
                    exactly (the wrapper's inline aspect-ratio + CSS max caps
                    own the geometry), so poster and sticker never diverge. */}
                <div
                  className="cc-montage"
                  style={montageFaceStyle(cardRatioW, cardRatioH)}
                >
                  <CardCanvas
                    items={team.items}
                    layout={team.layout}
                    greeting={team.greeting.text}
                    cardRatioW={cardRatioW}
                    cardRatioH={cardRatioH}
                    fillContainer
                    resizeSignal={flipped}
                    building={false}
                    ariaLabel={`${team.name} sticker card — ${readyCount} stickers placed`}
                  />
                </div>
              </div>
            </div>
          {team.montageStatus === "generating" ? (
            <p className="cc-montage-status" aria-live="polite">
              Generating poster…
            </p>
          ) : null}

          {/* Prompt transparency accordion: content FOLLOWS THE FLIP STATE —
              montage view (default) shows the EXACT image-model prompt the
              accumulator sent for this team's poster; sticker view shows the
              sticker prompts list (only stickers actually on the card, with
              real submitter nicknames). Collapsed by default so it doesn't
              crowd the box; the label is dynamic so it names what the
              expanded view will show. */}
          {team.montagePromptText || readyItems.length > 0 ? (
            <>
              <button
                type="button"
                className="cc-btn cc-btn-small"
                aria-expanded={showPrompt}
                aria-controls={`judge-prompt-${team.id}`}
                aria-label={`view prompts for ${team.name}`}
                onClick={() => setShowPrompt((v) => !v)}
              >
                {showPrompt
                  ? "Hide prompt"
                  : showingSticker
                    ? "View sticker prompts"
                    : "View montage prompt"}
              </button>
              {showPrompt ? (
                showingSticker ? (
                  <div id={`judge-prompt-${team.id}`} className="cc-judge-prompt-content">
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
                ) : team.montagePromptText ? (
                  <pre id={`judge-prompt-${team.id}`} className="cc-prompt-view">
                    {team.montagePromptText}
                  </pre>
                ) : (
                  <p id={`judge-prompt-${team.id}`} className="cc-hint">
                    Montage prompt not available yet.
                  </p>
                )
              ) : null}
            </>
          ) : null}
        </div>

      <div className="cc-judge-actions">{actions}</div>
    </section>
  );
}
