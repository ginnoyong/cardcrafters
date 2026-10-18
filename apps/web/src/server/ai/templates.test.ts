import { describe, expect, it } from "vitest";

import { TASK_NAMES } from "./provider";
import { PromptTemplates, TemplateError, renderMustache } from "./templates";

describe("PromptTemplates (config/prompts/*.md)", () => {
  it("loads all 6 prompt template files (item_image is a binary task, no template)", async () => {
    const templates = new PromptTemplates();
    await templates.load();
    for (const task of TASK_NAMES) {
      expect(templates.has(task), `unexpected template presence for ${task}`).toBe(
        task !== "item_image",
      );
    }
  });

  it("renders {{vars}} into the user part and keeps the system part", async () => {
    const templates = new PromptTemplates();
    await templates.load();
    const rendered = templates.render("prompt_validation", {
      prompt: "golden retriever party hat",
      maxWords: 6,
    });
    expect(rendered.system).toBeTruthy();
    expect(rendered.system).not.toContain("{{prompt}}");
    expect(rendered.system).toContain("6"); // {{maxWords}} replaced in system part
    expect(rendered.user).toContain("golden retriever party hat");
    expect(rendered.user).not.toContain("{{prompt}}");
  });

  it("throws TemplateError on a missing variable", async () => {
    const templates = new PromptTemplates();
    await templates.load();
    expect(() => templates.render("prompt_validation", { prompt: "x" })).toThrow(TemplateError);
    expect(() => templates.render("prompt_validation", { prompt: "x" })).toThrow(/maxWords/);
  });

  it("throws when rendering before load()", () => {
    const templates = new PromptTemplates();
    expect(() => templates.render("moderation", { prompt: "x" })).toThrow(TemplateError);
  });

  it("varsFromInput stringifies primitives and JSON-encodes objects", () => {
    const vars = PromptTemplates.varsFromInput({
      theme: "birthday",
      count: 5,
      items: [{ id: "a", width: 100 }],
    });
    expect(vars.theme).toBe("birthday");
    expect(vars.count).toBe("5");
    expect(JSON.parse(vars.items!)).toEqual([{ id: "a", width: 100 }]);
  });

  it("splits system/user on a lone --- line", async () => {
    const templates = new PromptTemplates();
    await templates.load();
    for (const task of TASK_NAMES.filter((t) => t !== "item_image")) {
      const rendered = templates.render(task, minimalVars(task));
      expect(rendered.system, `${task} should have a system part`).toBeTruthy();
      expect(rendered.user.length).toBeGreaterThan(0);
    }
  });
});

describe("renderMustache", () => {
  it("replaces all occurrences", () => {
    expect(renderMustache("Hi {{name}}, bye {{name}}", { name: "Ann" }, "t")).toBe(
      "Hi Ann, bye Ann",
    );
  });

  it("JSON-encodes object values", () => {
    expect(renderMustache("{{items}}", { items: { a: 1 } }, "t")).toBe('{\n  "a": 1\n}');
  });

  it("throws listing every missing variable", () => {
    expect(() => renderMustache("{{a}} {{b}} {{c}}", { b: 1 }, "t")).toThrow(/a, c/);
  });
});

/** Every template's variables, so system/user split tests can render each file. */
function minimalVars(task: string): Record<string, unknown> {
  switch (task) {
    case "prompt_validation":
      return { prompt: "test", maxWords: 6 };
    case "moderation":
      return { prompt: "test" };
    case "greeting_variations":
      return { theme: "birthday", count: 5 };
    case "style_derivation":
      return { theme: "birthday", subjects: "a cake" };
    case "layout_composition":
      return { cardWidth: 1000, cardHeight: 1000, textHint: "top third", items: "[]" };
    case "layout_critique":
      return { layoutSummary: "{}" };
    case "layout_montage":
      return { cardWidth: 1000, cardHeight: 1000, textHint: "top third", items: "[]" };
    default:
      return {};
  }
}