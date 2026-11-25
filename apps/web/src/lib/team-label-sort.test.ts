/**
 * team-label-sort — the GM mini grid must always read "Card A → Card E"
 * regardless of the snapshot's (shuffled) team order.
 *
 * TEAM_LABELS (apps/web/src/server/game/hub.ts) is A..J — MAX_TEAMS = 10,
 * single letters only — so the pool supports exactly the 10-team case tested
 * here ("Card B" < "Card J"); the numeric-suffix branch covers the
 * `Card ${i + 1}` fallback shape for pools beyond the letters.
 */

import { describe, expect, it } from "vitest";

import { compareTeamLabels, sortByTeamLabel } from "./team-label-sort";

describe("sortByTeamLabel — GM mini grid ascending card order", () => {
  it("sorts out-of-order team labels ascending (A → E)", () => {
    const teams = [
      { id: "t3", label: "C" },
      { id: "t1", label: "A" },
      { id: "t5", label: "E" },
      { id: "t2", label: "B" },
      { id: "t4", label: "D" },
    ];
    expect(sortByTeamLabel(teams).map((t) => t.label)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("handles the full 10-team pool — 'Card B' < 'Card J' ordering", () => {
    const labels = ["J", "B", "H", "A", "F", "D", "I", "C", "G", "E"] as const;
    const teams = labels.map((label, i) => ({ id: `t${i}`, label }));
    expect(sortByTeamLabel(teams).map((t) => t.label)).toEqual([
      "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
    ]);
  });

  it("sorts full card labels the same way ('Card A' < 'Card B' < 'Card J')", () => {
    const teams = [
      { id: "t2", label: "Card B" },
      { id: "t10", label: "Card J" },
      { id: "t1", label: "Card A" },
    ];
    expect(sortByTeamLabel(teams).map((t) => t.id)).toEqual(["t1", "t2", "t10"]);
  });

  it("compares the numeric fallback label numerically (Card 9 < Card 11)", () => {
    expect(compareTeamLabels("Card 9", "Card 11")).toBeLessThan(0);
    expect(compareTeamLabels("Card 11", "Card 9")).toBeGreaterThan(0);
  });

  it("does not mutate the input array", () => {
    const teams = [{ id: "t2", label: "B" }, { id: "t1", label: "A" }];
    const copy = [...teams];
    sortByTeamLabel(teams);
    expect(teams).toEqual(copy);
  });

  it("is stable for equal labels", () => {
    const teams = [
      { id: "first", label: "A" },
      { id: "second", label: "A" },
    ];
    expect(sortByTeamLabel(teams).map((t) => t.id)).toEqual(["first", "second"]);
  });
});
