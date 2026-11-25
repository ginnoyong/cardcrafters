/**
 * PresenterTeamStage SSR (react-dom/server) — phase-aware empty-card faces.
 *
 * Regression (REVEAL after the winner pick): for a team whose card is EMPTY
 * (0 prompts → 0 stickers), BOTH stage faces — the AI-montage poster stand-in
 * (CardCanvas while the poster is generating/fallback) and the sticker card —
 * used to show the BUILD-phase teaser "Stickers will appear here as your team
 * creates them…" after the game was already over. The stage is REVEAL/RESULTS
 * only, so BOTH faces must be told `building={false}` (finished-game note,
 * "This card stayed blank this round.") while the greeting still rides
 * through. The copy decision itself is unit-tested in
 * lib/empty-card-note.test.ts; this file asserts the PROP WIRING at the SSR
 * string level (same technique as TeamJudgeCard.ssr.test.tsx).
 *
 * next/dynamic is vi-mocked to a synchronous stub so the module renders under
 * renderToStaticMarkup without pulling react-konva (which must never evaluate
 * during SSR) — same reason the real component imports it with ssr:false.
 * No jsdom: kept to SSR string assertions only.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    // next/dynamic(loader, opts) — called once at PresenterTeamStage module
    // scope. The loader is deliberately NEVER invoked (react-konva stays
    // unloaded); a synchronous stub stands in for CardCanvas and mirrors the
    // props it receives.
    default: () =>
      function CardCanvasStub(props: Record<string, unknown>) {
        return React.createElement("div", {
          className: "cc-canvas-wrap",
          "data-testid": "card-canvas-stub",
          "data-greeting": typeof props.greeting === "string" ? props.greeting : "",
          // CardCanvas defaults building=true (BUILD teaser); a post-BUILD
          // surface must pass building={false} explicitly.
          "data-building": props.building === false ? "false" : "true",
          "data-aria-label": typeof props.ariaLabel === "string" ? props.ariaLabel : "",
        });
      },
  };
});

import PresenterTeamStage from "@/components/PresenterTeamStage";
import type { ClientTeam } from "@/lib/store";

/** Minimal ClientTeam projection (fields PresenterTeamStage reads). */
function makeTeam(overrides: Partial<ClientTeam> = {}): ClientTeam {
  return {
    id: "team-1",
    name: "Team Alpha",
    label: "Card A",
    memberCount: 2,
    members: [],
    itemCount: 0,
    greeting: { text: "A craft a day keeps the boredom away", status: "approved" },
    items: [],
    layout: null,
    activity: [],
    critique: null,
    montageStatus: null,
    montageImageUrl: null,
    montagePromptText: null,
    ...overrides,
  };
}

const COMMON_PROPS = {
  cardRatioW: 3,
  cardRatioH: 4,
  testId: "stage",
  isWinner: false,
  isPeoplesChoice: false,
};

describe("PresenterTeamStage (SSR) — phase-aware empty-card faces", () => {
  it("BOTH faces (poster stand-in + sticker card) get building=false in REVEAL/RESULTS", () => {
    // The bug surface: montage FALLBACK (no ready poster → the CardCanvas
    // stand-in IS the poster face) + an empty card. Both mounted CardCanvas
    // faces must carry building={false} — the teaser must never show here.
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );

    // Two CardCanvas faces are mounted (poster stand-in + sticker card).
    const stubs = html.match(/data-building="[^"]*"/g) ?? [];
    expect(stubs.length).toBe(2);
    expect(stubs.every((s) => s === 'data-building="false"')).toBe(true);
    expect(html).not.toContain('data-building="true"');
  });

  it("the greeting still rides through to both empty faces", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );
    const greetings = html.match(/data-greeting="[^"]*"/g) ?? [];
    expect(greetings.length).toBe(2);
    expect(greetings.every((g) => g.includes("A craft a day keeps the boredom away"))).toBe(
      true,
    );
  });

  it("the winner banner still shows above the cards when the viewed team won", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
        isWinner
      />,
    );
    expect(html).toContain("stage-winner-banner");
    // ...and the faces remain post-BUILD.
    expect(html).not.toContain('data-building="true"');
  });
});
