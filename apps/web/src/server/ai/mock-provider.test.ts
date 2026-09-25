import { describe, expect, it } from "vitest";

import {
  greetingVariationsSchema,
  layoutCompositionSchema,
  moderationSchema,
  promptValidationSchema,
  styleDerivationSchema,
} from "@cardcrafters/shared";

import { MockProvider, drawMockSticker } from "./mock-provider";
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
    // deterministic per input
    const res2 = await mkProvider().run("layout_composition", { items }, cfg("layout_composition"));
    expect(res2.data).toEqual(res.data);
  });
});

describe("MockProvider — misc", () => {
  it("applies MOCK_AI_DELAY_MS latency", async () => {
    const slow = new MockProvider({ env: { MOCK_AI_DELAY_MS: "40" } as unknown as NodeJS.ProcessEnv });
    const res = await slow.run("moderation", { prompt: "x" }, cfg("moderation"));
    expect(res.latencyMs).toBeGreaterThanOrEqual(35);
    expect(res.model).toBe("mock/moderation");
  });

  it("rejects layout_critique as disabled", async () => {
    await expect(
      mkProvider().run("layout_critique", {}, cfg("layout_critique")),
    ).rejects.toThrow(/disabled/);
  });
});