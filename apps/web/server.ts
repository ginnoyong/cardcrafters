/**
 * Card Crafters server — custom bootstrap (Step 3).
 *
 * Boot sequence:
 *   1. load .env (dotenv; see .env.example)
 *   2. create the http server (health endpoint handled before anything else)
 *   3. attach Socket.IO on the SAME http server at path `/socket.io`
 *   4. construct the Repository: PrismaRepo when DATABASE_URL is set,
 *      MemoryRepo otherwise (zero-infra mode)
 *   5. wrap it in a GameHub + TimerService and reconcile timers
 *      (`hydrateTimers` re-arms future phase timers and fires already-expired
 *      ones so a restart never strands a mid-BUILD game)
 *   6. best-effort: wire the Next.js request handler for everything that is
 *      not `/api/health`
 *
 * Next wiring notes / dev detection:
 *   - `dev` is true unless NODE_ENV === "production" — i.e. running via
 *     `tsx watch apps/web/server.ts` (npm run dev) boots Next in dev mode and
 *     compiles on demand, no `.next` build required.
 *   - In production (Docker: NODE_ENV=production after `next build`) we attach
 *     the built `.next` output. If the Next app cannot be prepared for any
 *     reason, we log a warning and keep serving `/api/health` + Socket.IO —
 *     the game server degrades gracefully instead of crashing.
 *
 * Exports `createServer(opts)` WITHOUT listening, so integration tests can
 * boot it on an ephemeral port; the main entry (bottom of this file) uses the
 * factory and listens on PORT, with SIGINT/SIGTERM graceful shutdown.
 */

import "dotenv/config";

import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Server as SocketServer } from "socket.io";

import { createAiRouter, type AiRouter } from "./src/server/ai/router";
import { GameHub } from "./src/server/game/hub";
import { hydrateTimers } from "./src/server/game/timer-service";
import { handleApiRequest } from "./src/server/http/api";
import { MemoryRepo } from "./src/server/repo/memory-repo";
import type { Repository } from "./src/server/repo/repository";
import { PrismaRepo } from "./src/server/repo/prisma-repo";
import { registerSocketHandlers } from "./src/server/ws/server";
import { DEFAULT_ITEMS_DIR } from "./src/server/flows/item-image";
import { DEFAULT_MONTAGE_DIR } from "./src/server/flows/montage-accumulator";
import { createReadStream, promises as fsp } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/web

export interface CreateServerOptions {
  /** Repository override (tests inject a MemoryRepo). Defaults by env. */
  repo?: Repository;
  /** AiRouter override (tests inject a mock-mode router). Default: createAiRouter(env). */
  ai?: AiRouter;
  /** Attach the Next.js request handler (default: true; tests pass false). */
  enableNext?: boolean;
  /** Next dev mode override; defaults to NODE_ENV !== "production". */
  dev?: boolean;
}

export interface CardCraftersServer {
  httpServer: http.Server;
  io: SocketServer;
  hub: GameHub;
  repo: Repository;
  /** AI router (mock mode by default) — greeting generation + gm:regenGreeting. */
  ai: AiRouter;
  /** Stops Socket.IO + http server and disconnects the owned Prisma client. */
  close(): Promise<void>;
}

/** Repository selection: Prisma when DATABASE_URL is set, memory otherwise. */
function defaultRepo(): Repository {
  if (process.env.DATABASE_URL) {
    // PrismaClient construction is lazy (no connection attempt until the
    // first query), so a bad URL surfaces later as a query error, not here.
    return new PrismaRepo();
  }
  // eslint-disable-next-line no-console
  console.warn("[card-crafters] DATABASE_URL not set — using in-memory repository");
  return new MemoryRepo();
}

/**
 * Best-effort Next.js handler. Returns null when Next is unavailable or
 * unbuilt; the http server then falls back to 404s for non-health routes.
 */
async function loadNextHandler(dev: boolean): Promise<http.RequestListener | null> {
  try {
    // Sanity check the production build dir; next() itself would also fail,
    // but this gives a much clearer message.
    if (!dev && !existsSync(path.join(here, ".next", "BUILD_ID"))) {
      console.warn(
        "[card-crafters] NODE_ENV=production but .next/BUILD_ID missing — skipping Next wiring (run `next build`)",
      );
      return null;
    }
    const { default: next } = await import("next");
    const app = next({ dev, dir: here });
    await app.prepare();
    return app.getRequestHandler();
  } catch (err) {
    console.warn(
      "[card-crafters] Next handler unavailable — serving API/WS only:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Build the full server WITHOUT listening. Integration tests pass a repo
 * override (memory) and listen on port 0 themselves.
 */
export async function createServer(opts: CreateServerOptions = {}): Promise<CardCraftersServer> {
  const repo = opts.repo ?? defaultRepo();

  const nextHandlerRef: { handler: http.RequestListener | null } = { handler: null };
  // Filled in below (hub needs the io server which needs the http server).
  const hubRef: { hub: GameHub | null } = { hub: null };
  const aiRef: { ai: AiRouter | null } = { ai: null };
  const ioRef: { io: SocketServer | null } = { io: null };

  /**
   * Runtime-generated image files (stickers + montage posters) are written
   * under public/static AFTER the Next build — and Next production only
   * serves assets that existed at build time, so it would 404 every card
   * image. Serve /static/* directly from disk here (per-request read),
   * before the Next fallthrough. Works identically in dev and prod.
   */
  const STATIC_ROOT = path.dirname(DEFAULT_ITEMS_DIR); // apps/web/public/static
  const STATIC_CONTENT_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
      return;
    }
    // Traversal guard: decode, then require the resolved path to stay under
    // the static root (montage URLs nest {gameId}/{teamId}/{file} inside it).
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice("/static/".length));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad_path" }));
      return;
    }
    const abs = path.resolve(STATIC_ROOT, rel);
    if (abs !== STATIC_ROOT && !abs.startsWith(STATIC_ROOT + path.sep)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const contentType = STATIC_CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    fsp
      .stat(abs)
      .then((st) => {
        if (!st.isFile()) throw new Error("not a file");
        res.writeHead(200, {
          "content-type": contentType,
          "content-length": st.size,
          "cache-control": "public, max-age=31536000, immutable",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        const stream = createReadStream(abs);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      })
      .catch(() => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
      });
  };

  /** Non-API request: Next when available, 404 otherwise. */
  const fallthrough = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const handler = nextHandlerRef.handler;
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error: "not_found", hint: "next handler not ready (or disabled)" }),
    );
  };

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/health" || url.startsWith("/api/health?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "card-crafters" }));
      return;
    }
    // Tiny JSON API (game create/summary) — handled BEFORE Next so the GM
    // console can create games even while Next is still compiling.
    if (url.startsWith("/api/games")) {
      if (!hubRef.hub || !aiRef.ai || !ioRef.io) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "starting_up" }));
        return;
      }
      void handleApiRequest(req, res, hubRef.hub, repo, aiRef.ai, ioRef.io).then((consumed) => {
        if (!consumed) fallthrough(req, res);
      });
      return;
    }
    if (url === "/static" || url.startsWith("/static/")) {
      serveStatic(req, res, url.slice(0, url.indexOf("?") === -1 ? undefined : url.indexOf("?")));
      return;
    }
    fallthrough(req, res);
  });

  const io = new SocketServer(httpServer, { path: "/socket.io" });
  const hub = new GameHub(repo, io);
  hubRef.hub = hub;
  // AI router (mock mode unless OPENROUTER_API_KEY works) — powers greeting
  // generation at game creation + the gm:regenGreeting handler.
  const ai = opts.ai ?? (await createAiRouter({ repo }));
  aiRef.ai = ai;
  ioRef.io = io;
  // Socket handlers + image queue (BullMQ when REDIS_URL is set, memory
  // otherwise — see registerSocketHandlers). The returned disposer shuts the
  // queue worker down on server close.
  const ws = registerSocketHandlers(io, hub, repo, ai);

  // Boot reconciliation: re-arm future phase timers / fire expired ones.
  await hydrateTimers(hub.timers, hub, repo);

  // Next wiring is best-effort and never blocks socket/health boot.
  if (opts.enableNext ?? true) {
    const dev = opts.dev ?? process.env.NODE_ENV !== "production";
    void loadNextHandler(dev).then((handler) => {
      nextHandlerRef.handler = handler;
    });
  }

  return {
    httpServer,
    io,
    hub,
    repo,
    ai,
    async close() {
      hub.shutdown();
      await ws.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      const owned = repo as Partial<{ disconnect: () => Promise<void> }>;
      if (typeof owned.disconnect === "function") await owned.disconnect();
    },
  };
}

/** SIGINT/SIGTERM → close io + http server, disconnect prisma, exit. */
export function attachShutdown(server: CardCraftersServer): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[card-crafters] ${signal} received — shutting down`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[card-crafters] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Main entry (only when run directly: `npx tsx apps/web/server.ts`)
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const server = await createServer();
  attachShutdown(server);
  server.httpServer.listen(PORT, () => {
    console.log(`[card-crafters] listening on :${PORT} (http + socket.io)`);
  });
}
