"use client";

/**
 * CardBack — the placeholder "poster" face for flip cards when a team has no
 * ready AI-montage poster (still generating, or the accumulator fell back —
 * e.g. "no sized READY items to montage"). Styled like a playing-card back
 * (.cc-card-back: sage lattice + brass diagonals) carrying the team's
 * greeting text, so EVERY flip surface has a real second face and the flip
 * control always has a purpose — a team without a poster is no longer stuck
 * as a single static sticker card.
 *
 * Sizing reuses .cc-montage (width:100% + max-width cap + the inline
 * aspect-ratio the callers pass) so the back renders at EXACTLY the same
 * box as a real poster or the CardCanvas sticker card — the flip never
 * resizes.
 *
 * Pure projection component: no sockets, no store access, plain DOM (safe
 * to import statically — unlike CardCanvas, no react-konva here).
 */

import type { CSSProperties } from "react";

export default function CardBack({
  greeting,
  montageStatus,
  cardRatioW,
  cardRatioH,
}: {
  /** The team's greeting — the "title" on the card back. */
  greeting: string;
  /** Why there is no poster: drives the small note line on the back. */
  montageStatus: "generating" | "ready" | "fallback" | null | undefined;
  /** Card aspect ratio (game config) — same box as the poster/sticker faces. */
  cardRatioW: number;
  cardRatioH: number;
}) {
  const note =
    montageStatus === "generating"
      ? "AI poster still generating…"
      : montageStatus === "fallback"
        ? "No AI poster was generated"
        : "AI poster coming soon…";

  return (
    <div
      className="cc-montage cc-card-back"
      style={
        {
          aspectRatio: `${cardRatioW} / ${cardRatioH}`,
          "--card-ratio-w": cardRatioW,
          "--card-ratio-h": cardRatioH,
        } as CSSProperties
      }
    >
      <p className="cc-card-back-greeting">“{greeting}”</p>
      <p className="cc-card-back-note">{note}</p>
    </div>
  );
}
