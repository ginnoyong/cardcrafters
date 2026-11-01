"use client";

/**
 * TeamJudgeCard — the GM's per-team JUDGING/SCORING box: poster-first flip
 * view with the sticker prompts on the right and the phase actions along the
 * bottom (JUDGING: score chip + View link + Pick winner; SCORING: View link
 * only). Mirrors TeamShowcase's structure
 * ("use client", dynamic CardCanvas with ssr:false) but swaps the static
 * two-sub layout for a 2-column judge body with a click-to-flip visual:
 *
 *   .cc-judge-card
 *     .cc-team-name   team name + (card label)
 *     .cc-greeting    the team's greeting, quoted
 *     .cc-judge-body  LEFT  .cc-judge-visual  the visual — when the AI poster
 *                             is ready it is a button-like flip control
 *                             (poster ↔ composed sticker card); without a
 *                             poster it is a static CardCanvas hero.
 *                     RIGHT .cc-judge-prompts the sticker prompts list
 *                             (ONLY items actually on the card — status
 *                             "ready"), scrollable.
 *     .cc-judge-actions  the caller's action node (score chip / View / Pick).
 *
 * Pure projection component: everything comes from the ClientTeam snapshot —
 * no sockets, no store access. CardCanvas is imported dynamically (ssr:false)
 * like every other consumer: react-konva must never evaluate during SSR.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";

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
  // Flip state: false = the AI-montage poster (the card face), true = the
  // composed sticker CardCanvas. Only meaningful when the poster is ready.
  const [flipped, setFlipped] = useState(false);
  // Prompt transparency accordion: collapsed by default (same pattern as the
  // console's TeamCard "View prompt").
  const [showPrompt, setShowPrompt] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The flip control exists only when the AI poster is actually on screen.
  const posterReady = team.montageStatus === "ready" && !!team.montageImageUrl;
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

      <div className="cc-judge-body">
        {/* LEFT: the visual. Poster-ready → button-like flip control
            (click/Enter/Space, aria-pressed mirrors the flipped state);
            otherwise the composed CardCanvas is the static hero (with a
            "Generating poster…" indicator while the accumulator runs). */}
        <div className={`cc-judge-visual${posterReady ? " is-flippable" : ""}`}>
          {posterReady ? (
            /* Button-like flip control (same role/buttonTabIndex/Enter/Space
               pattern as TeamMiniCanvas's 3D thumbnails): one toggle whose
               label announces what the NEXT click shows. Poster face first,
               sticker CardCanvas when flipped. */
            <div
              role="button"
              tabIndex={0}
              aria-pressed={flipped}
              aria-label={
                flipped
                  ? `show AI montage version for ${team.name}`
                  : `show sticker version for ${team.name}`
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
              {flipped ? (
                <CardCanvas
                  items={team.items}
                  layout={team.layout}
                  greeting={team.greeting.text}
                  cardRatioW={cardRatioW}
                  cardRatioH={cardRatioH}
                  ariaLabel={`${team.name} sticker card — ${readyCount} stickers placed`}
                />
              ) : (
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
              )}
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

          {/* Prompt transparency: the EXACT image-model prompt the accumulator
              sent for this team's poster, collapsible so it doesn't crowd the
              box. Visible whenever a prompt is known. */}
          {team.montagePromptText ? (
            <>
              <button
                type="button"
                className="cc-btn cc-btn-small"
                aria-expanded={showPrompt}
                aria-controls={`judge-prompt-${team.id}`}
                onClick={() => setShowPrompt((v) => !v)}
              >
                {showPrompt ? "Hide prompt" : "View prompt"}
              </button>
              {showPrompt ? (
                <pre id={`judge-prompt-${team.id}`} className="cc-prompt-view">
                  {team.montagePromptText}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>

        {/* RIGHT: the sticker prompts (scrollable) — only stickers actually
            on the card. */}
        <div className="cc-judge-prompts">
          <h3>Sticker prompts</h3>
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
      </div>

      <div className="cc-judge-actions">{actions}</div>
    </section>
  );
}
