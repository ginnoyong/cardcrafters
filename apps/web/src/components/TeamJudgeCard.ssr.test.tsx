/**
 * TeamJudgeCard SSR (react-dom/server) — flip-face geometry parity.
 *
 * Verifies (string-level, no DOM) that BOTH mounted flip faces — the poster
 * face and the sticker face — render elements carrying the SAME inline
 * aspect-ratio + --card-ratio-w/--card-ratio-h custom props (the shared
 * montageFaceStyle geometry). This is the contract behind Fix 2: poster and
 * sticker faces render at identical sizes because the wrapper geometry is
 * identical by construction; CardCanvas fillContainer then fills that box.
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
    // next/dynamic(loader, opts) — called once at TeamJudgeCard module scope.
    // The loader is deliberately NEVER invoked (react-konva stays unloaded);
    // a synchronous stub stands in for CardCanvas.
    default: () =>
      function CardCanvasStub(props: Record<string, unknown>) {
        return React.createElement("div", {
          className: "cc-canvas-wrap",
          "data-testid": "card-canvas-stub",
          "data-fill-container": props.fillContainer === true ? "true" : "false",
          "data-greeting": typeof props.greeting === "string" ? props.greeting : "",
        });
      },
  };
});

import TeamJudgeCard from "@/components/TeamJudgeCard";
import type { ClientTeam } from "@/lib/store";

/** Minimal ClientTeam projection (fields TeamJudgeCard reads). */
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
    ...overrides,
  };
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
const COMMON_PROPS = {
  cardLabel: "Card A",
  tally: null,
  actions: <button type="button">pick</button>,
  testId: "judge",
  cardRatioW: RATIO_W,
  cardRatioH: RATIO_H,
};

describe("TeamJudgeCard (SSR) — flip-face geometry parity", () => {
  it("poster + sticker faces carry the SAME aspect-ratio/--card-ratio geometry", () => {
    const html = renderToStaticMarkup(
      <TeamJudgeCard
        {...COMMON_PROPS}
        team={makeTeam({
          montageStatus: "ready",
          montageImageUrl: "/static/montages/g1/t1/poster.png",
        })}
      />,
    );

    // Both faces mounted (persistent both-face rendering): the poster
    // <img> AND the CardCanvas stub are both present.
    expect(html).toContain(`src="/static/montages/g1/t1/poster.png"`);
    expect(html).toContain(`data-testid="card-canvas-stub"`);

    const styles = montageStyles(html);
    expect(styles.length).toBe(2);
    // IDENTICAL inline geometry on poster face and sticker face — the shared
    // montageFaceStyle object, by construction.
    expect(styles[0]).toBe(styles[1]!);
    expect(styles[0]).toContain(`aspect-ratio:${RATIO_W} / ${RATIO_H}`);
    expect(styles[0]).toContain(`--card-ratio-w:${RATIO_W}`);
    expect(styles[0]).toContain(`--card-ratio-h:${RATIO_H}`);

    // The sticker CardCanvas is told to FILL the shared wrapper (the
    // aspect-ratio wrapper owns the geometry; no JS ratio/clamp math).
    expect(html).toContain(`data-fill-container="true"`);
  });

  it("CardBack + sticker faces carry the SAME geometry when no poster is ready", () => {
    const html = renderToStaticMarkup(
      <TeamJudgeCard
        {...COMMON_PROPS}
        team={makeTeam({ montageStatus: "generating", montageImageUrl: null })}
      />,
    );

    // CardBack placeholder face + CardCanvas stub face.
    expect(html).toContain("cc-card-back");
    expect(html).toContain(`data-testid="card-canvas-stub"`);

    const styles = montageStyles(html);
    expect(styles.length).toBe(2);
    expect(styles[0]).toBe(styles[1]!);
    expect(styles[0]).toContain(`aspect-ratio:${RATIO_W} / ${RATIO_H}`);
    expect(styles[0]).toContain(`--card-ratio-w:${RATIO_W}`);
    expect(styles[0]).toContain(`--card-ratio-h:${RATIO_H}`);
  });
});
