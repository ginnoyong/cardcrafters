/**
 * Prompt templates (Step 4).
 *
 * Templates live in config/prompts/<task>.md and are EDITABLE DELIVERABLES —
 * they are loaded once at startup so editing a file + restart changes behavior
 * without touching code.
 *
 * File convention:
 *  - The first line may be an HTML comment describing the file (models treat
 *    it as a comment; the renderer leaves it in place).
 *  - A line containing only `---` splits the file into a SYSTEM part (before,
 *    optional) and a USER part (after). Without a `---` line the whole body
 *    is used as the user message.
 *  - `{{var}}` placeholders are replaced with stringified input variables
 *    (primitives via String(), objects/arrays via JSON.stringify). Rendering
 *    throws when a placeholder has no matching variable (typo guard).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { TASK_NAMES, configDir, type AiTaskName } from "./provider";
import { MAX_PROMPT_WORDS } from "@cardcrafters/shared";

export class TemplateError extends Error {}

interface TemplateBody {
  system?: string;
  user: string;
}

export class PromptTemplates {
  private bodies = new Map<AiTaskName, TemplateBody>();
  private readonly dir: string;
  private loaded = false;

  constructor(dir: string = path.join(configDir(), "prompts")) {
    this.dir = dir;
  }

  /** Load every expected template; throws on missing files AND on unknown
   *  extra .md files in the directory (catches renames/typos at startup). */
  async load(): Promise<void> {
    const entries = (await readdir(this.dir)).filter((f) => f.endsWith(".md")).sort();
    // item_image and montage_image are binary image-generation tasks — they
    // have no text template.
    const TEMPLATE_TASKS = TASK_NAMES.filter(
      (t) => t !== "item_image" && t !== "montage_image",
    );
    const expected = TEMPLATE_TASKS.map((t) => `${t}.md`);
    for (const task of TEMPLATE_TASKS) {
      const file = `${task}.md`;
      if (!entries.includes(file)) {
        throw new TemplateError(`missing prompt template: ${path.join(this.dir, file)}`);
      }
    }
    for (const file of entries) {
      if (!expected.includes(file)) {
        throw new TemplateError(`unknown prompt template file "${file}" in ${this.dir}`);
      }
      const task = file.slice(0, -3) as AiTaskName;
      this.bodies.set(task, splitBody(await readFile(path.join(this.dir, file), "utf8")));
    }
    this.loaded = true;
  }

  has(task: AiTaskName): boolean {
    return this.bodies.has(task);
  }

  /**
   * Render the template for `task` with `vars`. Throws when templates were
   * not loaded, the task has no template, or a placeholder is missing a var.
   */
  render(task: AiTaskName, vars: Record<string, unknown> = {}): { system?: string; user: string } {
    if (!this.loaded) throw new TemplateError("templates not loaded — call load() first");
    const body = this.bodies.get(task);
    if (!body) throw new TemplateError(`no prompt template for task "${task}"`);
    const render = (part: string, which: "system" | "user") =>
      renderMustache(part, vars, `${task}.md ${which}`);
    return {
      ...(body.system !== undefined ? { system: render(body.system, "system") } : {}),
      user: render(body.user, "user"),
    };
  }

  /** Build render vars from a task input record (primitives stringified,
   *  objects/arrays JSON-stringified). */
  static varsFromInput(input: Record<string, unknown>): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null) continue;
      vars[k] = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
    }
    // Default vars available to every template (templates may reference them).
    if (vars.maxWords === undefined) vars.maxWords = String(MAX_PROMPT_WORDS);
    return vars;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Split raw template body into optional system part + user part at a lone `---` line. */
function splitBody(raw: string): TemplateBody {
  const normalized = raw.replace(/\r\n/g, "\n");
  const idx = findSplitIndex(normalized);
  if (idx === -1) return { user: normalized.trim() };
  return {
    system: normalized.slice(0, idx).trim(),
    user: normalized.slice(idx + 1).trim(),
  };
}

/** Index of the newline AFTER the first lone `---` line, or -1. */
function findSplitIndex(body: string): number {
  const lines = body.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") return offset + line.length;
    offset += line.length + 1;
  }
  return -1;
}

const MUSTACHE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Replace {{var}} placeholders; throw when a placeholder has no variable. */
export function renderMustache(
  template: string,
  vars: Record<string, unknown>,
  label: string,
): string {
  const missing: string[] = [];
  const out = template.replace(MUSTACHE, (_match, name: string) => {
    if (!(name in vars)) {
      missing.push(name);
      return _match;
    }
    const value = vars[name];
    if (value === undefined || value === null) {
      missing.push(name);
      return _match;
    }
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  });
  if (missing.length > 0) {
    throw new TemplateError(
      `${label}: missing template variable(s): ${[...new Set(missing)].join(", ")}`,
    );
  }
  // Guard against stray unreplaced placeholders that don't match the ident
  // pattern (e.g. "{{ some var }}" with a space is covered above; anything
  // else like "{{1abc}}" would silently pass through — leave as-is).
  return out;
}