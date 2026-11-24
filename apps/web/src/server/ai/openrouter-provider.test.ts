/**
 * Bug (c) regression — "winnie the pooh riding a horse" FAILED with:
 *   openrouter HTTP 404: openai/gpt-image-1 is an image generation model and
 *   cannot be used with the chat/completions endpoint. Use the /api/v1/images
 *   endpoint instead.
 *
 * The item_image chain was: primary google/gemini-2.5-flash-image returned a
 * text-only reply twice ("no image" — e.g. an IP/content refusal for a
 * copyrighted subject), so the router fell back to openai/gpt-image-1… which
 * the provider could NEVER call: it only speaks /chat/completions, while
 * OpenRouter serves gpt-image-1 exclusively via POST /api/v1/images. Every
 * fallback attempt burned retries on the wrong endpoint → no image at all →
 * item FAILED.
 *
 * Fix: when chat/completions 404s naming the images endpoint, the provider
 * retries the same model against POST {baseUrl}/images within the same
 * attempt. These tests drive the provider with the EXACT 404 body observed
 * in production (AiCall.error, Item.failReason).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AiTaskError } from "./errors";
import { PromptTemplates } from "./templates";
import {
  DEFAULT_AI_MAX_CONCURRENT_IMAGES,
  DEFAULT_AI_MAX_CONCURRENT_REQUESTS,
  isInFlightBudgetBody,
  montageImagePrompt,
  OpenRouterProvider,
  openrouterImageSemaphore,
  openrouterSemaphore,
  parseRetryAfterSeconds,
  resolveMaxConcurrentImages,
  resolveMaxConcurrentRequests,
  Semaphore,
} from "./openrouter-provider";

/** Exact production 404 body (truncated the way the provider stores it). */
const PROD_404_BODY =
  '{"error":{"message":"openai/gpt-image-1 is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404},"user_id":"user_x"}';

const IMAGE_CFG = {
  name: "item_image" as const,
  primary: "openai/gpt-image-1",
  fallbacks: [],
  temperature: 1,
  maxTokens: 0,
  timeoutMs: 60_000,
  retries: 1,
  structured: null,
  enabled: true,
};

const ITEM_INPUT = { subject: "winnie the pooh riding a horse" };

/** montage_image TaskConfig (same shape as the item_image one, poster task). */
const MONTAGE_CFG = {
  name: "montage_image" as const,
  primary: "google/gemini-2.5-flash-image",
  fallbacks: [],
  temperature: 1,
  maxTokens: 0,
  timeoutMs: 60_000,
  retries: 1,
  structured: null,
  enabled: true,
};

/** Greeting-card prompt (montage_prompt output) + the accumulator's style hint. */
const MONTAGE_INPUT = {
  prompt:
    "Cheerful full-bleed greeting-card illustration for a balloon party card: " +
    "a single warm storybook scene featuring a red balloon, a paper crown and a " +
    "bunting banner, framed by decorative florals with one clear focal point.",
  styleHint: "palette #ff5a5f, #ffd166, joyful mood",
};

/** Regression guard: sticker framing language must NEVER reach the poster. */
const STICKER_LEAK = /sticker|die-cut|transparent/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fetch double: records every (url, body), replays scripted responses. */
function scriptedFetch(
  script: Array<(url: string, body: Record<string, unknown>) => Response>,
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const handler = script[calls.length - 1];
    if (!handler) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return handler(String(url), body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("OpenRouterProvider item_image → /images endpoint fallback (bug c)", () => {
  it("chat/completions 404 (use /api/v1/images) → retries the same model on POST /images and succeeds", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      // Attempt 1: chat/completions rejects gpt-image-1 (the EXACT prod body).
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      // The provider must then hit the unified images API…
      () =>
        jsonResponse({
          created: 1_748_372_400,
          data: [{ b64_json: "QUJD", media_type: "image/png" }],
          usage: { prompt_tokens: 0, completion_tokens: 4175, cost: 0.04 },
        }),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });

    const result = await provider.run("item_image", ITEM_INPUT, IMAGE_CFG);

    expect(result.imageBase64).toBe("QUJD");
    expect(result.imageMime).toBe("image/png");
    expect(result.model).toBe("openai/gpt-image-1");
    expect(result.usage?.costUsd).toBeCloseTo(0.04, 6);

    // Call 1 = chat/completions, call 2 = POST {baseUrl}/images with the same
    // die-cut prompt text (subject carried through).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[1]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(calls[1]!.body.model).toBe("openai/gpt-image-1");
    expect(String(calls[1]!.body.prompt)).toContain("winnie the pooh riding a horse");
    expect(String(calls[1]!.body.prompt)).toContain("transparent");
  });

  it("images-endpoint HTTP 429 is retryable; 400 stays fatal for the model", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      () => jsonResponse({ error: { message: "rate limited" } }, 429),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("openrouter images HTTP 429"),
    });

    const { fetchImpl: fetch400 } = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      () => jsonResponse({ error: { message: "bad request" } }, 400),
    ]);
    const p2 = new OpenRouterProvider({ apiKey: "k", fetchImpl: fetch400 });
    await expect(p2.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("openrouter images HTTP 400"),
    });
  });

  it("a plain 404 (unknown model, no images-endpoint hint) still fails the chain fatally", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse({ error: { message: "no endpoints found for this model" } }, 404),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("openrouter HTTP 404"),
    });
    expect(calls).toHaveLength(1); // never retried on /images
  });

  it("chat/completions 404 on a TEXT task is never rerouted to /images", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () =>
        jsonResponse(
          { error: { message: "use the /api/v1/images endpoint instead" } },
          404,
        ),
    ]);
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      templates: textTemplates(),
    });
    await expect(
      provider.run(
        "prompt_validation",
        { text: "cat" },
        {
          name: "prompt_validation",
          primary: "google/gemini-2.5-flash",
          fallbacks: [],
          temperature: 0,
          maxTokens: 200,
          timeoutMs: 8_000,
          retries: 1,
          structured: "promptValidationSchema",
          enabled: true,
        },
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// montage_image (poster task) — regression tests for the montage-cohesion fix
// ---------------------------------------------------------------------------

describe("OpenRouterProvider montage_image (poster task)", () => {
  it("chat/completions payload carries the poster prompt + style hint and NEVER sticker framing", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                images: [{ image_url: { url: "data:image/png;base64,QUJD" } }],
              },
            },
          ],
        }),
    ]);
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      templates: textTemplates(),
    });

    const result = await provider.run("montage_image", MONTAGE_INPUT, MONTAGE_CFG);

    expect(result.imageBase64).toBe("QUJD");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    // Binary image task: modalities flag must ride along.
    expect(calls[0]!.body.modalities).toEqual(["image", "text"]);
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    const content = String(messages[0]!.content);
    // Poster prompt verbatim + the minimal Art-direction style hint.
    expect(content).toContain(MONTAGE_INPUT.prompt);
    expect(content).toContain(`Art direction: ${MONTAGE_INPUT.styleHint}.`);
    // The sent prompt is byte-identical to what the accumulator persists.
    expect(content).toBe(montageImagePrompt(MONTAGE_INPUT));
    // The item_image die-cut framing (sticker/die-cut/transparent) must never
    // leak into the poster prompt — that language re-fragments the scene.
    expect(STICKER_LEAK.test(content)).toBe(false);
  });

  it("chat/completions 404 (use /api/v1/images) → retries the same model on POST /images", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      // Attempt 1: chat/completions rejects the image-only model (prod body).
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      // …then the unified images API answers with base64 image data.
      () =>
        jsonResponse({
          data: [{ b64_json: "QUJD", media_type: "image/png" }],
        }),
    ]);
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      templates: textTemplates(),
    });

    const result = await provider.run("montage_image", MONTAGE_INPUT, MONTAGE_CFG);

    expect(result.imageBase64).toBe("QUJD");
    expect(result.imageMime).toBe("image/png");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[1]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(calls[1]!.body.model).toBe(MONTAGE_CFG.primary);
    const prompt = String(calls[1]!.body.prompt);
    expect(prompt).toContain("single warm storybook scene");
    expect(prompt).toContain(`Art direction: ${MONTAGE_INPUT.styleHint}.`);
    expect(STICKER_LEAK.test(prompt)).toBe(false);
  });

  it("images-endpoint montage payload requests the 5:7 card ratio (bleed-in fix) — item_image never does", async () => {
    // The 5:7 card crop must not truncate the greeting text: the montage
    // task asks for the card's exact 5:7 ratio via the normalized
    // `aspect_ratio` knob (providers clamp it to their supported subset, so
    // the bottom-anchored normalization crop stays minimal). Stickers stay
    // square — no aspect_ratio field may ride along on item_image.
    const imagesBody = () =>
      jsonResponse({
        data: [{ b64_json: "QUJD", media_type: "image/png" }],
      });

    const montage = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      imagesBody,
    ]);
    const montageProvider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: montage.fetchImpl,
      templates: textTemplates(),
    });
    await montageProvider.run(
      "montage_image",
      MONTAGE_INPUT,
      { ...MONTAGE_CFG, primary: "openai/gpt-image-1" },
    );
    expect(montage.calls[1]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(montage.calls[1]!.body.aspect_ratio).toBe("3:4");
    expect(montage.calls[1]!.body.size).toBeUndefined();

    const item = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      imagesBody,
    ]);
    const itemProvider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: item.fetchImpl,
      templates: textTemplates(),
    });
    await itemProvider.run("item_image", ITEM_INPUT, IMAGE_CFG);
    expect(item.calls[1]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(item.calls[1]!.body.size).toBeUndefined();
    expect(item.calls[1]!.body.aspect_ratio).toBeUndefined();
  });
});

// Minimal template dir (PromptTemplates.load requires every non-image task
// file) so a text task can reach the fetch layer in tests.
let tplDir: string | null = null;
const TEMPLATE_TASKS = [
  "prompt_validation",
  "moderation",
  "greeting_variations",
  "style_derivation",
  "layout_composition",
  "layout_critique",
  "layout_montage",
  "montage_prompt",
];
function textTemplates(): PromptTemplates {
  if (!tplDir) throw new Error("template dir not prepared");
  return new PromptTemplates(tplDir);
}
beforeAll(async () => {
  tplDir = await mkdtemp(path.join(tmpdir(), "cc-prompts-"));
  for (const t of TEMPLATE_TASKS) {
    await writeFile(path.join(tplDir, `${t}.md`), "ok");
  }
});
afterAll(async () => {
  if (tplDir) await rm(tplDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 402 "in_flight_budget_exhausted" hardening — typed marker on the provider
// ---------------------------------------------------------------------------

/** EXACT production 402 body (10×10 demo-bot load): the account still HAS
 *  credits, but concurrent in-flight requests would exceed the budget. */
const PROD_402_IN_FLIGHT_BODY =
  '{"error":{"message":"This request would exceed your available credits given your current in-flight requests...","code":402,"metadata":{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget"}}}';

/** A REGULAR 402 (genuinely out of credits — no in-flight marker anywhere). */
const REGULAR_402_BODY =
  '{"error":{"message":"You have exceeded your monthly credit limit of $10.00","code":402}}';

describe("OpenRouterProvider — 402 in-flight budget (typed marker)", () => {
  it("402 with reason in_flight_budget_exhausted → AiTaskError with inFlightBudget=true (retryable)", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_402_IN_FLIGHT_BODY), 402),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: true,
      retryable: true,
      message: expect.stringContaining("openrouter HTTP 402 (in-flight budget exhausted)"),
    });
    expect(calls).toHaveLength(1);
  });

  it("402 with limit_source openrouter_in_flight_budget (no reason field) → inFlightBudget=true", async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        jsonResponse(
          {
            error: {
              message: "This request would exceed your available credits...",
              code: 402,
              metadata: { limit_source: "openrouter_in_flight_budget" },
            },
          },
          402,
        ),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: true,
    });
  });

  it("regular 402 (genuinely out of credits — no in-flight marker) → inFlightBudget=false, still retryable", async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse(JSON.parse(REGULAR_402_BODY), 402)]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: false,
      retryable: true,
      message: expect.stringContaining("openrouter HTTP 402"),
    });
  });

  it("images endpoint 402 in-flight → same typed marker", async () => {
    const { fetchImpl } = scriptedFetch([
      // chat/completions rejects the image-only model (404 → images endpoint),
      // then the unified images API answers with the in-flight 402.
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      () => jsonResponse(JSON.parse(PROD_402_IN_FLIGHT_BODY), 402),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: true,
      message: expect.stringContaining("openrouter images HTTP 402"),
    });
  });

  it("402 in-flight with a Retry-After header → retryAfterSeconds parsed from the response headers", async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(PROD_402_IN_FLIGHT_BODY, {
          status: 402,
          headers: { "content-type": "application/json", "RETRY-AFTER": "10" },
        }),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: true,
      retryAfterSeconds: 10,
    });
  });

  it("402 in-flight Retry-After is case-insensitive (lowercase header) and absent → undefined", async () => {
    const { fetchImpl } = scriptedFetch([
      () =>
        new Response(PROD_402_IN_FLIGHT_BODY, {
          status: 402,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
      () => jsonResponse(JSON.parse(PROD_402_IN_FLIGHT_BODY), 402),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    const err1 = await provider.run("item_image", ITEM_INPUT, IMAGE_CFG).catch((e: unknown) => e as Error);
    expect(err1).toMatchObject({ inFlightBudget: true, retryAfterSeconds: 7 });
    const err2 = await provider.run("item_image", ITEM_INPUT, IMAGE_CFG).catch((e: unknown) => e as Error);
    expect(err2).toMatchObject({ inFlightBudget: true });
    expect((err2 as AiTaskError).retryAfterSeconds).toBeUndefined();
  });

  it("402 in-flight with garbage Retry-After values → header ignored (retryAfterSeconds undefined)", async () => {
    for (const garbage of ["soon", "1.5", "-3", "", "10s", "NaN"]) {
      const { fetchImpl } = scriptedFetch([
        () =>
          new Response(PROD_402_IN_FLIGHT_BODY, {
            status: 402,
            headers: { "content-type": "application/json", "retry-after": garbage },
          }),
      ]);
      const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
      const err = (await provider.run("item_image", ITEM_INPUT, IMAGE_CFG).catch(
        (e: unknown) => e as Error,
      )) as AiTaskError;
      expect(err.inFlightBudget).toBe(true);
      expect(err.retryAfterSeconds, `retry-after=${JSON.stringify(garbage)}`).toBeUndefined();
    }
  });

  it("parseRetryAfterSeconds: integer seconds only, case-insensitive, garbage/absent → undefined", () => {
    const resWith = (headers: Record<string, string>) =>
      new Response("x", { status: 402, headers });
    expect(parseRetryAfterSeconds(resWith({ "Retry-After": "12" }))).toBe(12);
    expect(parseRetryAfterSeconds(resWith({ "retry-after": " 30 " }))).toBe(30);
    expect(parseRetryAfterSeconds(resWith({ "RETRY-AFTER": "0" }))).toBe(0);
    expect(parseRetryAfterSeconds(resWith({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWith({ "retry-after": "2.5" }))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWith({ "retry-after": "-5" }))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWith({ "retry-after": "" }))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWith({ "x-other": "1" }))).toBeUndefined();
  });

  it("images endpoint 402 in-flight with Retry-After → same typed marker + parsed header", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(JSON.parse(PROD_404_BODY), 404),
      () =>
        new Response(PROD_402_IN_FLIGHT_BODY, {
          status: 402,
          headers: { "content-type": "application/json", "retry-after": "20" },
        }),
    ]);
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await expect(provider.run("item_image", ITEM_INPUT, IMAGE_CFG)).rejects.toMatchObject({
      inFlightBudget: true,
      retryAfterSeconds: 20,
      message: expect.stringContaining("openrouter images HTTP 402"),
    });
  });

  it("isInFlightBudgetBody: reason/limit_source/message markers, non-JSON fallback, regular 402 no match", () => {
    expect(isInFlightBudgetBody(PROD_402_IN_FLIGHT_BODY)).toBe(true);
    expect(
      isInFlightBudgetBody('{"error":{"code":402,"metadata":{"limit_source":"openrouter_in_flight_budget"}}}'),
    ).toBe(true);
    expect(
      isInFlightBudgetBody('{"error":{"message":"in-flight requests would exceed credits","code":402}}'),
    ).toBe(true);
    expect(isInFlightBudgetBody("plain-text in-flight budget exhausted")).toBe(true);
    expect(isInFlightBudgetBody(REGULAR_402_BODY)).toBe(false);
    expect(isInFlightBudgetBody('{"error":{"message":"out of credits","code":402}}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global outbound concurrency cap (semaphore)
// ---------------------------------------------------------------------------

describe("OpenRouter outbound semaphore (AI_MAX_CONCURRENT_REQUESTS)", () => {
  it("Semaphore: 20 fake calls with cap 2 → max observed in-flight == 2, all complete", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const call = async () => {
      const release = await sem.acquire();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      release();
      completed += 1;
    };
    await Promise.all(Array.from({ length: 20 }, call));
    expect(maxInFlight).toBe(2);
    expect(completed).toBe(20);
  });

  it("Semaphore: release in finally on error never deadlocks the queue", async () => {
    const sem = new Semaphore(1);
    const results: string[] = [];
    const call = async (fail: boolean) => {
      const release = await sem.acquire();
      try {
        if (fail) throw new Error("boom");
        results.push("ok");
      } finally {
        release();
      }
    };
    await Promise.all([call(false), call(true).catch(() => "swallowed"), call(false)]);
    expect(results).toEqual(["ok", "ok"]); // the throwing call released its slot
  });

  it("resolveMaxConcurrentRequests: absent/invalid → 6, valid integer wins", () => {
    expect(DEFAULT_AI_MAX_CONCURRENT_REQUESTS).toBe(6);
    const env = (v: string | undefined) =>
      (v === undefined ? {} : { AI_MAX_CONCURRENT_REQUESTS: v }) as unknown as NodeJS.ProcessEnv;
    expect(resolveMaxConcurrentRequests(undefined)).toBe(6);
    expect(resolveMaxConcurrentRequests(env(undefined))).toBe(6);
    expect(resolveMaxConcurrentRequests(env(""))).toBe(6);
    expect(resolveMaxConcurrentRequests(env("3"))).toBe(3);
    expect(resolveMaxConcurrentRequests(env("0"))).toBe(6);
    expect(resolveMaxConcurrentRequests(env("-2"))).toBe(6);
    expect(resolveMaxConcurrentRequests(env("2.5"))).toBe(6);
    expect(resolveMaxConcurrentRequests(env("nan"))).toBe(6);
  });

  it("provider constructor applies the env cap to the module-level semaphore", () => {
    const tinyPng = Buffer.from("89504e47", "hex");
    const dataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const { fetchImpl } = scriptedFetch([
      () =>
        jsonResponse({
          choices: [{ message: { content: null, images: [{ image_url: { url: dataUrl } }] } }],
        }),
    ]);
    new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      env: { AI_MAX_CONCURRENT_REQUESTS: "2" } as unknown as NodeJS.ProcessEnv,
    });
    expect(openrouterSemaphore.capacity).toBe(2);
    // Self-healing: constructing without env restores the default cap.
    new OpenRouterProvider({ apiKey: "k", fetchImpl });
    expect(openrouterSemaphore.capacity).toBe(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
  });

  it("20 concurrent provider.run calls with env cap 2 → max observed in-flight == 2", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return jsonResponse({
        choices: [
          { message: { content: null, images: [{ image_url: { url: "data:image/png;base64,QUJD" } }] } },
        ],
      });
    }) as typeof fetch;
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      env: { AI_MAX_CONCURRENT_REQUESTS: "2" } as unknown as NodeJS.ProcessEnv,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => provider.run("item_image", ITEM_INPUT, IMAGE_CFG)),
    );
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.imageBase64 === "QUJD")).toBe(true);
    expect(maxInFlight).toBe(2);
    // Reset the shared module-level semaphore so later tests keep the default.
    openrouterSemaphore.setLimit(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
  });
});

// ---------------------------------------------------------------------------
// Images-endpoint semaphore (AI_MAX_CONCURRENT_IMAGES) — Change: separate cap
// ---------------------------------------------------------------------------

/** TEXT_CFG: a fast text task with no schema so any JSON body succeeds. */
const TEXT_CFG = {
  name: "moderation" as const,
  primary: "google/gemini-2.5-flash",
  fallbacks: [],
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 8_000,
  retries: 1,
  structured: null,
  enabled: true,
};

/** Manual (deferred) fetch. Image tasks (modalities present) get the prod
 *  404 on chat/completions so they reroute to POST /images (the endpoint the
 *  images semaphore guards); gated calls (the /images endpoint itself + text
 *  tasks) park in-flight until the test flushes the gate. */
function gatedFetch(onCall?: (url: string, body: Record<string, unknown>) => void) {
  const gates: (() => void)[] = [];
  let open = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const urlStr = String(url);
    onCall?.(urlStr, body);
    // Image task on chat/completions → the EXACT prod 404 body that makes the
    // provider reroute the same attempt to the unified images endpoint.
    if (urlStr.endsWith("/chat/completions") && Array.isArray(body.modalities)) {
      return jsonResponse(JSON.parse(PROD_404_BODY), 404);
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (!open) {
      await new Promise<void>((resolve) => gates.push(resolve));
    }
    inFlight -= 1;
    if (urlStr.endsWith("/images")) {
      return jsonResponse({ data: [{ b64_json: "QUJD", media_type: "image/png" }] });
    }
    return jsonResponse({ choices: [{ message: { content: "{}" } }] });
  }) as typeof fetch;
  return {
    fetchImpl,
    /** Open every pending request's gate AND let all future gated calls
     *  through immediately (a one-time latch — chained semaphore admissions
     *  must never park on a gate nobody will open again). */
    flush: () => {
      open = true;
      while (gates.length) gates.shift()!();
    },
    get maxInFlight() { return maxInFlight; },
  };
}

describe("OpenRouter images semaphore (AI_MAX_CONCURRENT_IMAGES)", () => {
  it("resolveMaxConcurrentImages: absent/invalid → 3, valid wins, always clamped to the overall cap", () => {
    expect(DEFAULT_AI_MAX_CONCURRENT_IMAGES).toBe(3);
    const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv;
    // Absent / invalid → default 3.
    expect(resolveMaxConcurrentImages(undefined)).toBe(3);
    expect(resolveMaxConcurrentImages(env({}))).toBe(3);
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "" }))).toBe(3);
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "0" }))).toBe(3);
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "-2" }))).toBe(3);
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "2.5" }))).toBe(3);
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "nan" }))).toBe(3);
    // A valid integer wins.
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "5" }))).toBe(5);
    // Clamped to ≤ the overall cap when the image cap exceeds it.
    expect(
      resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_IMAGES: "10", AI_MAX_CONCURRENT_REQUESTS: "6" })),
    ).toBe(6);
    // Clamped even when the image value is absent but the overall is tiny
    // (preserves: image in-flight ≤ total in-flight).
    expect(resolveMaxConcurrentImages(env({ AI_MAX_CONCURRENT_REQUESTS: "2" }))).toBe(2);
  });

  it("provider constructor applies the env image cap to the module-level images semaphore", () => {
    const { fetchImpl } = gatedFetch();
    new OpenRouterProvider({
      apiKey: "k",
      fetchImpl,
      env: {
        AI_MAX_CONCURRENT_IMAGES: "2",
        AI_MAX_CONCURRENT_REQUESTS: "6",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(openrouterImageSemaphore.capacity).toBe(2);
    expect(openrouterSemaphore.capacity).toBe(6);
    // Self-healing: constructing without env restores BOTH defaults.
    new OpenRouterProvider({ apiKey: "k", fetchImpl });
    expect(openrouterImageSemaphore.capacity).toBe(DEFAULT_AI_MAX_CONCURRENT_IMAGES);
    expect(openrouterSemaphore.capacity).toBe(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
  });

  it("10 concurrent image calls with image cap 3 → max 3 concurrent image fetches", async () => {
    const imagesStarted: number[] = [];
    const gate = gatedFetch((url) => {
      if (url.endsWith("/images")) imagesStarted.push(Date.now());
    });
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: gate.fetchImpl,
      env: {
        AI_MAX_CONCURRENT_IMAGES: "3",
        AI_MAX_CONCURRENT_REQUESTS: "6",
      } as unknown as NodeJS.ProcessEnv,
    });
    const runs = Array.from({ length: 10 }, () =>
      provider.run("item_image", ITEM_INPUT, IMAGE_CFG),
    );
    // Let the acquire microtasks settle, then count what actually started.
    await new Promise((r) => setTimeout(r, 25));
    expect(imagesStarted).toHaveLength(3); // only 3 /images requests in flight
    expect(gate.maxInFlight).toBe(3);
    gate.flush();
    const results = await Promise.all(runs);
    expect(results).toHaveLength(10);
    expect(gate.maxInFlight).toBe(3); // never exceeded across the whole run
  });

  it("text calls proceed while 3 image calls are held (text slots never starve)", async () => {
    const gate = gatedFetch();
    new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: gate.fetchImpl,
      templates: textTemplates(),
      env: {
        AI_MAX_CONCURRENT_IMAGES: "3",
        AI_MAX_CONCURRENT_REQUESTS: "6",
      } as unknown as NodeJS.ProcessEnv,
    });
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: gate.fetchImpl,
      templates: textTemplates(),
    });
    // Hold 3 image calls (they occupy 3 of the 6 global slots).
    const imageRuns = Array.from({ length: 3 }, () =>
      provider.run("item_image", ITEM_INPUT, IMAGE_CFG),
    );
    await new Promise((r) => setTimeout(r, 25));
    // Text calls must still go through while the images are held.
    const textRuns = Array.from({ length: 3 }, () =>
      provider.run("moderation", { text: "cat" }, TEXT_CFG),
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(gate.maxInFlight).toBe(6); // 3 held images + 3 text calls in flight
    gate.flush();
    await Promise.all([...imageRuns, ...textRuns]);
    // Reset BOTH shared module-level semaphores for later tests.
    openrouterSemaphore.setLimit(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
    openrouterImageSemaphore.setLimit(DEFAULT_AI_MAX_CONCURRENT_IMAGES);
  });

  it("image calls release BOTH semaphores (total ≤ overall cap) even when the request throws", async () => {
    let imageCalls = 0;
    // chat/completions 404s (image reroute), then the /images fetch itself
    // fails — each run must acquire AND release BOTH semaphores.
    const failFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/images")) {
        imageCalls += 1;
        throw new Error("network down");
      }
      return jsonResponse(JSON.parse(PROD_404_BODY), 404);
    }) as typeof fetch;
    new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: failFetch,
      env: {
        AI_MAX_CONCURRENT_IMAGES: "3",
        AI_MAX_CONCURRENT_REQUESTS: "6",
      } as unknown as NodeJS.ProcessEnv,
    });
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl: failFetch });
    // 10 failing image calls must not leak slots from either semaphore.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        provider.run("item_image", ITEM_INPUT, IMAGE_CFG).catch((e: unknown) => e),
      ),
    );
    expect(imageCalls).toBe(10);
    expect(results.every((e) => e instanceof Error)).toBe(true);
    // No deadlock, no leaked slots: a fresh image call goes straight through.
    const gate = gatedFetch();
    const probe = new OpenRouterProvider({ apiKey: "k", fetchImpl: gate.fetchImpl });
    const done = probe.run("item_image", ITEM_INPUT, IMAGE_CFG);
    await new Promise((r) => setTimeout(r, 25));
    expect(gate.maxInFlight).toBe(1);
    gate.flush();
    await done;
    openrouterSemaphore.setLimit(DEFAULT_AI_MAX_CONCURRENT_REQUESTS);
    openrouterImageSemaphore.setLimit(DEFAULT_AI_MAX_CONCURRENT_IMAGES);
  });
});
