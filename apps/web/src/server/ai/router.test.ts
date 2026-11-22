import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG } from "@cardcrafters/shared";

const sharp = (await import("sharp")).default;

import { MemoryRepo } from "../repo/memory-repo";
import { AiBudgetExceededError, AiTaskError } from "./errors";
import { OpenRouterProvider } from "./openrouter-provider";
import { loadTaskConfig, TASK_NAMES, type AiTaskName, type TaskConfig } from "./provider";
import {
  AiRouter,
  createAiRouter,
  DEFAULT_AI_BUDGET_PER_GAME_USD,
  DEFAULT_CALL_ESTIMATE_USD,
  DEFAULT_IMAGE_CALL_ESTIMATE_USD,
  resolveBudgetUsd,
} from "./router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** auto without an API key → resolves to mock; keep tests off the network. */
const CLEAN_ENV = { AI_MODE: "auto", MOCK_AI_DELAY_MS: "0" } as unknown as NodeJS.ProcessEnv;
const CONFIG = (await loadTaskConfig(CLEAN_ENV)).tasks;

async function mkRepo() {
  const repo = new MemoryRepo();
  const game = await repo.createGame({ config: DEFAULT_CARD_CONFIG });
  return { repo, gameId: game.id };
}

function taskCfg(task: AiTaskName, over: Partial<TaskConfig> = {}): TaskConfig {
  return {
    name: task,
    primary: "test/primary",
    fallbacks: [],
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
    retries: 0,
    structured: null,
    enabled: true,
    ...over,
  };
}

function configFor(base: TaskConfig): Record<AiTaskName, TaskConfig> {
  const out = {} as Record<AiTaskName, TaskConfig>;
  for (const t of TASK_NAMES) out[t] = { ...base, name: t };
  return out;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { fn, calls, models: () => calls.map((c) => JSON.parse(String(c.init.body)).model as string) };
}

function completionRes(contentObj: unknown, cost = 0.012): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(contentObj) } }],
      usage: { prompt_tokens: 12, completion_tokens: 30, cost },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const VALID_VALIDATION = { valid: true, reason: "", normalized_subject: "golden retriever" };

/** OpenRouter-backed router for prompt_validation; all HTTP goes to `handler`. */
async function mkOpenRouterRouter(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { budgetUsd?: number; cfg?: TaskConfig; sleepMs?: (ms: number) => Promise<void> } = {},
) {
  const { repo, gameId } = await mkRepo();
  const { fn, calls } = mockFetch(handler);
  const provider = new OpenRouterProvider({ apiKey: "sk-test", fetchImpl: fn });
  const base = opts.cfg ?? CONFIG.prompt_validation;
  const router = new AiRouter({
    repo,
    mode: "openrouter",
    config: configFor(base),
    provider,
    ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
    ...(opts.sleepMs ? { sleepMs: opts.sleepMs } : {}),
  });
  return { repo, router, calls, models: () => calls.map((c) => JSON.parse(String(c.init.body)).model as string), gameId, provider };
}

/** EXACT production 402 body (10×10 demo-bot load): the account still HAS
 *  credits, but concurrent in-flight requests would exceed the budget. */
const PROD_402_IN_FLIGHT_BODY =
  '{"error":{"message":"This request would exceed your available credits given your current in-flight requests...","code":402,"metadata":{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget"}}}';

function inFlight402Res(): Response {
  return new Response(PROD_402_IN_FLIGHT_BODY, {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** A REGULAR 402 (genuinely out of credits — no in-flight marker anywhere). */
function regular402Res(): Response {
  return new Response(
    '{"error":{"message":"You have exceeded your monthly credit limit of $10.00","code":402}}',
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Mock-mode router
// ---------------------------------------------------------------------------

describe("AiRouter — mock mode", () => {
  it("returns zod-validated outputs for every enabled task (cost 0)", async () => {
    const { repo, gameId } = await mkRepo();
    const router = new AiRouter({ repo, mode: "mock", config: CONFIG, env: CLEAN_ENV });
    const inputs: Record<AiTaskName, Record<string, unknown>> = {
      prompt_validation: { prompt: "golden retriever party hat" },
      moderation: { prompt: "golden retriever party hat" },
      greeting_variations: { theme: "birthday", count: 3 },
      style_derivation: { theme: "birthday" },
      item_image: { prompt: "red balloon" },
      layout_composition: { items: [{ id: "a" }, { id: "b" }] },
      layout_critique: {},
      layout_montage: { items: [{ id: "a" }, { id: "b" }] },
      montage_prompt: {
        theme: "birthday",
        greeting: "Happy Birthday!",
        subjects: ["a red balloon", "a gift box"],
      },
      montage_image: {
        theme: "birthday",
        greeting: "Happy Birthday!",
        subjects: ["a red balloon", "a gift box"],
      },
    };
    for (const task of TASK_NAMES) {
      const res = await router.run(task, inputs[task], { gameId });
      expect(res.model).toBe(`mock/${task}`);
      if (task === "item_image") expect(res.imageBase64).toBeTruthy();
      else expect(res.data).toBeTruthy();
    }
    const summary = await repo.listAiCalls(gameId);
    expect(summary.rows).toHaveLength(TASK_NAMES.length);
    expect(summary.rows.every((r) => r.status === "OK")).toBe(true);
    expect(summary.totalCostUsd).toBe(0);
  });

  it("layout_critique (mock): deterministic fixed verdict, logged like any task", async () => {
    const { repo, gameId } = await mkRepo();
    const router = new AiRouter({ repo, mode: "mock", config: CONFIG });
    const res = await router.run("layout_critique", { layoutSummary: "x" }, { gameId });
    expect(res.model).toBe("mock/layout_critique");
    expect(res.data).toEqual({ score: 80, issues: [], focalOk: true });
    const summary = await repo.listAiCalls(gameId);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]!.status).toBe("OK");
  });

  it("throws on unknown task names", async () => {
    const { repo } = await mkRepo();
    const router = new AiRouter({ repo, mode: "mock", config: CONFIG });
    await expect(router.run("make_coffee", {})).rejects.toThrow(/unknown AI task/);
  });

  it("auto mode without an API key resolves to the mock provider", async () => {
    const { repo } = await mkRepo();
    const router = await createAiRouter({ repo, env: CLEAN_ENV });
    const res = await router.run("prompt_validation", { prompt: "big red balloon" });
    expect(res.model).toBe("mock/prompt_validation");
  });

  it("respects AI_TASK_<NAME>_MODEL / FALLBACKS env overrides", async () => {
    const loaded = await loadTaskConfig({
      AI_TASK_ITEM_IMAGE_MODEL: "test/image-model",
      AI_TASK_ITEM_IMAGE_FALLBACKS: "test/image-b, test/image-c",
    } as unknown as NodeJS.ProcessEnv);
    expect(loaded.tasks.item_image.primary).toBe("test/image-model");
    expect(loaded.tasks.item_image.fallbacks).toEqual(["test/image-b", "test/image-c"]);
    expect(loaded.tasks.prompt_validation.primary).toBe("google/gemini-3.5-flash-lite");
  });
});

// ---------------------------------------------------------------------------
// OpenRouter provider + retry/fallback chain (globally-mocked fetch)
// ---------------------------------------------------------------------------

describe("AiRouter — openrouter (mocked fetch)", () => {
  it("sends the correct request shape and parses/validates the response", async () => {
    const { router, calls, repo, gameId } = await mkOpenRouterRouter(() =>
      completionRes(VALID_VALIDATION, 0.0123),
    );
    const gid = gameId;
    const res = await router.run("prompt_validation", { prompt: "big red balloon" }, { gameId: gid });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toContain("/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["User-Agent"]).toMatch(/CardCrafters/);
    expect(headers["HTTP-Referer"]).toBeTruthy();
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(CONFIG.prompt_validation.primary);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(CONFIG.prompt_validation.maxTokens);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.usage).toEqual({ include: true });
    expect(JSON.stringify(body.messages)).toContain("big red balloon");

    expect(res.data).toEqual(VALID_VALIDATION);
    expect(res.usage?.costUsd).toBe(0.0123);
    const summary = await repo.listAiCalls(gameId);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]!.status).toBe("OK");
    expect(summary.rows[0]!.fallbackUsed).toBe(false);
    expect(summary.totalCostUsd).toBeCloseTo(0.0123, 6);
  });

  it("500 → retry → fallback model used → FALLBACK_OK logged", async () => {
    const primary = CONFIG.prompt_validation.primary;
    const fallback = CONFIG.prompt_validation.fallbacks[0]!;
    const { router, models, repo, gameId } = await mkOpenRouterRouter((_url, init) => {
      const model = JSON.parse(String(init.body)).model as string;
      return model === primary
        ? new Response("upstream exploded", { status: 500 })
        : completionRes(VALID_VALIDATION, 0.001);
    });
    const gid = gameId;
    const res = await router.run("prompt_validation", { prompt: "big red balloon" }, { gameId: gid });

    expect(res.data).toEqual(VALID_VALIDATION);
    // retries=2 → the primary gets 3 attempts, the fallback succeeds on its first
    expect(models()).toEqual([primary, primary, primary, fallback]);
    const rows = (await repo.listAiCalls(gid)).rows;
    expect(rows.map((r) => r.status)).toEqual(["ERROR", "ERROR", "ERROR", "FALLBACK_OK"]);
    expect(rows[3]!.fallbackUsed).toBe(true);
    expect(rows[3]!.model).toBe(fallback);
    // retries is CUMULATIVE across all models in the run, on every row.
    expect(rows.map((r) => r.retries)).toEqual([1, 2, 3, 3]);
  });

  it("schema-invalid output is retried across the chain; exhaustion throws AiTaskError", async () => {
    // prompt_validation: retries=2, fallbacks=[gemini-3.8-flash, gpt-6-luna]
    // → every model gets 3 attempts → 9 calls, all ERROR.
    const { router, models, repo, gameId } = await mkOpenRouterRouter(() =>
      completionRes({ valid: true, reason: "" /* normalized_subject missing */ }, 0),
    );
    const gid = gameId;
    await expect(router.run("prompt_validation", { prompt: "x" }, { gameId: gid })).rejects.toThrow(
      AiTaskError,
    );
    expect(models()).toHaveLength(9);
    const rows = (await repo.listAiCalls(gid)).rows;
    expect(rows.every((r) => r.status === "ERROR")).toBe(true);
  });

  it("timeout produces a retryable failure with ERROR rows", async () => {
    const cfgTimeout: TaskConfig = {
      ...CONFIG.prompt_validation,
      timeoutMs: 30,
      retries: 0,
      fallbacks: [],
    };
    const { repo, gameId } = await mkRepo();
    const { fn } = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          expect(signal instanceof AbortSignal).toBe(true);
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const provider = new OpenRouterProvider({ apiKey: "sk-test", fetchImpl: fn });
    const router = new AiRouter({
      repo,
      mode: "openrouter",
      config: configFor(cfgTimeout),
      provider,
    });
    await expect(router.run("prompt_validation", { prompt: "x" }, { gameId })).rejects.toThrow(AiTaskError);
    const rows = (await repo.listAiCalls(gameId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ERROR");
    // retries is the cumulative failed-attempt count (1 failed attempt here).
    expect(rows[0]!.retries).toBe(1);
  });

  it("fatal 400 skips remaining retries but still tries fallback models", async () => {
    const primary = CONFIG.prompt_validation.primary;
    const fallback = CONFIG.prompt_validation.fallbacks[0]!;
    const { router, models } = await mkOpenRouterRouter(() => new Response("bad request", { status: 400 }));
    await expect(router.run("prompt_validation", { prompt: "x" })).rejects.toThrow(AiTaskError);
    // 400 is fatal per-model (no retry on the same model) but the chain continues
    // through every fallback → primary + both fallbacks, 1 attempt each.
    expect(models()).toEqual([primary, fallback, CONFIG.prompt_validation.fallbacks[1]!]);
  });

  // -- 402 "in_flight_budget_exhausted": back off + retry the SAME model -----
  // (the account still HAS credits; retrying immediately adds MORE in-flight
  // requests and makes the 402 worse — OpenRouter's remedy: "Retry after
  // in-flight requests settle.")
  it("402 in-flight twice then success → retries the SAME model with 4s/8s backoff, no fallback advance", async () => {
    let n = 0;
    const waits: number[] = [];
    const primary = CONFIG.prompt_validation.primary;
    const { router, models, repo, gameId } = await mkOpenRouterRouter(
      () => {
        n += 1;
        return n <= 2 ? inFlight402Res() : completionRes(VALID_VALIDATION);
      },
      { sleepMs: async (ms) => { waits.push(ms); } },
    );
    const res = await router.run("prompt_validation", { prompt: "big red balloon" }, { gameId });
    expect(res.data).toEqual(VALID_VALIDATION);
    // Never advanced to a fallback model: primary, primary, primary.
    expect(models()).toEqual([primary, primary, primary]);
    // First wait 4s, second 8s (per-call state, never global).
    expect(waits).toEqual([4000, 8000]);
    const rows = (await repo.listAiCalls(gameId)).rows;
    expect(rows.map((r) => r.status)).toEqual(["ERROR", "ERROR", "OK"]);
    // In-flight waits do NOT count as failed attempts (retries stays 0).
    expect(rows.map((r) => r.retries)).toEqual([0, 0, 0]);
    expect(rows[2]!.fallbackUsed).toBe(false);
  });

  it("regular 402 (no in-flight marker) → fails fast as before: no waits, burns attempts + fallbacks", async () => {
    const waits: number[] = [];
    const { router, models, repo, gameId } = await mkOpenRouterRouter(
      () => regular402Res(),
      { sleepMs: async (ms) => { waits.push(ms); } },
    );
    await expect(router.run("prompt_validation", { prompt: "x" }, { gameId })).rejects.toThrow(AiTaskError);
    // prompt_validation: retries=2, 2 fallbacks → 3 models × 3 attempts = 9 calls.
    expect(models()).toHaveLength(9);
    expect(waits).toEqual([]); // a regular 402 has nothing to wait for
    const rows = (await repo.listAiCalls(gameId)).rows;
    expect(rows.every((r) => r.status === "ERROR")).toBe(true);
    expect(rows.map((r) => r.retries)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("in-flight 402 beyond the 3-wait cap falls back to normal failure logic (waits stop)", async () => {
    const waits: number[] = [];
    const { router, models, repo, gameId } = await mkOpenRouterRouter(
      () => inFlight402Res(),
      { sleepMs: async (ms) => { waits.push(ms); } },
    );
    await expect(router.run("prompt_validation", { prompt: "x" }, { gameId })).rejects.toThrow(AiTaskError);
    // 3 waits (4s/8s/12s), then the 402 is handled like any other retryable
    // failure: primary = 3 in-flight retries on attempt 0 + 3 normal attempts
    // = 6 calls; each fallback = 3 normal attempts = 3 calls each → 12 total.
    expect(waits).toEqual([4000, 8000, 12000]);
    expect(models()).toHaveLength(12);
    const rows = (await repo.listAiCalls(gameId)).rows;
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.status === "ERROR")).toBe(true);
    // retries counts FAILED attempts only — the 3 in-flight waits don't
    // increment it, so the counter reads [0,0,0, then 1..9].
    expect(rows.map((r) => r.retries)).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter item_image prompt (die-cut sticker look)
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — item_image prompt (plain-white bg)", () => {
  it("synthesizes an item_image prompt: centered 75–85% subject, transparent padding on all sides + style suffix", async () => {
    const tinyPng = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const { fn, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "sticker", images: [{ image_url: { url: dataUrl } }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new OpenRouterProvider({ apiKey: "sk-test", fetchImpl: fn });
    const res = await provider.run(
      "item_image",
      { subject: "a red balloon dog", styleSuffix: "flat vector, bold outlines" },
      taskCfg("item_image", { maxTokens: 0 }),
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.modalities).toEqual(["image", "text"]);
    const text = body.messages[0].content as string;
    expect(text).toContain("a red balloon dog");
    expect(text).toContain("75–85%");
    expect(text).toContain("padding on ALL sides");
    expect(text).toContain("PLAIN SOLID WHITE");
    expect(text).toContain("never checkered");
    expect(text).toContain("CENTERED");
    // Style suffix is still inserted.
    expect(text).toContain("flat vector, bold outlines");
    // And the image round-trips back out of the response.
    expect(res.imageBase64).toBe(tinyPng.toString("base64"));
    expect(res.imageMime).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

describe("AiRouter — budget guard", () => {
  it("throws AiBudgetExceededError BEFORE any provider call when spend ≥ budget", async () => {
    const { repo, gameId } = await mkRepo();
    for (const cost of [0.5, 0.5]) {
      await repo.insertAiCall({
        gameId,
        task: "item_image",
        model: "google/gemini-2.5-flash-image",
        status: "OK",
        latencyMs: 100,
        costUsd: cost,
      });
    }
    let called = false;
    const router = new AiRouter({
      repo,
      mode: "mock",
      config: CONFIG,
      budgetUsd: 0.000001,
      provider: {
        run: () => {
          called = true;
          return Promise.reject(new Error("provider must not be called"));
        },
      },
    });
    await expect(router.run("moderation", { prompt: "x" }, { gameId })).rejects.toThrow(
      AiBudgetExceededError,
    );
    expect(called).toBe(false);
    const summary = await repo.listAiCalls(gameId);
    expect(summary.rows).toHaveLength(2); // blocked call logged nothing
    expect(summary.totalCostUsd).toBeCloseTo(1.0, 6);
  });

  it("runs below budget; cost summary aggregation matches inserts", async () => {
    const { repo, gameId } = await mkRepo();
    await repo.insertAiCall({
      gameId,
      task: "item_image",
      model: "google/gemini-2.5-flash-image",
      status: "OK",
      latencyMs: 50,
      costUsd: 0.25,
    });
    const { fn, calls } = mockFetch(() => completionRes(VALID_VALIDATION, 0.006));
    const router = new AiRouter({
      repo,
      mode: "openrouter",
      config: CONFIG,
      budgetUsd: 1,
      provider: new OpenRouterProvider({ apiKey: "sk-test", fetchImpl: fn }),
    });
    await router.run("prompt_validation", { prompt: "x" }, { gameId });
    expect(calls).toHaveLength(1);
    const summary = await repo.listAiCalls(gameId);
    expect(summary.totalCostUsd).toBeCloseTo(0.256, 6); // 0.25 inserted + 0.006 call
    const pv = summary.perTask.find((t) => t.task === "prompt_validation");
    expect(pv?.count).toBe(1);
    expect(pv?.totalCostUsd).toBeCloseTo(0.006, 6);
  });

  it("mock calls never trip the budget (they cost 0)", async () => {
    const { repo, gameId } = await mkRepo();
    const router = new AiRouter({ repo, mode: "mock", config: CONFIG, budgetUsd: 0.0000001 });
    for (let i = 0; i < 5; i++) {
      await expect(router.run("moderation", { prompt: "x" }, { gameId })).resolves.toBeTruthy();
    }
    expect(await router.spendUsd(gameId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createAiRouter factory
// ---------------------------------------------------------------------------

describe("createAiRouter", () => {
  it("wires mode/budget from env and per-task config from the repo config file", async () => {
    const { repo } = await mkRepo();
    const router = await createAiRouter({
      repo,
      env: {
        AI_MODE: "mock",
        AI_BUDGET_PER_GAME_USD: "25",
        MOCK_AI_DELAY_MS: "0",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(router.taskConfig("item_image")?.timeoutMs).toBe(60000);
    expect(router.taskConfig("prompt_validation")?.structured).toBe("promptValidationSchema");
    expect(router.taskConfig("layout_critique")?.enabled).toBe(true);
    expect(router.taskConfig("layout_montage")?.enabled).toBe(true);
    expect(router.taskConfig("layout_montage")?.structured).toBe("layoutMontageSchema");
    // under the $25 budget a mock call succeeds (mock costs 0, unknown game ok)
    await expect(router.run("moderation", { prompt: "x" }, { gameId: "fresh-game" })).resolves.toBeTruthy();
  });

  it("defaults: $50/game budget (env override wins) + realistic cost reserves", () => {
    // USER DECISION: $50/game (generous runaway protection, not a spend
    // target — measured play is ~$1/game). Env override wins.
    expect(DEFAULT_AI_BUDGET_PER_GAME_USD).toBe(50);
    // Reserves gate CONCURRENT in-flight calls only; they must match realistic
    // per-call costs ($0.03–0.04 image, $0.001–0.005 text) so 10-team games
    // don't lock themselves out by over-reserving.
    expect(DEFAULT_IMAGE_CALL_ESTIMATE_USD).toBe(0.05);
    expect(DEFAULT_CALL_ESTIMATE_USD).toBe(0.01);
    // No env var → the default; a valid positive env value wins; invalid
    // values (0, negative, garbage) fall back to the default too.
    expect(resolveBudgetUsd({} as unknown as NodeJS.ProcessEnv)).toBe(50);
    expect(resolveBudgetUsd({ AI_BUDGET_PER_GAME_USD: "40" } as unknown as NodeJS.ProcessEnv)).toBe(40);
    expect(resolveBudgetUsd({ AI_BUDGET_PER_GAME_USD: "0" } as unknown as NodeJS.ProcessEnv)).toBe(50);
    expect(resolveBudgetUsd({ AI_BUDGET_PER_GAME_USD: "-5" } as unknown as NodeJS.ProcessEnv)).toBe(50);
    expect(resolveBudgetUsd({ AI_BUDGET_PER_GAME_USD: "nan" } as unknown as NodeJS.ProcessEnv)).toBe(50);
  });
});