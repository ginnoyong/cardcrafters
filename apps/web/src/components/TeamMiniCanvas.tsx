"use client";

/**
 * TeamMiniCanvas — the GM console's live-preview mini (`.cc-mini`): ONE card
 * per team in the bottom grid (`.cc-mini-grid`), a click-to-flip toggle
 * (AI-montage poster ⇄ composed sticker CardCanvas — same role/tabIndex/
 * Enter/Space pattern as TeamJudgeCard) in EVERY phase the grid renders
 * (LOBBY/GREETINGS/BUILD/REVEAL/RESULTS — the judge-box phases SCORING/
 * JUDGING replace the grid with TeamJudgeCard boxes).
 *
 * Flip-face geometry — the SAME contract as TeamJudgeCard: both faces
 * (poster img / CardBack placeholder / sticker CardCanvas) live inside the
 * SAME `.cc-montage` wrapper carrying the shared `montageFaceStyle`
 * inline geometry (aspect-ratio + --card-ratio-w/--card-ratio-h), and the
 * sticker CardCanvas runs with `fillContainer` so the Konva stage fills the
 * measured wrapper instead of doing its own viewport math. The mini card
 * therefore has ONE geometry source — the grid cell (`.cc-mini` is 240px
 * wide; `.cc-mini` locks its grid column with minmax(0,1fr) so the poster
 * img's intrinsic 800px can never blow the cell up, and the `.cc-mini
 * .cc-montage` rule drops the shared 70vh caps, which are irrelevant for a
 * 240px cell) — so poster and sticker faces are pixel-identical by
 * construction and can never overflow the cell.
 *
 * Pure projection component: no sockets, no store access ("use client" only
 * for the flip state + dynamic CardCanvas import — react-konva must never
 * evaluate during SSR).
 */

import { useState } from "react";
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

export default function TeamMiniCanvas({
  team,
  montageStatus,
  montageImageUrl,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
  preScoring,
}: {
  team: ClientTeam;
  montageStatus?: "generating" | "ready" | "fallback" | null;
  montageImageUrl?: string | null;
  /** Card aspect ratio (game config) — locks the mini poster box to the SAME
   *  ratio as the CardCanvas sticker card. */
  cardRatioW?: number;
  cardRatioH?: number;
  /** Whether the game is still pre-SCORING (LOBBY/GREETINGS/BUILD) — drives
   *  the empty-card placeholder copy on the sticker face (BUILD teaser vs
   *  finished-game note; see lib/empty-card-note.ts). The mini grid renders
   *  in every phase EXCEPT the judge-box phases (SCORING/JUDGING), so this
   *  must come from the Console's phase, not be assumed. Named preScoring —
   *  NOT `building` — because the Console already has a `building` const
   *  with a DIFFERENT meaning ("the BUILD phase has started"). */
  preScoring: boolean;
}) {
  // Flip state: false = default view (AI poster when ready, else the composed
  // CardCanvas), true = the other face. Only meaningful when the poster is
  // ready.
  const [flipped, setFlipped] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The poster face is the real AI montage only when it actually landed.
  const posterReady = montageStatus === "ready" && !!montageImageUrl;
  // ALWAYS flippable now (all phases — BUILD, REVEAL and RESULTS flip the
  // same way): with a ready poster the poster is the default face and the
  // flip target is the sticker CardCanvas; without one the sticker card is
  // the default and the flip target is the CardBack placeholder — a team
  // without a poster still gets a real two-face flip. Either way the
  // sticker CardCanvas lives in the SECOND face slot (one stable DOM
  // position — it never remounts when the poster arrives).
  const showingSticker = posterReady ? flipped : !flipped;

  return (
    <div className="cc-mini" aria-label={`live preview of ${team.name}'s card`}>
      <h3>
        {team.name} <span className="cc-muted">({team.label})</span>
      </h3>
      {/* Button-like flip control (TeamJudgeCard pattern): one toggle whose
          label announces what the NEXT click shows. Default face first (the
          ready poster, or the CardBack placeholder without one), sticker
          CardCanvas second. */}
      <div
        className="cc-mini-flip"
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
        data-testid={`gm-mini-flip-${team.id}`}
        onClick={() => setFlipped((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((v) => !v);
          }
        }}
      >
        {/* BOTH faces stay mounted; the flip toggles CSS `display` instead
            of conditionally remounting CardCanvas (a remount on every flip
            sized the fresh Konva stage into a zero-dimension container →
            blank canvas). The canvas also re-measures on every flip via its
            resizeSignal.

            BOTH faces carry the SAME `.cc-montage` + montageFaceStyle
            wrapper geometry (aspect-ratio + --card-ratio custom props): the
            poster img and the CardBack placeholder render INSIDE the
            wrapper, and the sticker CardCanvas runs fillContainer so its
            Konva stage fills the SAME measured box. One geometry source —
            the grid cell — so the faces are pixel-identical and the cell
            (240px, minmax(0,1fr)-locked) always contains them. */}
        <div style={{ display: showingSticker ? "none" : undefined }}>
          {posterReady ? (
            <div
              className="cc-montage"
              style={montageFaceStyle(cardRatioW, cardRatioH)}
              aria-label={`poster for ${team.name}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={montageImageUrl ?? ""}
                alt={`Finished poster for ${team.name}`}
                className="cc-montage-img"
              />
            </div>
          ) : (
            <CardBack
              greeting={team.greeting.text}
              montageStatus={montageStatus ?? null}
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
              exactly (the wrapper's inline aspect-ratio + the cell-locked
              width own the geometry — NO per-face viewport math), so poster
              and sticker never diverge and neither face can exceed the
              240px mini cell. */}
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
              building={preScoring}
              ariaLabel={`${team.name} card — ${readyCount} stickers placed`}
            />
          </div>
        </div>
      </div>
      {/* Montage (poster) accumulator status: while the poster pass is in
          flight show a small indicator line under the flip card (same
          contract as the judge boxes). */}
      {montageStatus === "generating" ? (
        <p className="cc-montage-status" aria-live="polite">
          Generating poster…
        </p>
      ) : null}
      <p className="cc-hint" aria-live="polite">
        {readyCount} sticker{readyCount === 1 ? "" : "s"} on the card
      </p>
    </div>
  );
}
