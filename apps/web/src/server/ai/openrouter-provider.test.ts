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

import { PromptTemplates } from "./templates";
import { montageImagePrompt, OpenRouterProvider } from "./openrouter-provider";

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
    expect(montage.calls[1]!.body.aspect_ratio).toBe("5:7");
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
