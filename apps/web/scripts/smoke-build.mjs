/**
 * Build-phase smoke test (run against a LIVE server, e.g. after
 * `PORT=3210 npx tsx apps/web/server.ts`):
 *
 *   node apps/web/scripts/smoke-build.mjs
 *
 * Full path exercised: game creation (theme required) → GM join +
 * gm:approveGreetings → players join during GREETINGS → sequential
 * player:submitPrompt (server enforces a 5000ms per-player cooldown) →
 * item:pending → item:ready (real image written to public/static/items) →
 * layout:updated (debounced re-layout, versioned).
 *
 * Exit 0 + "SMOKE PASS: ..." when all items are READY and the card re-laid
 * out; prints collected diagnostics and exits 1 otherwise.
 */
import { io } from "socket.io-client";

const URL = process.env.SMOKE_URL ?? "http://localhost:3210";
const OVERALL_TIMEOUT_MS = 30_000;
const SUBMIT_MAX_RETRIES = 12;

const startedAt = Date.now();
const diagnostics = [];
const itemsReady = [];
const layoutEvents = [];

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  diagnostics.push(`${((Date.now() - startedAt) / 1000).toFixed(1)}s ${line}`);
  console.log(...args);
}

function deadlineLeft() {
  return OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
}

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  console.error("--- diagnostics ---");
  for (const line of diagnostics) console.error(line);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkSocket(auth) {
  return io(URL, { path: "/socket.io", transports: ["websocket"], autoConnect: false, auth });
}

function waitConnect(sock, name) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8_000);
    sock.once("connect", () => {
      clearTimeout(timer);
      res();
    });
    sock.once("connect_error", (e) => {
      clearTimeout(timer);
      rej(new Error(`${name}: ${e.message}`));
    });
  });
}

function emitAck(sock, event, payload) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${event} ack timeout`)), 8_000);
    sock.emit(event, payload, (r) => {
      clearTimeout(t);
      res(r);
    });
  });
}

async function res_json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Submit one prompt, honoring the server's cooldown / in-flight caps:
 *   - ack code "cooldown"          → sleep remainingMs + 200, retry
 *   - ack code "too_many_inflight" → sleep 500, retry
 * Everything else is fatal (validation / moderation / phase problems).
 */
async function submitPrompt(sock, text) {
  for (let attempt = 1; attempt <= SUBMIT_MAX_RETRIES; attempt++) {
    if (deadlineLeft() <= 2_000) fail(`deadline hit while submitting "${text}"`);
    const ack = await emitAck(sock, "player:submitPrompt", { text });
    if (ack.ok) {
      log(`accepted "${text}" (itemId=${ack.itemId}, attempt ${attempt})`);
      return ack;
    }
    if (ack.code === "cooldown") {
      const wait = (ack.remainingMs ?? 5_000) + 200;
      log(`cooldown for "${text}" — sleeping ${wait}ms (attempt ${attempt})`);
      await sleep(wait);
      continue;
    }
    if (ack.code === "too_many_inflight") {
      log(`too_many_inflight for "${text}" — sleeping 500ms (attempt ${attempt})`);
      await sleep(500);
      continue;
    }
    throw new Error(`submit "${text}" rejected: ${JSON.stringify(ack)}`);
  }
  throw new Error(`submit "${text}" exhausted ${SUBMIT_MAX_RETRIES} retries`);
}

async function main() {
  // 1) Create the game (theme is REQUIRED by POST /api/games → phase GREETINGS).
  const res = await fetch(`${URL}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamCount: 2, theme: "Smoke theme" }),
  });
  if (res.status !== 201) fail(`POST /api/games → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const game = await res_json(res);
  const teamToken = game.teams[0].joinToken;
  log(`game ${game.code} created (phase=${game.phase})`);

  // 2) GM: connect + join + approve greetings (GREETINGS → BUILD).
  const gm = mkSocket({ role: "gm", gameCode: game.code });
  gm.connect();
  await waitConnect(gm, "gm");
  const gmJoin = await emitAck(gm, "join", { role: "gm", joinToken: game.code });
  if (!gmJoin.ok) fail(`gm join rejected: ${JSON.stringify(gmJoin)}`);

  // Collect the outcome events on the GM socket (GM sits in every team room +
  // the gm room, so item:ready and layout:updated both arrive here).
  gm.on("item:pending", (p) => log(`item:pending ${p.itemId} "${p.promptRaw}" (${p.nickname})`));
  gm.on("item:failed", (p) => log(`item:failed ${p.itemId}: ${p.reason}`));
  gm.on("item:ready", (p) => {
    // The GM socket sits in BOTH the gm room and the team room, so room-
    // targeted events arrive twice — dedupe by itemId.
    if (itemsReady.some((r) => r.itemId === p.itemId)) return;
    itemsReady.push(p);
    log(`item:ready ${p.itemId} → ${p.imageUrl}`);
  });
  gm.on("layout:updated", (p) => {
    // Same double-delivery as above — dedupe by version.
    if (layoutEvents.some((e) => e.version === p.version)) return;
    layoutEvents.push(p);
    log(`layout:updated team=${p.teamId} v${p.version} (${p.placements?.length ?? 0} placements)`);
  });

  // 2) Players join team 0 during GREETINGS (join is rejected after approval).
  const players = [];
  for (const nickname of ["Smoke1", "Smoke2"]) {
    const sock = mkSocket({ role: "player" });
    sock.connect();
    await waitConnect(sock, nickname);
    const ack = await emitAck(sock, "join", { role: "player", joinToken: teamToken, nickname });
    if (!ack.ok) fail(`player ${nickname} join rejected: ${JSON.stringify(ack)}`);
    players.push(sock);
    log(`${nickname} joined`);
  }

  // 3) GM approves greetings (GREETINGS → BUILD).
  const approve = await emitAck(gm, "gm:approveGreetings", {});
  if (!approve.ok || approve.phase !== "BUILD") fail(`approveGreetings failed: ${JSON.stringify(approve)}`);
  log("greetings approved → BUILD");

  // 4) Wait until each player's snapshot shows phase BUILD.
  for (const [i, sock] of players.entries()) {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (deadlineLeft() <= 5_000) fail(`deadline hit waiting for player ${i} BUILD phase`);
      // Register the sync:full listener BEFORE the resync: the server emits
      // sync:full before acking, so listening afterwards would miss it.
      const sync = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("sync:full timeout")), 5_000);
        sock.once("sync:full", (s) => {
          clearTimeout(t);
          res(s);
        });
        void emitAck(sock, "sync:resync").catch(rej);
      });
      if (sync.phase === "BUILD") {
        log(`player ${i} sees phase BUILD`);
        break;
      }
      await sleep(300);
      if (attempt === 10) fail(`player ${i} never saw BUILD (last phase=${sync.phase})`);
    }
  }

  // 5) Submit: P1 three prompts SEQUENTIALLY (cooldown 5000ms server-side),
  //    then P2 one.
  const prompts = [
    { sock: players[0], text: "red balloon" },
    { sock: players[0], text: "golden retriever party hat" },
    { sock: players[0], text: "watercolour pink peonies" },
    { sock: players[1], text: "tiny red vintage bicycle" },
  ];
  for (const { sock, text } of prompts) await submitPrompt(sock, text);
  log("all prompts accepted — waiting for item:ready / layout:updated");

  // 6) Wait for 4 items READY (mock provider draws a real PNG + writes the
  //    file, so this takes a moment after the last accept).
  while (itemsReady.length < 4) {
    if (deadlineLeft() <= 0) {
      fail(`only ${itemsReady.length}/4 items READY within ${OVERALL_TIMEOUT_MS / 1000}s`);
    }
    await sleep(200);
  }

  // 7) Assertions.
  const badImage = itemsReady.find((p) => !String(p.imageUrl).startsWith("/static/items/"));
  if (badImage) fail(`item:ready imageUrl malformed: ${JSON.stringify(badImage)}`);
  if (layoutEvents.length < 2) {
    fail(`expected >=2 layout:updated events, got ${layoutEvents.length}`);
  }
  const versions = layoutEvents.map((e) => e.version);
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] <= versions[i - 1]) {
      fail(`layout versions not increasing: ${versions.join(", ")}`);
    }
  }

  gm.close();
  for (const p of players) p.close();

  const maxVersion = Math.max(...versions);
  console.log(`SMOKE PASS: ${itemsReady.length} items ready, layout v${maxVersion}`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));