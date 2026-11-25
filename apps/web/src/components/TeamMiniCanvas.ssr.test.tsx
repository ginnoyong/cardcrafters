/**
 * TeamMiniCanvas SSR (react-dom/server) — mini flip-face geometry parity.
 *
 * The GM console's mini grid (`.cc-mini`, 240px cells) must render BOTH
 * flip faces — the poster/CardBack face and the sticker CardCanvas face —
 * inside the SAME `.cc-montage` wrapper carrying the SAME inline
 * aspect-ratio + --card-ratio-w/--card-ratio-h geometry (the shared
 * montageFaceStyle object, the same contract TeamJudgeCard's faces use).
 * The mini card has ONE geometry source — the grid cell — so the poster
 * face can never render bigger than the sticker face and neither face can
 * overflow the cell.
 *
 * Two string-level guarantees (no DOM):
 *   1. Both faces' wrapper styles are IDENTICAL and contain ONLY the
 *      aspect-ratio + custom props — NO viewport-derived inline caps
 *      (max-height/max-width), which on a large GM monitor would resolve
 *      to sizes exceeding the 240px cell (the mini's geometry comes from
 *      the cell via .cc-mini's minmax(0,1fr) column + the .cc-mini
 *      .cc-montage cap removal, never from the viewport).
 *   2. The sticker CardCanvas receives fillContainer (fills the measured
 *      wrapper — no JS ratio/viewport math) and the phase-driven
 *      building flag passes through untouched (BUILD teaser vs
 *      post-BUILD "stayed blank" note — the 7de347a phase behavior).
 *
 * next/dynamic is vi-mocked to a synchronous stub so the module renders
 * under renderToStaticMarkup without pulling react-konva (which must never
 * evaluate during SSR) — same reason the real component imports it with
 * ssr:false. No jsdom: kept to SSR string assertions only.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    // next/dynamic(loader, opts) — called once at TeamMiniCanvas module
    // scope. The loader is deliberately NEVER invoked (react-konva stays
    // unloaded); a synchronous stub stands in for CardCanvas.
    default: () =>
      function CardCanvasStub(props: Record<string, unknown>) {
        return React.createElement("div", {
          className: "cc-canvas-wrap",
          "data-testid": "card-canvas-stub",
          "data-fill-container": props.fillContainer === true ? "true" : "false",
          "data-greeting": typeof props.greeting === "string" ? props.greeting : "",
          // Phase-aware empty-card placeholder wiring (lib/empty-card-note.ts):
          // CardCanvas defaults building=true (BUILD teaser); the mini grid
          // renders in EVERY phase, so TeamMiniCanvas must forward its
          // preScoring prop — the stub mirrors exactly what it receives.
          "data-building": props.building === false ? "false" : "true",
        });
      },
  };
});

import TeamMiniCanvas from "@/components/TeamMiniCanvas";
import type { ClientTeam } from "@/lib/store";

/** Minimal ClientTeam projection (fields TeamMiniCanvas reads). */
function makeTeam(overrides: Partial<ClientTeam> = {}): ClientTeam {
  return {
    id: "team-1",
    name: "Team Alpha",
    label: "Card A",
    memberCount: 0,
    itemCount: 0,
    greeting: { text: "A craft a day keeps the boredom away", status: "approved" },
    items: [],
    layout: null,
    activity: [],
    ...overrides,
  } as unknown as ClientTeam;
}

/** Style strings of every element carrying the cc-montage face wrapper. */
function montageStyles(html: string): string[] {
  const styles: string[] = [];
  for (const tag of html.match(/<div\b[^>]*>/g) ?? []) {
    if (/class="[^"]*cc-montage/.test(tag)) {
      const m = tag.match(/style="([^"]*)"/);
      if (m) styles.push(m[1]!);
    }
  }
  return styles;
}

const RATIO_W = 5; // deliberately NOT the 3/4 default — proves propagation
const RATIO_H = 7;

describe("TeamMiniCanvas (SSR) — mini flip-face geometry parity", () => {
  it("poster + sticker faces carry the SAME aspect-ratio/--card-ratio geometry", () => {
    const html = renderToStaticMarkup(
      <TeamMiniCanvas
        team={makeTeam()}
        montageStatus="ready"
        montageImageUrl="/static/montages/g1/t1/poster.png"
        preScoring={false}
        cardRatioW={RATIO_W}
        cardRatioH={RATIO_H}
      />,
    );

    // Both faces mounted (persistent both-face rendering): the poster
    // <img> AND the CardCanvas stub are both present.
    expect(html).toContain(`src="/static/montages/g1/t1/poster.png"`);
    expect(html).toContain(`data-testid="card-canvas-stub"`);

    const styles = montageStyles(html);
    expect(styles.length).toBe(2);
    // IDENTICAL inline geometry on the poster face and the sticker face —
    // the shared montageFaceStyle object, by construction.
    expect(styles[0]).toBe(styles[1]!);
    expect(styles[0]).toContain(`aspect-ratio:${RATIO_W} / ${RATIO_H}`);
    expect(styles[0]).toContain(`--card-ratio-w:${RATIO_W}`);
    expect(styles[0]).toContain(`--card-ratio-h:${RATIO_H}`);

    // NO viewport caps in the inline geometry: the mini faces are sized by
    // the grid CELL (240px, minmax(0,1fr)-locked column + .cc-mini
    // .cc-montage cap removal). A viewport-derived inline cap (70vh-based)
    // could exceed the cell on a large GM monitor — the exact bug this
    // contract prevents.
    expect(styles[0]).not.toMatch(/max-height|max-width/);

    // The sticker CardCanvas is told to FILL the shared wrapper (the
    // aspect-ratio wrapper owns the geometry; no JS ratio/clamp math).
    expect(html).toContain(`data-fill-container="true"`);
  });

  it("CardBack + sticker faces carry the SAME geometry when no poster is ready", () => {
    // 0-prompt teams (no poster ever lands — the accumulator fails open to
    // FALLBACK) flip to the CardBack placeholder. Its wrapper must carry
    // the SAME geometry as the sticker face, so the back face is
    // pixel-identical to the sticker card and cannot overflow the cell.
    const html = renderToStaticMarkup(
      <TeamMiniCanvas
        team={makeTeam({ montageStatus: "fallback", montageImageUrl: null })}
        preScoring={false}
        cardRatioW={RATIO_W}
        cardRatioH={RATIO_H}
      />,
    );

    expect(html).toContain(`data-testid="card-canvas-stub"`);
    const styles = montageStyles(html);
    expect(styles.length).toBe(2);
    expect(styles[0]).toBe(styles[1]!);
    expect(styles[0]).toContain(`aspect-ratio:${RATIO_W} / ${RATIO_H}`);
    expect(styles[0]).not.toMatch(/max-height|max-width/);
    expect(html).toContain(`data-fill-container="true"`);
  });

  it("forwards preScoring into the sticker face's building flag (BUILD teaser vs post-BUILD note)", () => {
    // The mini grid renders in EVERY phase: pre-SCORING (LOBBY/GREETINGS/
    // BUILD) keeps the classic teaser; post-BUILD surfaces must show the
    // finished-game "stayed blank" note instead — the phase-driven behavior
    // from 7de347a must not regress.
    const building = renderToStaticMarkup(
      <TeamMiniCanvas
        team={makeTeam({ montageStatus: "fallback", montageImageUrl: null })}
        preScoring={true}
        cardRatioW={RATIO_W}
        cardRatioH={RATIO_H}
      />,
    );
    expect(building).toContain(`data-building="true"`);
    expect(building).not.toContain(`data-building="false"`);

    const finished = renderToStaticMarkup(
      <TeamMiniCanvas
        team={makeTeam({ montageStatus: "fallback", montageImageUrl: null })}
        preScoring={false}
        cardRatioW={RATIO_W}
        cardRatioH={RATIO_H}
      />,
    );
    expect(finished).toContain(`data-building="false"`);
    expect(finished).not.toContain(`data-building="true"`);
  });
});
