/**
 * Minimal scaffold bootstrap (Step 0 ONLY — no game logic).
 *
 * Currently serves:
 *   GET /api/health -> 200 {"ok":true,"service":"card-crafters"}
 *   anything else   -> 404 JSON
 *
 * TODO(Step 3): replace this with the real custom server that wires up:
 *   - a Next.js request handler via `next({ dev: false })`
 *   - Socket.IO for real-time team communication
 *   - BullMQ workers (image generation pipeline) + ioredis
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/api/health" || url.startsWith("/api/health?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "card-crafters" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[card-crafters] scaffold server listening on :${PORT}`);
});