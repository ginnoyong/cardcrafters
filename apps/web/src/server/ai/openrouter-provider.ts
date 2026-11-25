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

// ---------------------------------------------------------------------------
// Outbound-concurrency caps (semaphores: 1 global + 1 images-dedicated)
// ---------------------------------------------------------------------------

/**
 * Default cap on CONCURRENT in-flight OpenRouter HTTP requests. Under the
 * 10×10 demo-bot load (~200 near-simultaneous image generations), OpenRouter
 * starts rejecting calls with HTTP 402 "in_flight_budget_exhausted" — the
 * account still HAS credits, but the in-flight requests alone would exceed
 * the available budget. Capping our own concurrency keeps us under that
 * in-flight ceiling in the first place.
 *
 * Configurable via AI_MAX_CONCURRENT_REQUESTS (parsed as an integer; absent,
 * invalid, or < 1 → the default). The cap is GLOBAL: one module-level
 * semaphore shared by every OpenRouterProvider instance, because the credit
 * budget is per-account, not per-provider-instance.
 *
 * TWO SEMAPHORES (total ≤ overall AND images ≤ image cap): image requests
 * are long (tens of seconds to minutes, plus 402 Retry-After backoffs), text
 * requests are fast. A single shared cap let 6 slow image calls starve every
 * text call (moderation/validation/layout) — and under saturation those text
 * calls then 402'd too, which fails moderation CLOSED and loses stickers.
 * Structure chosen: the images endpoint additionally acquires a DEDICATED
 * images semaphore (see openrouterImageSemaphore); text calls take only the
 * global one. Lock ordering is always images → global (never the reverse),
 * so no circular wait can form → deadlock-free (documented at the call site).
 */
export const DEFAULT_AI_MAX_CONCURRENT_REQUESTS = 6;

/** Default cap on CONCURRENT in-flight calls to the OpenRouter IMAGES
 *  endpoint (POST /api/v1/images) — configurable via AI_MAX_CONCURRENT_IMAGES
 *  (absent/invalid → 3; clamped to ≤ the overall AI_MAX_CONCURRENT_REQUESTS
 *  cap so the image cap can never widen the total in-flight budget). */
export const DEFAULT_AI_MAX_CONCURRENT_IMAGES = 3;

/** A tiny promise-queue semaphore (no dependency). acquire() resolves once a
 *  slot is free and returns the release callback; ALWAYS call release in a
 *  finally block so errors can never deadlock the queue. */
export class Semaphore {
  private limit: number;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = toPositiveInt(limit, 1);
  }

  /** Adjust the cap (used by the provider constructor to apply the env). */
  setLimit(limit: number): void {
    this.limit = toPositiveInt(limit, 1);
    // If the new limit admits queued waiters, hand them slots immediately.
    while (this.inFlight < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.inFlight += 1;
      next();
    }
  }

  /** Current limit (exposed for tests/diagnostics). */
  get capacity(): number {
    return this.limit;
  }

  /** Wait for a slot, then return the release function. */
  async acquire(): Promise<() => void> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return this.releaseBound;
    }
    // Slot is transferred by release() (it increments on our behalf) —
    // incrementing here too would double-count and over-admit callers.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.releaseBound;
  }

  private releaseBound = (): void => {
    this.inFlight -= 1;
    if (this.inFlight < this.limit) {
      const next = this.waiters.shift();
      if (next) {
        this.inFlight += 1; // hand the freed slot straight to the next waiter
        next();
      }
    }
  };
}

/** AI_MAX_CONCURRENT_REQUESTS parsing: an integer ≥ 1 wins; anything else
 *  (absent, empty, float, 0, negative, garbage) falls back to the default. */
export function resolveMaxConcurrentRequests(env?: NodeJS.ProcessEnv): number {
  const raw = env?.AI_MAX_CONCURRENT_REQUESTS;
  if (raw === undefined || raw === "") return DEFAULT_AI_MAX_CONCURRENT_REQUESTS;
  const parsed = Number(raw);
  return toPositiveInt(parsed, DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
}

/** AI_MAX_CONCURRENT_IMAGES parsing, generalized from
 *  resolveMaxConcurrentRequests: an integer ≥ 1 wins; anything else
 *  (absent, empty, float, 0, negative, garbage) → the default (3). The result
 *  is ALWAYS clamped to ≤ the overall cap (resolveMaxConcurrentRequests) so
 *  the total in-flight invariant (image in-flight ≤ total in-flight) holds
 *  even when only one of the two env vars is set explicitly. */
export function resolveMaxConcurrentImages(env?: NodeJS.ProcessEnv): number {
  const raw = env?.AI_MAX_CONCURRENT_IMAGES;
  const requested =
    raw === undefined || raw === ""
      ? DEFAULT_AI_MAX_CONCURRENT_IMAGES
      : toPositiveInt(Number(raw), DEFAULT_AI_MAX_CONCURRENT_IMAGES);
  return Math.min(requested, resolveMaxConcurrentRequests(env));
}

function toPositiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** The one module-level semaphore ALL outbound OpenRouter HTTP requests go
 *  through (chat/completions + images endpoint). Constructed at the default
 *  cap; the provider constructor re-derives the limit from the env it was
 *  built with, so the process-wide cap always mirrors the boot-time env.
 *  Exported for tests (the provider constructor is what mutates it). */
export const openrouterSemaphore = new Semaphore(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);

/** DEDICATED semaphore for the images endpoint (POST /api/v1/images) only.
 *  Image calls acquire THIS FIRST, then openrouterSemaphore (global); text
 *  calls acquire ONLY the global one. Same construction/reset contract as
 *  the global semaphore (the provider constructor mutates it from the env).
 *  LOCK ORDERING: images → global, always, never the reverse → no circular
 *  wait → deadlock-free. */
export const openrouterImageSemaphore = new Semaphore(DEFAULT_AI_MAX_CONCURRENT_IMAGES);

export interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable fetch for tests (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Prompt template loader; loads config/prompts at first use. */
  templates?: PromptTemplates;
  /** Environment the provider was built from — read once at construction to
   *  (re)set the global AI_MAX_CONCURRENT_REQUESTS cap (mirrors how other env
   *  config is read at construction; omitted → the current/default cap). */
  env?: NodeJS.ProcessEnv;
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
    // Env-configured concurrency caps are read HERE (where the provider is
    // constructed), mirroring how other env config is read at construction.
    // Applied unconditionally so the global caps always mirror the most
    // recent construction env (the server constructs exactly once at boot).
    openrouterSemaphore.setLimit(resolveMaxConcurrentRequests(opts.env));
    openrouterImageSemaphore.setLimit(resolveMaxConcurrentImages(opts.env));
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
    // GLOBAL CONCURRENCY CAP: every outbound OpenRouter HTTP request passes
    // through the module-level semaphore (chat/completions + images endpoint).
    // Release happens in a finally block so network errors/aborts can never
    // deadlock the queue. The per-attempt timeout clock starts only once a
    // slot is acquired (waiting in the queue must not eat the timeout).
    const release = await openrouterSemaphore.acquire();
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
    } finally {
      release();
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
      // 402 with the in-flight budget marker: the account still HAS credits —
      // the in-flight requests alone would exceed the available budget. The
      // remedy (per OpenRouter's own hint) is to wait for in-flight requests
      // to settle; the router backs off and retries the SAME model instead of
      // burning retries/fallbacks (which would add MORE in-flight requests).
      // A regular 402 (genuinely out of credits, no in-flight marker) keeps
      // the existing behavior: retryable generic failure.
      if (status === 402 && isInFlightBudgetBody(text)) {
        throw new AiTaskError({
          task,
          model: cfg.primary,
          retryable: true,
          inFlightBudget: true,
          retryAfterSeconds: parseRetryAfterSeconds(res),
          message: `openrouter HTTP 402 (in-flight budget exhausted): ${text.slice(0, 300)}`,
        });
      }
      // 400/404: malformed request (unknown model id, bad params) — retrying
      // with the SAME model cannot help, so this is fatal for the model; the
      // router still moves on to the next FALLBACK model. Everything else
      // (401/402/408/429/5xx) is treated as retryable per the failure policy.
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
    // MONTAGE 3:4 NATIVE RATIO: the game's card defaults to 3:4 and the
    // pipeline asks for EXACTLY that ratio via the normalized `aspect_ratio`
    // knob — 3:4 is natively supported by the Gemini image endpoints (unlike
    // the old 5:7 default, which they clamp unpredictably), so a default-ratio
    // game needs ZERO cropping: the normalization step
    // (normalizePosterToCardRatio, bottom-anchored) is a pure backstop that
    // only kicks in for non-3:4 sources (fallback models, custom card ratios).
    // montage_image ONLY — item_image stickers must stay square (no ratio
    // field may ride along).
    //
    // Why aspect_ratio and not `size`: checked live via
    // /api/v1/images/models/{id}/endpoints — NONE of the endpoints that serve
    // this task list `size` in supported_parameters, so an explicit pixel
    // size like "1100x1540" is unsupported (silently ignored at best, 400 at
    // worst — the OpenAPI spec says explicit pixel sizes are
    // provider-dependent and some providers reject them). Every endpoint
    // supports `aspect_ratio`.
    const aspectRatio = task === "montage_image" ? "3:4" : undefined;
    let res: Response;
    // CONCURRENCY CAP (two semaphores, images calls take BOTH). LOCK ORDERING
    // (deadlock-free by construction): image calls acquire the IMAGES
    // semaphore FIRST, then the GLOBAL one, and release in REVERSE order
    // (global, then images), each in its own finally. Text calls acquire only
    // the global semaphore. Every multi-acquire path uses the same order
    // (images → global, never the reverse) and every holder releases in a
    // finally, so no circular wait can ever form. Invariants: image in-flight
    // ≤ AI_MAX_CONCURRENT_IMAGES (3) AND total in-flight ≤
    // AI_MAX_CONCURRENT_REQUESTS (6) — while 3 images grind slowly, text
    // calls (validation/moderation/montage_prompt/layout) always have ≥ 3
    // global slots left. The per-attempt timeout clock starts only once BOTH
    // slots are acquired (queue waiting must not eat the timeout).
    const releaseImages = await openrouterImageSemaphore.acquire();
    try {
      const releaseGlobal = await openrouterSemaphore.acquire();
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
      } finally {
        releaseGlobal(); // reverse order: global released before images
      }
    } catch (cause) {
      throw new AiTaskError({
        task,
        model: cfg.primary,
        cause,
        retryable: true,
        message: `openrouter images request failed: ${(cause as Error).message}`,
      });
    } finally {
      releaseImages();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Same in-flight budget handling as chat/completions (image models hit
      // POST /api/v1/images, so 402 in-flight bodies arrive here too).
      if (res.status === 402 && isInFlightBudgetBody(text)) {
        throw new AiTaskError({
          task,
          model: cfg.primary,
          retryable: true,
          inFlightBudget: true,
          retryAfterSeconds: parseRetryAfterSeconds(res),
          message: `openrouter images HTTP 402 (in-flight budget exhausted): ${text.slice(0, 300)}`,
        });
      }
      throw new AiTaskError({
        task,
        model: cfg.primary,
        // Unknown-model/bad-param 404s and 400s are fatal for this model;
        // capacity/limit errors (402/408/429/5xx) stay retryable.
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
 * Detect OpenRouter's HTTP 402 "in-flight budget" body — the account still
 * HAS credits, but the current in-flight requests would exceed the available
 * budget. Observed shape (metadata carries both markers):
 *   {"error":{"message":"This request would exceed your available credits
 *    given your current in-flight requests...","code":402,
 *    "metadata":{"reason":"in_flight_budget_exhausted",
 *                "limit_source":"openrouter_in_flight_budget"}}}
 * A regular 402 (genuinely out of credits — no in-flight marker anywhere) does
 * NOT match, so it keeps its normal retryable-failure behavior.
 */
export function isInFlightBudgetBody(text: string): boolean {
  try {
    const json = JSON.parse(text) as {
      error?: {
        message?: string;
        metadata?: { reason?: string; limit_source?: string };
      };
    };
    const reason = json.error?.metadata?.reason ?? "";
    const limitSource = json.error?.metadata?.limit_source ?? "";
    if (reason.includes("in_flight")) return true;
    if (limitSource.includes("in_flight")) return true;
    if (typeof json.error?.message === "string" && /in-flight/i.test(json.error.message)) {
      return true;
    }
  } catch {
    // Not JSON — fall through to the raw-text heuristic below.
  }
  return /in[-_ ]flight/i.test(text);
}

/**
 * Parse the standard `Retry-After` response header (OpenRouter MAY send it on
 * a 402 in-flight response) as integer seconds. `Headers.get` is already
 * case-insensitive per the Fetch spec, so "Retry-After"/"retry-after"/
 * "RETRY-AFTER" all match. Absent, empty, non-integer ("soon", "1.5"),
 * negative, or otherwise garbage values are IGNORED (→ undefined) so the
 * router falls back to its own planned backoff ladder. HTTP-date forms are
 * deliberately not supported: we only honor the plain integer-seconds form.
 */
export function parseRetryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

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
  // The style hint names palette HEX CODES for color CHOOSING. Without a
  // no-swatches guard, image models render them literally as a design-spec
  // palette strip (color boxes with hex labels) inside the artwork.
  const guard =
    "Do NOT depict color swatches, palette strips, or hex code labels in the artwork — the palette guides color choice only.";
  return style
    ? `${prompt}\nArt direction: ${style}. ${guard}`
    : `${prompt} ${guard}`;
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