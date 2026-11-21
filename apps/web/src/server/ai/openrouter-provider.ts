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

/** POST {baseUrl}/images response (OpenRouter unified image API). */
interface ImagesEndpointResponse {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Message content part — plain text, or an image (data URL / https URL) for
 * VISION tasks. layout_critique sends the rendered card PNG as a base64 data
 * URL alongside the prompt text; OpenRouter forwards the part to the
 * vision-capable model (google/gemini-3.5-flash-lite primary).
 */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}

/** Flatten a message's content to plain text (images → a placeholder note).
 *  Used only by the images-endpoint fallback, which is text-prompt-only. */
function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : "[image attached]"))
    .join("\n");
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
    let messages: ChatMessage[];
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
    if (task === "item_image" || task === "montage_image") body.modalities = ["image", "text"];

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
      // Image models served ONLY via the dedicated images API (e.g.
      // legacy gpt-image-1) reject /chat/completions with an HTTP 404 whose
      // body names the /api/v1/images endpoint. That model is still a valid
      // fallback — retry the SAME model/attempt against the images endpoint
      // instead of failing the whole chain (this is what killed real stickers:
      // the fallback burned every attempt on the wrong endpoint).
      if (
        (task === "item_image" || task === "montage_image") &&
        status === 404 &&
        /api\/v1\/images|images endpoint/i.test(text)
      ) {
        return this.runViaImagesEndpoint(task, input, cfg, messages, started);
      }
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
    if (task === "item_image" || task === "montage_image") {
      const imageUrl = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!imageUrl) {
        throw new AiTaskError({
          task,
          model: cfg.primary,
          retryable: true,
          message: "openrouter image response contained no image",
        });
      }
      const image = await toImageBase64(imageUrl, this.fetchImpl, task);
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

  /**
   * Item-image fallback for models that are served ONLY via the unified
   * images API (POST /api/v1/images — e.g. gpt-image-* models). Same model,
   * same prompt, same attempt budget: this replaces a chat/completions call
   * that OpenRouter rejected with 404 "Use the /api/v1/images endpoint".
   * Images come back as base64 (b64_json) with an optional media_type.
   */
  private async runViaImagesEndpoint(
    task: AiTaskName,
    input: Record<string, unknown>,
    cfg: TaskConfig,
    messages: ChatMessage[],
    started: number,
  ): Promise<AiCallResult> {
    const prompt = messages.map((m) => messageText(m.content)).join("\n\n");
    // MONTAGE 5:7 NATIVE RATIO (bleed-in fix, part b): the game's card is a
    // tall 5:7 portrait — a mismatched-ratio poster gets cropped to the card
    // ratio during normalization (normalizePosterToCardRatio, bottom-anchored),
    // which cuts the greeting text when the crop eats the bottom band. Ask for
    // 5:7 natively via the normalized `aspect_ratio` knob so the crop is a
    // no-op (or nearly one). montage_image ONLY — item_image stickers must
    // stay square (no ratio field may ride along).
    //
    // Why aspect_ratio and not `size`: checked live via
    // /api/v1/images/models/{id}/endpoints — NONE of the endpoints that serve
    // this task (google-vertex/google-ai-studio Gemini image endpoints,
    // OpenAI gpt-image-*) list `size` in supported_parameters, so an explicit
    // pixel size like "1100x1540" is unsupported (silently ignored at best,
    // 400 at worst — the OpenAPI spec says explicit pixel sizes are
    // provider-dependent and some providers reject them). Every endpoint DOES
    // support `aspect_ratio`, whose top-level enum includes "5:7" exactly;
    // providers clamp it to their supported subset (Gemini image endpoints:
    // 3:4/2:3 nearest; gpt-image-1: 2:3) — either clamp lands close enough
    // that the bottom-anchored normalization crop stays minimal.
    const aspectRatio = task === "montage_image" ? "5:7" : undefined;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://cardcrafters.local",
          "X-Title": "Card Crafters",
          "User-Agent": "CardCrafters/0.1 (+https://cardcrafters.local)",
        },
        body: JSON.stringify(
          aspectRatio
            ? { model: cfg.primary, prompt, aspect_ratio: aspectRatio }
            : { model: cfg.primary, prompt },
        ),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (cause) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: `openrouter images request failed: ${(cause as Error).message}`,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiTaskError({
        task,
        model: cfg.primary,
        // Unknown-model/bad-param 404s and 400s are fatal for this model;
        // capacity/limit errors (408/429/5xx) stay retryable.
        retryable: res.status !== 400 && res.status !== 404,
        message: `openrouter images HTTP ${res.status}: ${text.slice(0, 300)}`,
      });
    }
    const json = (await res.json().catch((cause: unknown) => {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: "openrouter images returned non-JSON body",
      });
    })) as ImagesEndpointResponse;
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        retryable: true,
        message: "openrouter images response contained no image",
      });
    }
    const mime = json.data?.[0]?.media_type ?? "image/png";
    const usage = usageOutKeys(json.usage);
    return {
      data: { imageMime: mime },
      raw: undefined,
      model: cfg.primary,
      latencyMs: Date.now() - started,
      ...(usage ? { usage } : {}),
      imageBase64: b64,
      imageMime: mime,
    };
  }

  /** Build [system?, user] messages from the prompt template + raw input JSON. */
  private async buildMessages(
    task: AiTaskName,
    input: Record<string, unknown>,
  ): Promise<ChatMessage[]> {
    await this.ensureTemplates(); // loaded once per provider instance
    const messages: ChatMessage[] = [];
    if (task === "montage_image") {
      // Binary image task — no text template; the prompt is the POSTER prompt
      // produced by montage_prompt, verbatim, plus at most a minimal
      // color/mood style hint. It must NEVER reuse the item_image sticker
      // framing (die-cut / transparent background / centered 75–85%) — that
      // language turns the full-bleed poster back into loose stickers.
      messages.push({ role: "user", content: montageImagePrompt(input) });
      return messages;
    }
    if (task === "item_image") {
      // Binary image task — no text template; prompt is synthesized from input.
      // Die-cut look: subject centered with generous transparent padding, never
      // a full-bleed rectangle (post-process auto-padding in image/pad.ts is
      // only the safety net — the model must already comply).
      messages.push({ role: "user", content: itemImagePrompt(input) });
      return messages;
    }
    if (task === "layout_critique") {
      // VISION task: the rendered card PNG travels as a base64 data-URL image
      // part next to the prompt text. The base64 payload must NOT be inlined
      // into the text/JSON dump (megabytes of noise) — strip it from both the
      // template vars and the INPUT JSON block.
      const { imageBase64: _b64, imageMime: _mime, ...rest } = input;
      const rendered = this.templates.render(task, PromptTemplates.varsFromInput(rest));
      if (rendered.system) messages.push({ role: "system", content: rendered.system });
      const parts: ContentPart[] = [
        { type: "text", text: `${rendered.user}\n\nINPUT (JSON):\n${JSON.stringify(rest, null, 2)}` },
      ];
      if (typeof input.imageBase64 === "string" && input.imageBase64.length > 0) {
        const mime =
          typeof input.imageMime === "string" && input.imageMime ? input.imageMime : "image/png";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${input.imageBase64}` },
        });
      }
      // No image in the input → text-only message (the model judges from the
      // summary; the schema still applies).
      messages.push({ role: "user", content: parts });
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

/**
 * The montage_image user prompt (chat/completions + images endpoint):
 * ONLY the poster prompt (montage_prompt's output, verbatim) + an optional
 * minimal style-pack color/mood hint. NO die-cut/transparent/sticker framing
 * is added here and the sticker item_image suffix never reaches this task.
 * Exported so the montage accumulator can persist the EXACT string sent.
 */
export function montageImagePrompt(input: Record<string, unknown>): string {
  const prompt = String(input.prompt ?? "").trim();
  const style = String(input.styleHint ?? "").trim();
  return style ? `${prompt}\nArt direction: ${style}.` : prompt;
}

/** The shared item-image user prompt (chat/completions + images endpoint). */
function itemImagePrompt(input: Record<string, unknown>): string {
  const subject = String(input.subject ?? input.prompt ?? "");
  const style = String(input.styleSuffix ?? input.imagePromptSuffix ?? "");
  return `One standalone illustration of: ${subject}. The subject must be CENTERED and occupy about 75–85% of the frame, with generous padding on ALL sides (subject must NOT touch the edges). The background must be a PLAIN SOLID WHITE — never transparent, never checkered, never patterned, no backdrop, no ground shadow, no border, no text.${style ? `
Visual style: ${style}.` : ""}`;
}

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
  imageTask: AiTaskName = "item_image",
): Promise<{ base64: string; mime: string }> {
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (dataUrl) return { mime: dataUrl[1]!, base64: dataUrl[2]! };
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "CardCrafters/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new AiTaskError({
      task: imageTask,
      retryable: true,
      message: `failed to download generated image (${res.status})`,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { base64: buf.toString("base64"), mime };
}