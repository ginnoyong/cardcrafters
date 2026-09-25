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

import { GameHub } from "./src/server/game/hub";
import { hydrateTimers } from "./src/server/game/timer-service";
import { MemoryRepo } from "./src/server/repo/memory-repo";
import type { Repository } from "./src/server/repo/repository";
import { PrismaRepo } from "./src/server/repo/prisma-repo";
import { registerSocketHandlers } from "./src/server/ws/server";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/web

export interface CreateServerOptions {
  /** Repository override (tests inject a MemoryRepo). Defaults by env. */
  repo?: Repository;
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

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/health" || url.startsWith("/api/health?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "card-crafters" }));
      return;
    }
    // nextHandlerRef.handler is filled in asynchronously; until then (or when
    // Next is disabled/unavailable) non-health requests 404.
    const handler = nextHandlerRef.handler;
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error: "not_found", hint: "next handler not ready (or disabled)" }),
    );
  });

  const io = new SocketServer(httpServer, { path: "/socket.io" });
  const hub = new GameHub(repo, io);
  registerSocketHandlers(io, hub, repo);

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
    async close() {
      hub.shutdown();
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
