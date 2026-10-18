import { describe, expect, it } from "vitest";

import {
  greetingVariationsSchema,
  layoutCompositionSchema,
  layoutMontageSchema,
  moderationSchema,
  promptValidationSchema,
  styleDerivationSchema,
} from "@cardcrafters/shared";

import { MockProvider, SHAPES, drawMockSticker } from "./mock-provider";
import type { AiTaskName, TaskConfig } from "./provider";

const envNoDelay = { MOCK_AI_DELAY_MS: "0" } as unknown as NodeJS.ProcessEnv;
const mkProvider = () => new MockProvider({ env: envNoDelay });
const cfg = (task: AiTaskName): TaskConfig => ({
  name: task,
  primary: "google/gemini-2.5-flash",
  fallbacks: [],
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 1000,
  retries: 0,
  structured: null,
  enabled: true,
});

describe("MockProvider — prompt_validation", () => {
  const run = (prompt: string) =>
    mkProvider().run("prompt_validation", { prompt }, cfg("prompt_validation"));

  it("accepts a ≤6-word concrete prompt", async () => {
    const res = await run("golden retriever wearing a party hat");
    const parsed = promptValidationSchema.parse(res.data);
    expect(parsed.valid).toBe(true);
    expect(parsed.reason).toBe("");
    expect(parsed.normalized_subject).toBe("golden retriever wearing a party hat");
  });

  it("accepts a real-person subject (celebrities are allowed)", async () => {
    const res = await run("Elvis Presley silhouette");
    const parsed = promptValidationSchema.parse(res.data);
    expect(parsed.valid).toBe(true);
    expect(parsed.normalized_subject).toContain("elvis presley");
  });

  it("rejects a 7-word prompt", async () => {
    const res = await run("a big golden retriever wearing a hat");
    const parsed = promptValidationSchema.parse(res.data);
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toMatch(/6 words|limit/i);
  });

  it("rejects 'happiness' with reason + example_fix", async () => {
    const res = await run("happiness");
    const parsed = promptValidationSchema.parse(res.data);
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toContain("happiness");
    expect(parsed.example_fix).toBeTruthy();
    expect(parsed.example_fix!.length).toBeGreaterThan(0);
  });

  it("rejects multi-word abstract phrases as substrings", async () => {
    for (const prompt of ["cozy vibes only", "make it elegant please", "a bit of romantic atmosphere"]) {
      const parsed = promptValidationSchema.parse((await run(prompt)).data);
      expect(parsed.valid, `"${prompt}" should be invalid`).toBe(false);
      expect(parsed.example_fix).toBeTruthy();
    }
  });

  it("accepts appearance descriptors and feelings attached to visible subjects", async () => {
    const parsed = promptValidationSchema.parse((await run("a happy dog")).data);
    expect(parsed.valid).toBe(true);
  });
});

describe("MockProvider — moderation", () => {
  const run = (prompt: string) => mkProvider().run("moderation", { prompt }, cfg("moderation"));

  it("passes ordinary prompts", async () => {
    const parsed = moderationSchema.parse((await run("golden retriever party hat")).data);
    expect(parsed.safe).toBe(true);
    expect(parsed.category).toBe("none");
  });

  it("blocks the 'unsafe test' sentinel as category 'other'", async () => {
    const parsed = moderationSchema.parse((await run("unsafe test balloon")).data);
    expect(parsed.safe).toBe(false);
    expect(parsed.category).toBe("other");
    expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it("allows real people (non-contentious)", async () => {
    const parsed = moderationSchema.parse((await run("Elvis Presley silhouette")).data);
    expect(parsed.safe).toBe(true);
    expect(parsed.category).toBe("none");
  });
});

describe("MockProvider — greeting_variations", () => {
  it("returns 10 clearly-distinct variations", async () => {
    const res = await mkProvider().run(
      "greeting_variations",
      { theme: "birthday", count: 10, teamIndex: 0 },
      cfg("greeting_variations"),
    );
    const parsed = greetingVariationsSchema.parse(res.data);
    expect(parsed.variations).toHaveLength(10);
    expect(new Set(parsed.variations).size).toBe(10);
    for (const v of parsed.variations) {
      expect(v).toContain("birthday");
      expect(v.length).toBeLessThanOrEqual(48); // short enough for a card headline
    }
  });

  it("is deterministic per (theme, teamIndex) but varies across teams", async () => {
    const p = mkProvider();
    const a1 = greetingVariationsSchema.parse(
      (await p.run("greeting_variations", { theme: " Diwali ", count: 5, teamIndex: 1 }, cfg("greeting_variations"))).data,
    );
    const a2 = greetingVariationsSchema.parse(
      (await p.run("greeting_variations", { theme: " Diwali ", count: 5, teamIndex: 1 }, cfg("greeting_variations"))).data,
    );
    const b = greetingVariationsSchema.parse(
      (await p.run("greeting_variations", { theme: " Diwali ", count: 5, teamIndex: 2 }, cfg("greeting_variations"))).data,
    );
    expect(a1.variations).toEqual(a2.variations);
    expect(a1.variations).not.toEqual(b.variations);
    // theme is normalized into the greetings
    expect(a1.variations.every((v) => v.toLowerCase().includes("diwali"))).toBe(true);
  });
});

describe("MockProvider — style_derivation", () => {
  it("returns a non-empty hex palette + sane style fields", async () => {
    const res = await mkProvider().run("style_derivation", { theme: "diwali lights" }, cfg("style_derivation"));
    const parsed = styleDerivationSchema.parse(res.data);
    expect(parsed.styleName.length).toBeGreaterThan(3);
    expect(parsed.palette.length).toBeGreaterThanOrEqual(4);
    for (const hex of parsed.palette) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(["thin", "medium", "bold"]).toContain(parsed.lineWeight);
    expect(parsed.mood.length).toBeGreaterThan(0);
    expect(parsed.imagePromptSuffix.toLowerCase()).toContain("sticker");
  });

  it("is deterministic per theme", async () => {
    const p = mkProvider();
    const a = await p.run("style_derivation", { theme: "diwali lights" }, cfg("style_derivation"));
    const b = await p.run("style_derivation", { theme: "diwali lights" }, cfg("style_derivation"));
    expect(a.data).toEqual(b.data);
  });
});

describe("MockProvider — item_image", () => {
  it("draws a valid 256x256 transparent PNG and reports dimensions", async () => {
    const res = await mkProvider().run("item_image", { prompt: "red balloon" }, cfg("item_image"));
    expect(res.imageBase64).toBeTruthy();
    expect(res.imageMime).toBe("image/png");
    expect(res.imageWidth).toBe(256);
    expect(res.imageHeight).toBe(256);

    const buf = Buffer.from(res.imageBase64!, "base64");
    // PNG magic bytes
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // IHDR width/height at offsets 16/20 (big-endian)
    expect(buf.readUInt32BE(16)).toBe(256);
    expect(buf.readUInt32BE(20)).toBe(256);
    // color type 6 (RGBA) at IHDR byte 25 → alpha channel present (transparency capable)
    expect(buf[25]).toBe(6);
  });

  it("derives the shape + hue deterministically from the prompt", () => {
    const a = drawMockSticker("red balloon");
    const b = drawMockSticker("red balloon");
    expect(a.base64).toBe(b.base64);
    expect(a.hue).toBe(b.hue);
    const c = drawMockSticker("blue whale");
    expect(c.base64).not.toBe(a.base64); // different hash → different hue/shape
  });

  // Shape-pool distribution. The pool is 20 shapes (≥16 enforced below), of
  // which 6 are roundish (circle, smiley, balloon, cloud, flower, heart) —
  // 30% of the pool, so a healthy hash should keep roundish selections well
  // under half of any reasonable sample. Thresholds (≥10 distinct of 20 over
  // 40+ prompts, roundish ≤50%) were chosen from a measured tsx probe: 105
  // varied prompts used 19/20 shapes and 50 near-identical in-game prompts
  // used all 20, with roundish at 32–34% in both — the assertions leave wide
  // safety margin while still catching a clustered/biased hash or a
  // roundish-dominant pool regression.
  describe("shape pool distribution", () => {
    // Deterministic, varied in-game-style prompts (short nouns, colour swaps,
    // phrases) — fixed list so the test is fully reproducible.
    const prompts = [
      "a red balloon", "a birthday cake", "a golden retriever", "a snowman",
      "a sunflower", "a paper boat", "a cat", "a rocket", "pizza", "a guitar",
      "coffee", "a rainbow", "a cactus", "a soccer ball", "a butterfly",
      "pancakes", "a treasure chest", "a ghost", "a palm tree", "a fish",
      "a kite", "a strawberry", "a robot", "a wizard hat", "a donut", "a drum",
      "a camera", "a plant", "a lighthouse", "a mushroom", "a snail", "a duck",
      "a campfire", "a violin", "a crab", "a firetruck", "a disco ball",
      "a candle", "a crown", "a telescope", "a unicorn", "a dragon", "a ninja",
      "a pirate ship", "a taco", "a penguin", "an owl", "a fox", "a bee",
      "red heart", "blue star", "green tree", "yellow sun", "purple gem",
      "big house", "small moon", "happy smiley", "fluffy cloud", "loud note",
      "spiky snowflake", "shiny cupcake", "bright lightning", "square gift",
    ];

    it("has a pool of at least 16 distinct shapes", () => {
      expect(SHAPES.length).toBeGreaterThanOrEqual(16);
      expect(new Set(SHAPES.map((s) => s.name)).size).toBe(SHAPES.length);
    });

    it("uses at least 10 distinct shapes over 40+ deterministic prompts", () => {
      expect(prompts.length).toBeGreaterThanOrEqual(40);
      const used = new Set(prompts.map((p) => drawMockSticker(p).shape));
      expect(used.size).toBeGreaterThanOrEqual(10);
    });

    it("maps the same prompt to the same shape every time", () => {
      for (const p of prompts) {
        expect(drawMockSticker(p).shape).toBe(drawMockSticker(p).shape);
      }
    });

    it("keeps roundish shapes to at most half of the selections", () => {
      const roundish = new Set(["circle", "smiley", "balloon", "cloud", "flower", "heart"]);
      const picks = prompts.map((p) => drawMockSticker(p).shape);
      const roundishCount = picks.filter((s) => roundish.has(s)).length;
      expect(roundishCount / picks.length).toBeLessThanOrEqual(0.5);
    });
  });
});

describe("MockProvider — layout_composition", () => {
  it("produces an in-bounds plausible layout", async () => {
    const items = [
      { id: "a", width: 200, height: 200, weight: 0.8, order: 1 },
      { id: "b", width: 150, height: 150, weight: 0.5, order: 2 },
      { id: "c", width: 180, height: 180, weight: 0.6, order: 3 },
      { id: "d", width: 120, height: 120, weight: 0.3, order: 4 },
    ];
    const res = await mkProvider().run("layout_composition", { items }, cfg("layout_composition"));
    const parsed = layoutCompositionSchema.parse(res.data);
    expect(parsed.focalPoint.x).toBeGreaterThan(0);
    expect(parsed.focalPoint.x).toBeLessThan(1000);
    expect(parsed.focalPoint.y).toBeGreaterThan(0);
    expect(parsed.focalPoint.y).toBeLessThan(1000);
    // focal point near the golden-ratio spot
    expect(parsed.focalPoint.x).toBeGreaterThan(500);
    expect(parsed.focalPoint.x).toBeLessThan(700);
    // every item appears in exactly one group
    const ids = parsed.groups.flatMap((g) => g.itemIds).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
    // text zone sits in the top third and is inside the card
    expect(parsed.textZone.y).toBeLessThan(340);
    expect(parsed.textZone.y + parsed.textZone.h).toBeLessThanOrEqual(1000);
    expect(parsed.textZone.x + parsed.textZone.w).toBeLessThanOrEqual(1000);
  });

  it("groups by adjacent index pairs and emits semantic hints", async () => {
    const items = [
      { id: "a", width: 200, height: 200, weight: 0.8, order: 1, subject: "origami crane" },
      { id: "b", width: 150, height: 150, weight: 0.5, order: 2, subject: "cherry blossom" },
      { id: "c", width: 180, height: 180, weight: 0.6, order: 3, subject: "gift box" },
      { id: "d", width: 120, height: 120, weight: 0.3, order: 4, subject: "ribbon" },
    ];
    const res = await mkProvider().run(
      "layout_composition",
      { items, cardWidth: 714, cardHeight: 1000 },
      cfg("layout_composition"),
    );
    const parsed = layoutCompositionSchema.parse(res.data);
    // Adjacent index pairs: (a,b), (c,d).
    expect(parsed.groups.map((g) => g.itemIds)).toEqual([["a", "b"], ["c", "d"]]);
    // Group subjects join the member subjects.
    expect(parsed.groups[0]!.subject).toBe("origami crane + cherry blossom");
    expect(parsed.groups[1]!.subject).toBe("gift box + ribbon");
    // Per-item hints: top-weight item is the focal, everything tilts toward
    // its group center, importance follows the visualWeight ranking.
    expect(parsed.hints).toHaveLength(4);
    const byId = new Map(parsed.hints!.map((h) => [h.itemId, h] as const));
    expect(byId.get("a")!.role).toBe("focal");
    expect(byId.get("b")!.role).toBe("support");
    expect(byId.get("c")!.role).toBe("support");
    for (const id of ["a", "b", "c", "d"]) {
      expect(byId.get(id)!.tiltToward).toBe("group_center");
      expect(byId.get(id)!.importance).toBeGreaterThan(0);
      expect(byId.get(id)!.importance!).toBeLessThanOrEqual(1);
    }
    // Importance follows visualWeight DESC (a=0.8 > c=0.6 > b=0.5 > d=0.3),
    // NOT index order.
    expect(byId.get("a")!.importance!).toBeGreaterThan(byId.get("c")!.importance!);
    expect(byId.get("c")!.importance!).toBeGreaterThan(byId.get("b")!.importance!);
    expect(byId.get("b")!.importance!).toBeGreaterThan(byId.get("d")!.importance!);
    // Same input → same hints (determinism asserted by the test above too).
    const res2 = await mkProvider().run(
      "layout_composition",
      { items, cardWidth: 714, cardHeight: 1000 },
      cfg("layout_composition"),
    );
    expect(res2.data).toEqual(res.data);
  });

  it("folds a trailing odd item into the previous pair (n = 3 → one group)", async () => {
    const items = [
      { id: "a", weight: 0.8, order: 1, subject: "crane" },
      { id: "b", weight: 0.5, order: 2, subject: "blossom" },
      { id: "c", weight: 0.6, order: 3, subject: "sun" },
    ];
    const res = await mkProvider().run(
      "layout_composition",
      { items, cardWidth: 714, cardHeight: 1000 },
      cfg("layout_composition"),
    );
    const parsed = layoutCompositionSchema.parse(res.data);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]!.itemIds).toEqual(["a", "b", "c"]);
    expect(parsed.groups[0]!.subject).toBe("crane + blossom + sun");
  });

  it("n = 1 stays a single tight group with an inert hint (solo hint-win path)", async () => {
    const items = [{ id: "solo", width: 256, height: 256, weight: 0.3, order: 1, subject: "heart" }];
    const res = await mkProvider().run(
      "layout_composition",
      { items, cardWidth: 714, cardHeight: 1000 },
      cfg("layout_composition"),
    );
    const parsed = layoutCompositionSchema.parse(res.data);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]!.itemIds).toEqual(["solo"]);
    // The solo item's group_center tilt is INERT (no other members) — the
    // engine's n = 1 hint-win test relies on the orientation being a no-op.
    expect(parsed.hints).toHaveLength(1);
    expect(parsed.hints![0]!.tiltToward).toBe("group_center");
    expect(parsed.hints![0]!.role).toBe("focal");
    expect(parsed.hints![0]!.importance).toBe(1);
  });
});

describe("MockProvider — layout_montage", () => {
  it("returns a schema-valid montage with fixed strategy + relaxOverlap (safety net for direct calls)", async () => {
    const items = [
      { id: "a", width: 200, height: 200, weight: 0.8, order: 1, subject: "hero crane" },
      { id: "b", width: 150, height: 150, weight: 0.5, order: 2, subject: "blossom" },
      { id: "c", width: 180, height: 180, weight: 0.6, order: 3, subject: "sun" },
    ];
    const res = await mkProvider().run(
      "layout_montage",
      { items, cardWidth: 714, cardHeight: 1000 },
      cfg("layout_montage"),
    );
    expect(res.model).toBe("mock/layout_montage");
    const parsed = layoutMontageSchema.parse(res.data);
    // Fixed canned montage options (never randomized).
    expect(parsed.strategy).toBe("character_montage");
    expect(parsed.relaxOverlap).toBe(false);
    // The composition hints are REUSED from the layout_composition builder —
    // the solver consumes this identically. The builder's documented odd-item
    // behavior folds a trailing item into the previous pair, so n = 3 → ONE
    // group covering all three ids (same as the layout_composition mock).
    expect(parsed.focalPoint.x).toBeGreaterThan(0);
    expect(parsed.focalPoint.x).toBeLessThan(714);
    expect(parsed.textZone).toBeTruthy();
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups.flatMap((g) => g.itemIds).sort()).toEqual(["a", "b", "c"]);
  });

  it("is deterministic per input (same input → same montage)", async () => {
    const input = {
      items: [
        { id: "a", width: 200, height: 200, weight: 0.8, order: 1 },
        { id: "b", width: 150, height: 150, weight: 0.5, order: 2 },
      ],
      cardWidth: 714,
      cardHeight: 1000,
    };
    const res1 = await mkProvider().run("layout_montage", input, cfg("layout_montage"));
    const res2 = await mkProvider().run("layout_montage", input, cfg("layout_montage"));
    expect(res2.data).toEqual(res1.data);
    expect(layoutMontageSchema.parse(res1.data).strategy).toBe("character_montage");
  });
});

describe("MockProvider — misc", () => {
  it("applies MOCK_AI_DELAY_MS latency", async () => {
    const slow = new MockProvider({ env: { MOCK_AI_DELAY_MS: "40" } as unknown as NodeJS.ProcessEnv });
    const res = await slow.run("moderation", { prompt: "x" }, cfg("moderation"));
    expect(res.latencyMs).toBeGreaterThanOrEqual(35);
    expect(res.model).toBe("mock/moderation");
  });

  it("layout_critique (mock): fixed passing verdict — the scheduler normally short-circuits before this", async () => {
    const res = await mkProvider().run("layout_critique", {}, cfg("layout_critique"));
    expect(res.model).toBe("mock/layout_critique");
    expect(res.data).toEqual({ score: 80, issues: [], focalOk: true });
  });
});