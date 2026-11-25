"use client";

/**
 * TeamShowcase — the shared montage-poster showcase layout (the player's
 * post-SCORING screen: JUDGING/REVEAL/RESULTS — during SCORING the player's
 * "Our card" flip section supersedes it — and the presenter's one-at-a-time
 * stage).
 *
 * Layout (top → bottom):
 *   .cc-showcase-main  MAIN poster hero:
 *     - montageStatus "ready"      → the finished AI poster image;
 *     - montageStatus "generating" → the composed CardCanvas + a
 *                                    "Generating poster…" indicator (the
 *                                    composed card stays the live view while
 *                                    the poster pass is in flight);
 *     - "fallback"/absent          → the composed CardCanvas as the hero.
 *   .cc-showcase-subs  SUB bottom row (2 columns):
 *     - LEFT  : the sticker CardCanvas (the composed card) — ONLY when the
 *               hero is the poster; when the canvas already IS the hero a
 *               second copy below would be a duplicate, so it is skipped;
 *     - RIGHT : the team's prompts list (`"promptRaw" — nickname` per row,
 *               from team.items).
 *
 * Pure projection component: everything comes from the ClientTeam snapshot —
 * no sockets, no store access. CardCanvas is imported dynamically (ssr:false)
 * like every other consumer: react-konva must never evaluate during SSR.
 */

import type { CSSProperties } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W } from "@cardcrafters/shared";
import type { ClientTeam } from "@/lib/store";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});

export default function TeamShowcase({
  team,
  testId,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
}: {
  team: ClientTeam;
  testId?: string;
  /** Card aspect ratio (game config) — the montage poster box locks to the
   *  SAME ratio as the CardCanvas sticker card so the hero/sub cards render
   *  at identical dimensions. */
  cardRatioW?: number;
  cardRatioH?: number;
}) {
  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The composed card is the hero whenever the poster is not on screen yet
  // (generating indicator rides along; fallback/absent keep the card alone).
  const posterReady = team.montageStatus === "ready" && !!team.montageImageUrl;

  return (
    <section
      className="cc-showcase"
      aria-label={`Team ${team.label} showcase`}
      data-testid={testId}
    >
      <div className="cc-showcase-main">
        {posterReady ? (
          <div
            className="cc-montage"
            style={{
              aspectRatio: `${cardRatioW} / ${cardRatioH}`,
              "--card-ratio-w": cardRatioW,
              "--card-ratio-h": cardRatioH,
            } as CSSProperties}
            aria-label={`poster for Team ${team.label}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={team.montageImageUrl ?? ""}
              alt={`Finished poster for Team ${team.label}`}
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
              building={false}
              ariaLabel={`Team ${team.label} card — ${readyCount} stickers placed`}
            />
            {team.montageStatus === "generating" ? (
              <p className="cc-montage-status" aria-live="polite">
                Generating poster…
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="cc-showcase-subs">
        {posterReady ? (
          <div className="cc-showcase-sub" data-testid={testId ? `${testId}-sticker-sub` : undefined}>
            <CardCanvas
              items={team.items}
              layout={team.layout}
              greeting={team.greeting.text}
              cardRatioW={cardRatioW}
              cardRatioH={cardRatioH}
              building={false}
              ariaLabel={`Team ${team.label} sticker card — ${readyCount} stickers placed`}
            />
          </div>
        ) : null}
        <div className="cc-showcase-sub" data-testid={testId ? `${testId}-prompts-sub` : undefined}>
          <h3>Prompts</h3>
          {team.items.length > 0 ? (
            <ul className="cc-showcase-prompts">
              {team.items.map((item) => (
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
    </section>
  );
}
