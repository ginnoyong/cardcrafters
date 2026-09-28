/**
 * OpenRouter provider (Step 4) — thin fetch wrapper, no SDK.
 *
 * One `run()` = ONE attempt with ONE model. Retry/fallback orchestration
 * (cfg.retries, cfg.fallbacks) lives in the router; this provider classifies
 * failures as retryable (401/408/429/5xx/network/timeout/JSON/schema errors)
 * or fatal (400) by throwing AiTaskError, which the router acts on.
 *
 * Endpoint: POST {baseUrl}/chat/completions
 *  - structured tasks send response_format: { type: "json_object" } and ask
 *    for `usage` (include) so costs can be tracked against the game budget.
 *  - item_image uses OpenRouter's image-generation pattern: modalities
 *    ["image","text"]; the reply carries data-URL images in
 *    choices[0].message.images[] — http(s) URLs are downloaded to base64.
 *
 * Tests never hit the network: fetch is injectable (default globalThis.fetch).
 */

import { AiTaskError } from "./errors";
import { PromptTemplates, TemplateError } from "./templates";
import type { AiCallResult, AiProvider, AiTaskName, TaskConfig } from "./provider";
import { validateTaskOutput } from "./provider";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable fetch for tests (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Prompt template loader; loads config/prompts at first use. */
  templates?: PromptTemplates;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; images?: { image_url?: { url?: string } }[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

export class OpenRouterProvider implements AiProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly templates: PromptTemplates;
  /** Set after the first successful template load; .md files are NOT re-read
   *  on every call (they are startup deliverables — restart to apply edits).
   *  Use reload() to re-read them explicitly. */
  private templatesLoaded = false;

  constructor(opts: OpenRouterProviderOptions) {
    if (!opts.apiKey) throw new Error("OpenRouterProvider requires an API key");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.templates = opts.templates ?? new PromptTemplates();
  }

  /** Re-read prompt templates from disk (e.g. after editing config/prompts). */
  async reload(): Promise<void> {
    await this.templates.load();
    this.templatesLoaded = true;
  }

  /** Load templates once per provider instance (cached after first success). */
  private async ensureTemplates(): Promise<void> {
    if (!this.templatesLoaded) {
      await this.templates.load();
      this.templatesLoaded = true;
    }
  }

  async run(task: AiTaskName, input: Record<string, unknown>, cfg: TaskConfig): Promise<AiCallResult> {
    const started = Date.now();
    // Template/config-shape errors are FATAL for this model: retrying the same
    // model with the same (broken) template cannot help — mark non-retryable
    // so the router moves on to the next fallback model instead of burning
    // this model's retry chain.
    let messages: { role: "system" | "user"; content: string }[];
    try {
      messages = await this.buildMessages(task, input);
    } catch (cause) {
      if (cause instanceof TemplateError) {
        throw new AiTaskError({
          task,
          model: cfg.primary,
          cause,
          retryable: false,
          message: `template error: ${cause.message}`,
        });
      }
      throw cause;
    }
    const body: Record<string, unknown> = {
      model: cfg.primary,
      messages,
      temperature: cfg.temperature,
      usage: { include: true },
    };
    if (cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
    if (cfg.structured) body.response_format = { type: "json_object" };
    if (task === "item_image") body.modalities = ["image", "text"];

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // Per OpenRouter recommendation: identify the app + UA.
          "HTTP-Referer": "https://cardcrafters.local",
          "X-Title": "Card Crafters",
          "User-Agent": "CardCrafters/0.1 (+https://cardcrafters.local)",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (cause) {
      // Network error or abort (timeout) — both retryable.
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: `openrouter request failed: ${(cause as Error).message}`,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const status = res.status;
      // 400/404: malformed request (unknown model id, bad params) — retrying
      // with the SAME model cannot help, so this is fatal for the model; the
      // router still moves on to the next FALLBACK model. Everything else
      // (401/408/429/5xx) is treated as retryable per the failure policy.
      const retryable = status !== 400 && status !== 404;
      throw new AiTaskError({
        task,
        model: cfg.primary,
        retryable,
        message: `openrouter HTTP ${status}: ${text.slice(0, 300)}`,
      });
    }

    const json = (await res.json().catch((cause: unknown) => {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: "openrouter returned non-JSON body",
      });
    })) as ChatCompletionResponse;

    const usage = usageOutKeys(json.usage);

    // -- image task -----------------------------------------------------------
    if (task === "item_image") {
      const imageUrl = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!imageUrl) {
        throw new AiTaskError({
          task,
          model: cfg.primary,
          retryable: true,
          message: "openrouter image response contained no image",
        });
      }
      const image = await toImageBase64(imageUrl, this.fetchImpl);
      const latencyMs = Date.now() - started;
      return {
        data: { imageMime: image.mime },
        raw: json.choices?.[0]?.message?.content ?? undefined,
        model: cfg.primary,
        latencyMs,
        ...(usage ? { usage } : {}),
        imageBase64: image.base64,
        imageMime: image.mime,
      };
    }

    // -- JSON (structured or free-form) ---------------------------------------
    const content = json.choices?.[0]?.message?.content ?? "";
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (cause) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: `openrouter content is not valid JSON: ${content.slice(0, 120)}`,
      });
    }
    const checked = validateTaskOutput(cfg, data);
    if (!checked.ok) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        retryable: true,
        message: `openrouter output rejected: ${checked.error}`,
      });
    }
    const latencyMs = Date.now() - started;
    return {
      data: checked.value,
      raw: content,
      model: cfg.primary,
      latencyMs,
      ...(usage ? { usage } : {}),
    };
  }

  /** Build [system?, user] messages from the prompt template + raw input JSON. */
  private async buildMessages(
    task: AiTaskName,
    input: Record<string, unknown>,
  ): Promise<{ role: "system" | "user"; content: string }[]> {
    await this.ensureTemplates(); // loaded once per provider instance
    const messages: { role: "system" | "user"; content: string }[] = [];
    if (task === "item_image") {
      // Binary image task — no text template; prompt is synthesized from input.
      // Die-cut look: subject centered with generous transparent padding, never
      // a full-bleed rectangle (post-process auto-padding in image/pad.ts is
      // only the safety net — the model must already comply).
      const subject = String(input.subject ?? input.prompt ?? "");
      const style = String(input.styleSuffix ?? input.imagePromptSuffix ?? "");
      const text = `One standalone sticker-style illustration of: ${subject}. The subject must be CENTERED and occupy about 75–85% of the frame, with generous transparent padding on ALL sides (subject must NOT touch the edges). Fully transparent background — no backdrop, no ground shadow, no border, no text.${style ? `\nVisual style: ${style}.` : ""}`;
      messages.push({ role: "user", content: text });
      return messages;
    }
    const rendered = this.templates.render(task, PromptTemplates.varsFromInput(input));
    if (rendered.system) messages.push({ role: "system", content: rendered.system });
    const user = `${rendered.user}\n\nINPUT (JSON):\n${JSON.stringify(input, null, 2)}`;
    messages.push({ role: "user", content: user });
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usageOutKeys(usage: ChatCompletionResponse["usage"]): {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
} | undefined {
  if (!usage) return undefined;
  const out: { promptTokens?: number; completionTokens?: number; costUsd?: number } = {};
  if (usage.prompt_tokens !== undefined) out.promptTokens = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) out.completionTokens = usage.completion_tokens;
  if (usage.cost !== undefined) out.costUsd = usage.cost;
  return out;
}

/** data:image/png;base64,... | https://... → { base64, mime }. */
async function toImageBase64(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ base64: string; mime: string }> {
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (dataUrl) return { mime: dataUrl[1]!, base64: dataUrl[2]! };
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "CardCrafters/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new AiTaskError({
      task: "item_image",
      retryable: true,
      message: `failed to download generated image (${res.status})`,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { base64: buf.toString("base64"), mime };
}