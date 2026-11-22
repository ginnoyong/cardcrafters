import { describe, expect, it } from "vitest";

import {
  errorSchema,
  gmKickSchema,
  gmRegenGreetingSchema,
  gmRemoveItemSchema,
  gmStopBuildSchema,
  gmStopScoringSchema,
  greetingVariationsSchema,
  joinSchema,
  judgePickSchema,
  layoutCompositionSchema,
  layoutUpdatedSchema,
  moderationSchema,
  phaseChangedSchema,
  promptSubmitSchema,
  promptValidationSchema,
  revealAckSchema,
  scoreSubmitSchema,
  styleDerivationSchema,
  winnerAnnouncedSchema,
  itemPendingSchema,
  itemReadySchema,
  itemRejectedSchema,
  itemFailedSchema,
  itemRemovedSchema,
  layoutCritiqueSchema,
  montageGradingSchema,
  layoutMontageSchema,
} from "./schemas";

/** JSON round-trip helper: serialize, parse, re-parse through the schema. */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

// ---------------------------------------------------------------------------
// AI output schemas
// ---------------------------------------------------------------------------

describe("promptValidationSchema", () => {
  const valid = {
    valid: true,
    reason: "",
    normalized_subject: "birthday cake",
  };

  it("accepts a valid fixture", () => {
    expect(promptValidationSchema.parse(valid)).toEqual(valid);
  });

  it("accepts optional example_fix", () => {
    expect(
      promptValidationSchema.parse({ ...valid, example_fix: "a cake for a birthday" }),
    ).toEqual({ ...valid, example_fix: "a cake for a birthday" });
  });

  it("rejects missing reason", () => {
    expect(() =>
      promptValidationSchema.parse({ valid: true, normalized_subject: "x" }),
    ).toThrow();
  });

  it("rejects wrong-typed and extra fields", () => {
    expect(() => promptValidationSchema.parse({ ...valid, valid: "yes" })).toThrow();
    expect(() => promptValidationSchema.parse({ ...valid, extra: 1 })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(promptValidationSchema, valid)).toEqual(valid);
  });
});

describe("moderationSchema", () => {
  const valid = { safe: true, category: "none", reason: "ok" };

  it("accepts a valid fixture", () => {
    expect(moderationSchema.parse(valid)).toEqual(valid);
  });

  it("allows contentious_figure (blocked) and none", () => {
    expect(moderationSchema.parse({ safe: false, category: "contentious_figure", reason: "politician" }).category).toBe("contentious_figure");
  });

  it("rejects unknown category 'politics'", () => {
    expect(() => moderationSchema.parse({ safe: true, category: "politics", reason: "" })).toThrow();
  });

  it("rejects missing category", () => {
    expect(() => moderationSchema.parse({ safe: true, reason: "" })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(moderationSchema, valid)).toEqual(valid);
  });
});

describe("greetingVariationsSchema", () => {
  const valid = { variations: ["Happy birthday!", "Many happy returns!"] };

  it("accepts a valid fixture", () => {
    expect(greetingVariationsSchema.parse(valid)).toEqual(valid);
  });

  it("rejects empty variations array", () => {
    expect(() => greetingVariationsSchema.parse({ variations: [] })).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() => greetingVariationsSchema.parse({ ...valid, mood: "happy" })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(greetingVariationsSchema, valid)).toEqual(valid);
  });
});

describe("styleDerivationSchema", () => {
  const valid = {
    styleName: "Retro Pastel",
    palette: ["#ff6b9d", "#ffe66d", "#4ecdc4"],
    lineWeight: "medium",
    mood: "playful",
    imagePromptSuffix: "flat pastel illustration, bold outlines",
  };

  it("accepts a valid fixture", () => {
    expect(styleDerivationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects bad lineWeight and bad palette hex", () => {
    expect(() => styleDerivationSchema.parse({ ...valid, lineWeight: "thick" })).toThrow();
    expect(() => styleDerivationSchema.parse({ ...valid, palette: ["red"] })).toThrow();
  });

  it("rejects missing imagePromptSuffix", () => {
    const { imagePromptSuffix: _drop, ...rest } = valid;
    expect(() => styleDerivationSchema.parse(rest)).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(styleDerivationSchema, valid)).toEqual(valid);
  });
});

describe("layoutCompositionSchema", () => {
  const valid = {
    focalPoint: { x: 500, y: 400 },
    groups: [{ itemIds: ["i1", "i2"], cx: 300, cy: 300, spread: 120 }],
    textZone: { x: 100, y: 800, w: 800, h: 120 },
    suggestedGreetingStyle: { align: "center", y: 850 },
  };

  it("accepts a valid fixture", () => {
    expect(layoutCompositionSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing focalPoint", () => {
    const { focalPoint: _drop, ...rest } = valid;
    expect(() => layoutCompositionSchema.parse(rest)).toThrow();
  });

  it("rejects out-of-space coordinates and empty groups", () => {
    expect(() =>
      layoutCompositionSchema.parse({ ...valid, focalPoint: { x: 1200, y: 0 } }),
    ).toThrow();
    expect(() => layoutCompositionSchema.parse({ ...valid, groups: [] })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(layoutCompositionSchema, valid)).toEqual(valid);
  });

  // -- Semantic-grouping extension (backward compatible) --------------------

  const extended = {
    ...valid,
    groups: [
      { itemIds: ["i1", "i2"], cx: 300, cy: 300, spread: 120, subject: "nature scene" },
    ],
    hints: [
      { itemId: "i1", role: "focal", tiltToward: "i2", importance: 1 },
      { itemId: "i2", role: "support", tiltToward: "group_center", importance: 0.5 },
    ],
  };

  it("accepts group subject + per-item hints (extension fields)", () => {
    expect(layoutCompositionSchema.parse(extended)).toEqual(extended);
  });

  it("extension fields are optional (pre-upgrade outputs still parse)", () => {
    expect(layoutCompositionSchema.parse(valid)).toEqual(valid);
    expect(
      layoutCompositionSchema.parse({
        ...valid,
        hints: [{ itemId: "i1" }],
      }).hints,
    ).toEqual([{ itemId: "i1" }]);
  });

  it("rejects bad hint values (importance out of range, unknown role, empty tiltToward)", () => {
    const bad = (h: Record<string, unknown>) =>
      layoutCompositionSchema.parse({ ...extended, hints: [h] });
    expect(() => bad({ itemId: "i1", importance: 1.5 })).toThrow();
    expect(() => bad({ itemId: "i1", importance: -0.1 })).toThrow();
    expect(() => bad({ itemId: "i1", role: "protagonist" })).toThrow();
    expect(() => bad({ itemId: "i1", tiltToward: "" })).toThrow();
    expect(() => bad({ itemId: "" })).toThrow();
  });

  // -- Unknown keys are STRIPPED, not rejected (live models add extras) ------

  it("strips unknown extra keys on the top level, groups, and hints", () => {
    expect(
      layoutCompositionSchema.parse({
        ...valid,
        spread_unit: "px",
        notes: "model freestyle",
        groups: [{ itemIds: ["i1", "i2"], cx: 300, cy: 300, spread: 120, unit: "px" }],
        hints: [{ itemId: "i1", role: "focal", confidence: 0.9 }],
      }),
    ).toEqual({ ...valid, hints: [{ itemId: "i1", role: "focal" }] });
  });

  it("still rejects missing/invalid required fields after stripping", () => {
    expect(() => layoutCompositionSchema.parse({ ...valid, groups: [] })).toThrow();
    expect(() =>
      layoutCompositionSchema.parse({ ...valid, hints: [{ itemId: "i1", importance: 9 }] }),
    ).toThrow();
  });

  it("rejects an out-of-range group subject shape", () => {
    expect(() =>
      layoutCompositionSchema.parse({
        ...valid,
        groups: [{ itemIds: ["i1"], cx: 300, cy: 300, spread: 120, subject: "" }],
      }),
    ).toThrow();
  });

  it("round-trips the extended contract through JSON", () => {
    expect(roundTrip(layoutCompositionSchema, extended)).toEqual(extended);
  });
});

describe("layoutCritiqueSchema", () => {
  const valid = {
    score: 82,
    issues: ["hero slightly off-center", "dead space in the lower-left corner"],
    focalOk: true,
  };

  it("accepts a valid fixture", () => {
    expect(layoutCritiqueSchema.parse(valid)).toEqual(valid);
  });

  it("accepts the empty-issues minimal verdict", () => {
    expect(layoutCritiqueSchema.parse({ score: 80, issues: [], focalOk: true })).toEqual({
      score: 80,
      issues: [],
      focalOk: true,
    });
  });

  it("rejects score 101, a non-integer score (101.5) and a negative score", () => {
    expect(() => layoutCritiqueSchema.parse({ ...valid, score: 101 })).toThrow();
    expect(() => layoutCritiqueSchema.parse({ ...valid, score: 101.5 })).toThrow();
    expect(() => layoutCritiqueSchema.parse({ ...valid, score: -1 })).toThrow();
  });

  it("rejects non-boolean focalOk (e.g. 'yes')", () => {
    expect(() => layoutCritiqueSchema.parse({ ...valid, focalOk: "yes" })).toThrow();
  });

  it("rejects an issue over 200 chars and more than 10 issues", () => {
    const long = "x".repeat(201);
    expect(() => layoutCritiqueSchema.parse({ ...valid, issues: [long] })).toThrow();
    expect(() =>
      layoutCritiqueSchema.parse({
        ...valid,
        issues: Array.from({ length: 11 }, (_, i) => `issue ${i}`),
      }),
    ).toThrow();
  });

  it("rejects missing/extra fields (strict)", () => {
    const { focalOk: _drop, ...rest } = valid;
    expect(() => layoutCritiqueSchema.parse(rest)).toThrow();
    expect(() => layoutCritiqueSchema.parse({ ...valid, confidence: 0.9 })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(layoutCritiqueSchema, valid)).toEqual(valid);
  });
});

describe("montageGradingSchema", () => {
  const valid = {
    temperature: 0.2,
    saturation: 1.1,
    contrast: 0.9,
    vignette: 0.3,
  };

  it("accepts a valid fixture", () => {
    expect(montageGradingSchema.parse(valid)).toEqual(valid);
  });

  it("accepts the exact bounds", () => {
    expect(montageGradingSchema.parse({ temperature: -1, saturation: 0.5, contrast: 0.5, vignette: 0 })).toEqual({ temperature: -1, saturation: 0.5, contrast: 0.5, vignette: 0 });
    expect(montageGradingSchema.parse({ temperature: 1, saturation: 1.5, contrast: 1.5, vignette: 1 })).toEqual({ temperature: 1, saturation: 1.5, contrast: 1.5, vignette: 1 });
  });

  it("rejects every field outside its documented bounds", () => {
    expect(() => montageGradingSchema.parse({ ...valid, temperature: 1.01 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, temperature: -1.01 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, saturation: 0.49 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, saturation: 1.51 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, contrast: 0.49 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, contrast: 1.51 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, vignette: -0.01 })).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, vignette: 1.01 })).toThrow();
  });

  it("rejects missing and extra fields (strict)", () => {
    const { vignette: _drop, ...rest } = valid;
    expect(() => montageGradingSchema.parse(rest)).toThrow();
    expect(() => montageGradingSchema.parse({ ...valid, sepia: 1 })).toThrow();
  });

  it("round-trips through JSON", () => {
    expect(roundTrip(montageGradingSchema, valid)).toEqual(valid);
  });
});

describe("layoutMontageSchema", () => {
  const valid = {
    focalPoint: { x: 500, y: 400 },
    groups: [{ itemIds: ["i1", "i2"], cx: 300, cy: 300, spread: 120, subject: "hero party" }],
    hints: [{ itemId: "i1", role: "focal", importance: 1 }],
    textZone: { x: 100, y: 800, w: 800, h: 120 },
    suggestedGreetingStyle: { align: "center", y: 850 },
    strategy: "character_montage",
    relaxOverlap: false,
  };

  it("accepts a valid montage (strategy + hints + relaxOverlap) and round-trips through JSON", () => {
    expect(layoutMontageSchema.parse(valid)).toEqual(valid);
    expect(roundTrip(layoutMontageSchema, valid)).toEqual(valid);
  });

  it("accepts every documented strategy", () => {
    for (const strategy of ["character_montage", "narrative_composite", "floating_heads"] as const) {
      expect(layoutMontageSchema.parse({ ...valid, strategy }).strategy).toBe(strategy);
    }
  });

  it("relaxOverlap is optional (absent = false behaviour)", () => {
    const { relaxOverlap: _drop, ...rest } = valid;
    expect(layoutMontageSchema.parse(rest)).toEqual(rest);
  });

  it("rejects an unknown strategy", () => {
    expect(() =>
      layoutMontageSchema.parse({ ...valid, strategy: "movie_poster" }),
    ).toThrow();
  });

  it("rejects non-boolean relaxOverlap", () => {
    expect(() => layoutMontageSchema.parse({ ...valid, relaxOverlap: "yes" })).toThrow();
  });

  it("strips unknown extra fields while keeping the base layout contract", () => {
    expect(layoutMontageSchema.parse({ ...valid, montageMode: "aggressive" })).toEqual(valid);
    expect(() =>
      layoutMontageSchema.parse({ ...valid, focalPoint: { x: 1200, y: 400 } }),
    ).toThrow();
    expect(() => layoutMontageSchema.parse({ ...valid, strategy: undefined } as unknown as typeof valid)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WebSocket C→S payloads
// ---------------------------------------------------------------------------

describe("joinSchema", () => {
  it("accepts each role", () => {
    expect(joinSchema.parse({ role: "player", nickname: "Ada" })).toEqual({
      role: "player",
      nickname: "Ada",
    });
    expect(joinSchema.parse({ role: "gm" })).toEqual({ role: "gm" });
    expect(joinSchema.parse({ role: "presenter", joinToken: "t" })).toEqual({
      role: "presenter",
      joinToken: "t",
    });
  });

  it("rejects a bad role", () => {
    expect(() => joinSchema.parse({ role: "admin" })).toThrow();
    expect(() => joinSchema.parse({})).toThrow();
  });
});

describe("promptSubmitSchema", () => {
  it("accepts text", () => {
    expect(promptSubmitSchema.parse({ text: "a grumpy cat" })).toEqual({
      text: "a grumpy cat",
    });
  });
  it("rejects empty text and extra fields", () => {
    expect(() => promptSubmitSchema.parse({ text: "" })).toThrow();
    expect(() => promptSubmitSchema.parse({ text: "hi", teamId: "t1" })).toThrow();
  });
});

describe("scoreSubmitSchema", () => {
  const base = { cardId: "card-b" };
  it("accepts scores 1 and 10", () => {
    expect(scoreSubmitSchema.parse({ ...base, score: 1 })).toEqual({ ...base, score: 1 });
    expect(scoreSubmitSchema.parse({ ...base, score: 10 })).toEqual({ ...base, score: 10 });
  });
  it("rejects 0, 11, non-integers and a missing cardId", () => {
    expect(() => scoreSubmitSchema.parse({ ...base, score: 0 })).toThrow();
    expect(() => scoreSubmitSchema.parse({ ...base, score: 11 })).toThrow();
    expect(() => scoreSubmitSchema.parse({ ...base, score: 2.5 })).toThrow();
    expect(() => scoreSubmitSchema.parse({ score: 5 })).toThrow();
  });
});

describe("gm / judge / reveal payloads", () => {
  it("gmRemoveItemSchema", () => {
    expect(gmRemoveItemSchema.parse({ itemId: "i1" })).toEqual({ itemId: "i1" });
    expect(() => gmRemoveItemSchema.parse({})).toThrow();
  });
  it("gmKickSchema", () => {
    expect(gmKickSchema.parse({ playerId: "p1" })).toEqual({ playerId: "p1" });
    expect(() => gmKickSchema.parse({ itemId: "i1" })).toThrow();
  });
  it("gmRegenGreetingSchema and judgePickSchema", () => {
    expect(gmRegenGreetingSchema.parse({ teamId: "t1" })).toEqual({ teamId: "t1" });
    expect(judgePickSchema.parse({ teamId: "t1" })).toEqual({ teamId: "t1" });
    expect(() => gmRegenGreetingSchema.parse({})).toThrow();
  });
  it("revealAckSchema accepts empty object only", () => {
    expect(revealAckSchema.parse({})).toEqual({});
    expect(() => revealAckSchema.parse({ teamId: "t1" })).toThrow();
  });
  it("gmStopBuildSchema / gmStopScoringSchema accept only empty objects", () => {
    expect(gmStopBuildSchema.parse({})).toEqual({});
    expect(gmStopScoringSchema.parse({})).toEqual({});
    expect(() => gmStopBuildSchema.parse({ teamId: "t1" })).toThrow();
    expect(() => gmStopScoringSchema.parse({ teamId: "t1" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WebSocket S→C events
// ---------------------------------------------------------------------------

describe("phaseChangedSchema", () => {
  const valid = { phase: "BUILD", phaseEndsAt: 1000, serverNow: 500 };

  it("accepts with and without timers", () => {
    expect(phaseChangedSchema.parse(valid)).toEqual(valid);
    expect(phaseChangedSchema.parse({ phase: "LOBBY", serverNow: 0 })).toEqual({
      phase: "LOBBY",
      serverNow: 0,
    });
  });

  it("rejects unknown phase", () => {
    expect(() => phaseChangedSchema.parse({ phase: "PAUSED", serverNow: 0 })).toThrow();
  });

  it("is passthrough (extra fields survive)", () => {
    const parsed = phaseChangedSchema.parse({ ...valid, extraNote: "hi" });
    expect((parsed as Record<string, unknown>).extraNote).toBe("hi");
  });
});

describe("item* event schemas", () => {
  it("itemPendingSchema", () => {
    const v = { itemId: "i1", promptRaw: "a cat", nickname: "Ada", createdAt: 1 };
    expect(itemPendingSchema.parse(v)).toEqual(v);
    expect(() => itemPendingSchema.parse({ itemId: "i1" })).toThrow();
  });
  it("itemReadySchema", () => {
    const v = { itemId: "i1", imageUrl: "https://x/y.png", width: 512, height: 512 };
    expect(itemReadySchema.parse(v)).toEqual(v);
    expect(() => itemReadySchema.parse({ itemId: "i1" })).toThrow();
  });
  it("itemRejectedSchema / itemFailedSchema / itemRemovedSchema", () => {
    expect(itemRejectedSchema.parse({ itemId: "i1", reason: "moderation" })).toEqual({
      itemId: "i1",
      reason: "moderation",
    });
    expect(itemFailedSchema.parse({ itemId: "i1", reason: "timeout" })).toEqual({
      itemId: "i1",
      reason: "timeout",
    });
    expect(itemRemovedSchema.parse({ itemId: "i1" })).toEqual({ itemId: "i1" });
    expect(() => itemFailedSchema.parse({ itemId: 3 })).toThrow();
  });
});

describe("layoutUpdatedSchema", () => {
  const valid = {
    version: 3,
    placements: [{ itemId: "i1", x: 10.5, y: 20.25, scale: 1.2, rotation: 0, zIndex: 1 }],
    greetingStyle: { align: "center" },
    source: "manual",
  };
  it("accepts a valid fixture", () => {
    expect(layoutUpdatedSchema.parse(valid)).toEqual(valid);
  });
  it("rejects missing version or bad placement", () => {
    const { version: _drop, ...rest } = valid;
    expect(() => layoutUpdatedSchema.parse(rest)).toThrow();
    expect(() =>
      layoutUpdatedSchema.parse({ ...valid, placements: [{ itemId: "i1", scale: 0 }] }),
    ).toThrow();
  });
  it("round-trips through JSON", () => {
    expect(roundTrip(layoutUpdatedSchema, valid)).toEqual(valid);
  });
});

describe("winnerAnnouncedSchema", () => {
  const valid = { winnerTeamId: "t1", label: "Team A", peoplesChoiceTeamId: "t2" };
  it("accepts with and without peoplesChoiceTeamId", () => {
    expect(winnerAnnouncedSchema.parse(valid)).toEqual(valid);
    expect(winnerAnnouncedSchema.parse({ winnerTeamId: "t1", label: "Team A" })).toEqual({
      winnerTeamId: "t1",
      label: "Team A",
    });
  });
  it("rejects missing label", () => {
    expect(() => winnerAnnouncedSchema.parse({ winnerTeamId: "t1" })).toThrow();
  });
});

describe("errorSchema", () => {
  const valid = { code: "RATE_LIMITED", message: "slow down" };
  it("accepts and round-trips", () => {
    expect(errorSchema.parse(valid)).toEqual(valid);
    expect(roundTrip(errorSchema, valid)).toEqual(valid);
  });
  it("rejects missing code", () => {
    expect(() => errorSchema.parse({ message: "x" })).toThrow();
  });
});