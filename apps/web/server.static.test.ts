/**
 * /static/* serving from the custom server (server.ts) — runtime-written
 * card images (stickers, montage posters) must be served from disk even
 * though Next production only serves public/ assets that existed at build
 * time. Regression: on Railway the prod image has an empty static dir at
 * boot, so Next 404'd every sticker/poster (item:ready but broken <img>).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import http from "node:http";

import { createAiRouter } from "./src/server/ai/router";
import { MemoryRepo } from "./src/server/repo/memory-repo";
import { DEFAULT_ITEMS_DIR } from "./src/server/flows/item-image";

import { createServer } from "./server";

let srv: Awaited<ReturnType<typeof createServer>>;
let base: string;
const written: string[] = [];

beforeEach(async () => {
  const repo = new MemoryRepo();
  const ai = await createAiRouter({ repo, env: { AI_MODE: "mock", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
  srv = await createServer({ repo, enableNext: false, ai });
  await new Promise<void>((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
  const addr = srv.httpServer.address() as import("node:net").AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => srv.httpServer.close(() => resolve()));
  await srv.close();
  for (const f of written) await rm(f, { force: true });
  written.length = 0;
});

function get(path: string, method = "GET"): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("custom-server /static handler", () => {
  it("serves a runtime-written sticker PNG from disk", async () => {
    await mkdir(DEFAULT_ITEMS_DIR, { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001od", "hex");
    const file = path.join(DEFAULT_ITEMS_DIR, "static-handler-test.png");
    await writeFile(file, png);
    written.push(file);

    const res = await get("/static/items/static-handler-test.png");
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/png");
    expect(res.body.equals(png)).toBe(true);
  });

  it("404s a missing image (does not fall through to Next)", async () => {
    const res = await get("/static/items/nope-does-not-exist.png");
    expect(res.status).toBe(404);
    expect(res.type).toContain("application/json");
  });

  it("blocks path traversal outside the static root", async () => {
    const res = await get("/static/..%2F..%2Fserver.ts");
    expect([403, 404]).toContain(res.status);
  });

  it("rejects non-GET/HEAD methods", async () => {
    const res = await get("/static/items/whatever.png", "POST");
    expect(res.status).toBe(405);
  });
});
