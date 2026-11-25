/**
 * PresenterTeamStage SSR (react-dom/server) — phase-aware empty-card faces,
 * unified-layout props (tally chip / accordion suppression / face geometry).
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
 * Unified-layout extension (SCORING/JUDGING reuse this stage): the stage now
 * also carries an optional tally chip (the shared JudgeScoreChip), an
 * optional card label badge, a `showPromptAccordions` switch (SCORING
 * suppresses the prompt accordions — prompts are still anonymous there), and
 * renders BOTH card faces inside the shared `montageFaceStyle` wrapper
 * geometry with CardCanvas `fillContainer` (TeamMiniCanvas contract — the
 * wrapper owns the geometry, so the columns are pixel-identical by
 * construction). The presenter SCORING tests at the bottom assert the
 * scoring-stage wiring: 0-prompt team → greeting + EMPTY_CARD_FINISHED on
 * both faces, and NO legacy `/api/games/.../scoring-card/` <img> anywhere in
 * the component's markup (the PNG path is only a presenter-client fallback).
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
  // The phase-aware empty-card copy (lib/empty-card-note.ts) is a pure
  // helper — safe to import here so the stub can surface the exact note the
  // real CardCanvas would draw for the `building` value it received.
  const { emptyCardNote } = await import("@/lib/empty-card-note");
  return {
    // next/dynamic(loader, opts) — called once at PresenterTeamStage module
    // scope. The loader is deliberately NEVER invoked (react-konva stays
    // unloaded); a synchronous stub stands in for CardCanvas and mirrors the
    // props it receives.
    default: () =>
      function CardCanvasStub(props: Record<string, unknown>) {
        return React.createElement(
          "div",
          {
            className: "cc-canvas-wrap",
            "data-testid": "card-canvas-stub",
            "data-greeting": typeof props.greeting === "string" ? props.greeting : "",
            // CardCanvas defaults building=true (BUILD teaser); a post-BUILD
            // surface must pass building={false} explicitly.
            "data-building": props.building === false ? "false" : "true",
            "data-fill-container": props.fillContainer === true ? "true" : "false",
            // The exact empty-card note the real CardCanvas renders (under
            // the greeting) for the building value it received.
            "data-empty-note": emptyCardNote(props.building === false ? false : true),
            "data-aria-label": typeof props.ariaLabel === "string" ? props.ariaLabel : "",
          },
        );
      },
  };
});

import PresenterTeamStage from "@/components/PresenterTeamStage";
import { EMPTY_CARD_FINISHED } from "@/lib/empty-card-note";
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

describe("PresenterTeamStage (SSR) — unified-layout props", () => {
  it("renders the tally chip with votes (JudgeScoreChip contract)", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
        tally={{ avg: 7.5, count: 3 }}
      />,
    );
    expect(html).toContain("cc-judge-score");
    expect(html).toContain("7.5 avg · 3 votes");
  });

  it("renders the tally chip as 'no votes yet' for a null tally", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
        tally={null}
      />,
    );
    expect(html).toContain("cc-judge-score");
    expect(html).toContain("no votes yet");
  });

  it("renders NO tally chip when tally is omitted (REVEAL/RESULTS default)", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );
    expect(html).not.toContain("cc-judge-score");
    expect(html).not.toContain("no votes yet");
  });

  it("shows the card label badge when cardLabel is provided", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
        cardLabel="Card B"
      />,
    );
    expect(html).toContain("cc-badge");
    expect(html).toContain("Card B");
  });

  it("showPromptAccordions={false} suppresses BOTH prompt accordions", () => {
    const withAccordions = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );
    expect(withAccordions).toContain("View montage prompt");
    expect(withAccordions).toContain("View sticker prompts");

    const without = renderToStaticMarkup(
      <PresenterTeamStage
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
        showPromptAccordions={false}
      />,
    );
    expect(without).not.toContain("View montage prompt");
    expect(without).not.toContain("View sticker prompts");
  });

  it("BOTH card faces carry the SAME montageFaceStyle geometry (poster img + sticker)", () => {
    // Ready poster: the LEFT face is the real <img>, the RIGHT face the
    // fillContainer CardCanvas — both must sit in identical .cc-montage
    // wrappers (aspect-ratio + --card-ratio custom props), so the columns
    // are pixel-identical by construction.
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        cardRatioW={5}
        cardRatioH={7}
        testId="stage"
        isWinner={false}
        isPeoplesChoice={false}
        team={makeTeam({ montageStatus: "ready", montageImageUrl: "/m/team-1.png" })}
      />,
    );
    const styles = montageStyles(html);
    expect(styles.length).toBe(2);
    expect(styles[0]).toBe(styles[1]);
    expect(styles[0]).toContain("aspect-ratio:5 / 7");
    expect(styles[0]).toContain("--card-ratio-w:5");
    expect(styles[0]).toContain("--card-ratio-h:7");
    // The poster img face and both canvas faces fill the shared wrapper.
    expect(html).toContain('data-fill-container="true"');
    expect(html).toContain('class="cc-montage-img"');
  });
});

describe("PresenterTeamStage (SSR) — presenter SCORING stage wiring", () => {
  // The unified SCORING stage: the same side-by-side PresenterTeamStage the
  // REVEAL/RESULTS stage uses, with the prompt accordions suppressed
  // (prompts are still anonymous during SCORING), the card label badge, the
  // live tally chip, and — for a 0-prompt team — the greeting + finished
  // note on BOTH faces instead of a blank card. (presenter-client itself is
  // a client component with sockets/hooks — per the SSR-test pattern this
  // asserts the stage component the scoring path renders, not the client.)
  const SCORING_PROPS = {
    ...COMMON_PROPS,
    showPromptAccordions: false,
    tally: null,
    cardLabel: "Card A",
  };

  it("a 0-prompt team renders BOTH faces with the greeting + EMPTY_CARD_FINISHED", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...SCORING_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );

    // Both faces mounted, both post-BUILD, both carrying the greeting.
    const stubs = html.match(/data-building="[^"]*"/g) ?? [];
    expect(stubs.length).toBe(2);
    expect(stubs.every((s) => s === 'data-building="false"')).toBe(true);
    const greetings = html.match(/data-greeting="[^"]*"/g) ?? [];
    expect(greetings.length).toBe(2);
    expect(greetings.every((g) => g.includes("A craft a day keeps the boredom away"))).toBe(
      true,
    );
    // The finished-game note (never the BUILD teaser) on both faces.
    const notes = html.match(/data-empty-note="[^"]*"/g) ?? [];
    expect(notes.length).toBe(2);
    expect(notes.every((n) => n.includes(EMPTY_CARD_FINISHED))).toBe(true);
    expect(html).not.toContain("Stickers will appear here");
  });

  it("the scoring stage NEVER renders the legacy /api/games/.../scoring-card/ img", () => {
    // The PNG scoring-card path is only a presenter-client FALLBACK when the
    // cardId→team lookup misses — the component (primary path) must not emit
    // it at all.
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...SCORING_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );
    expect(html).not.toContain("scoring-card");
    expect(html).not.toContain("/api/games/");
  });

  it("the scoring stage shows the label badge + tally chip but NO accordions", () => {
    const html = renderToStaticMarkup(
      <PresenterTeamStage
        {...SCORING_PROPS}
        team={makeTeam({ montageStatus: "fallback" })}
      />,
    );
    expect(html).toContain("Card A");
    expect(html).toContain("no votes yet");
    expect(html).not.toContain("View montage prompt");
    expect(html).not.toContain("View sticker prompts");
  });
});
