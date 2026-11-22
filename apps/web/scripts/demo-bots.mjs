#!/usr/bin/env node
/**
 * Demo bots — simulated automated players driving a REAL server over real
 * WebSockets. Use it to stage a full game (or load-test one) without humans:
 *
 *   node apps/web/scripts/demo-bots.mjs                                    # create a 2-team game, 3 bots/team
 *   node apps/web/scripts/demo-bots.mjs --team-count 4 --players-per-team 5
 *   node apps/web/scripts/demo-bots.mjs --code ABC123                      # join an EXISTING game (join links)
 *   node apps/web/scripts/demo-bots.mjs --url http://localhost:3210 --no-gm-drive
 *   node apps/web/scripts/demo-bots.mjs --step-timeout-ms 600000           # raise per-step deadline
 *
 * Full path exercised: game creation (POST /api/games, theme required) →
 * players join via `join` {role:"player", joinToken, nickname} (the ONLY way
 * a player becomes active — join is legal in LOBBY/GREETINGS only, so bots
 * must join before gm:approveGreetings) → BUILD: player:submitPrompt per bot
 * (5s per-player cooldown honored via the `cooldown` ack's remainingMs;
 * `card_full` at 25 stops that bot; `too_many_inflight` retries) → GM drive:
 * gm:approveGreetings → wait item:ready targets → gm:stopBuild → SCORING →
 * every bot rates every non-own card via score:submit → gm:stopScoring →
 * JUDGING → judging:winner (first team) → REVEAL → reveal:ack → RESULTS.
 *
 * Mock vs live AI: against a MOCK-mode server the whole run is deterministic
 * and free. Against a LIVE server the bots spend REAL AI money on every
 * greeting / sticker / montage — keep the bot count small.
 *
 * Exit 0 + summary when the game reaches RESULTS; exit 1 on any ack failure
 * or deadline miss (per-step deadline: --step-timeout-ms, default AUTO =
 * max(120s, 0.3s × expected players) for fresh games / 120s for --code runs;
 * 300s overall).
 *
 * Why the step deadline scales: with many players against a LIVE AI server a
 * single step (e.g. "waiting for items READY") can legitimately take many
 * minutes — every generation may hit OpenRouter backoffs (Retry-After waits up
 * to 120s each). The default auto-scales as 3000ms × (teams × players/team),
 * keeping the 120s floor for small games; pass --step-timeout-ms to override.
 */
import { io } from "socket.io-client";

// ---------------------------------------------------------------------------
// CLI flags (defaults in brackets)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  return v;
}
function flagBool(name, fallback) {
  if (argv.includes(`--${name}`)) return true;
  if (argv.includes(`--no-${name}`)) return false;
  return fallback;
}

const OPTS = {
  url: flagValue("url", "http://localhost:3000"),
  teamCount: Number(flagValue("team-count", 2)),
  code: argv.includes("--code") ? flagValue("code", "") : null,
  theme: flagValue("theme", "Demo bots theme"), // informational when --code is given
  playersPerTeam: Number(flagValue("players-per-team", 3)),
  promptsPerBot: Number(flagValue("prompts-per-bot", 2)),
  staggerMs: Number(flagValue("stagger-ms", 300)),
  submitGapMs: Number(flagValue("submit-gap-ms", 5200)),
  // "auto" = scale with expected players (see STEP_TIMEOUT_MS below).
  stepTimeoutMs: flagValue("step-timeout-ms", "auto"),
  rate: flagBool("rate", true),
  // GM drive defaults ON for a fresh game (the bots own the whole flow) and
  // OFF when joining an existing one (a human GM is driving).
  gmDrive: flagBool("gm-drive", !argv.includes("--code")),
};

// Fail fast on impossible configurations: the sticker cap is 25 items per
// card, and the server enforces a 5000ms per-player submit cooldown (a gap
// at or under it would burn the whole run on cooldown retries).
if (OPTS.playersPerTeam * OPTS.promptsPerBot > 25) {
  fail(`players-per-team × prompts-per-bot = ${OPTS.playersPerTeam * OPTS.promptsPerBot} > 25 (sticker cap)`);
}
if (OPTS.submitGapMs <= 5000) {
  fail(`--submit-gap-ms must be > 5000 (server cooldown is 5s per player), got ${OPTS.submitGapMs}`);
}

// ---------------------------------------------------------------------------
// Deadlines + diagnostics
// ---------------------------------------------------------------------------
// Per-step deadline: 120s floor for small games; for fresh games it auto-
// scales as 3000ms × expected players (teams × players/team → a 10×10 game
// gets 300s) because big live-AI games spend minutes per step on AI backoffs.
// Joining an existing game (--code) keeps the 120s default — the size is only
// known after joining — unless --step-timeout-ms is passed explicitly.
const STEP_TIMEOUT_MS =
  OPTS.stepTimeoutMs === "auto"
    ? OPTS.code
      ? 120_000
      : Math.max(120_000, 3000 * (OPTS.teamCount * OPTS.playersPerTeam))
    : Number(OPTS.stepTimeoutMs);
const OVERALL_TIMEOUT_MS = 300_000;
const SUBMIT_MAX_RETRIES = 12;

const URL = OPTS.url;
const startedAt = Date.now();
const diagnostics = [];
const itemsReady = []; // deduped item:ready payloads (GM socket sees each team room twice)
const itemFailed = [];
const summaries = {
  teams: 0,
  players: 0,
  stickers: 0, // accepted player:submitPrompt acks
  ratings: 0, // accepted score:submit acks
  standings: null,
};

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  diagnostics.push(`${((Date.now() - startedAt) / 1000).toFixed(1)}s ${line}`);
  console.log(...args);
}

function deadlineLeft() {
  return OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
}

function stepLeft(stepStart, what) {
  const left = STEP_TIMEOUT_MS - (Date.now() - stepStart);
  if (left <= 0) fail(`step deadline (${STEP_TIMEOUT_MS / 1000}s) hit while: ${what}`);
  return left;
}

function fail(message) {
  console.error(`BOTS FAIL: ${message}`);
  console.error("--- diagnostics ---");
  for (const line of diagnostics) console.error(line);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast (before ANY connection) on a non-numeric / non-positive timeout.
if (!Number.isFinite(STEP_TIMEOUT_MS) || STEP_TIMEOUT_MS <= 0) {
  fail(`--step-timeout-ms must be a positive number of milliseconds, got "${OPTS.stepTimeoutMs}"`);
}

// ---------------------------------------------------------------------------
// Socket helpers (copied from scripts/smoke-build.mjs)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Prompt pool — ~16 concrete, drawable subjects. Deliberately avoids the mock
// moderation blocklist (no abstract "joy"/"love"/"happiness"/"festive
// feeling" prompts — "gold retirement watch", "red balloons", "beach sunset"
// are safe).
// ---------------------------------------------------------------------------
const PROMPT_POOL = [
  "gold retirement watch",
  "red balloons",
  "beach sunset",
  "tabby cat in a cardboard box",
  "stack of blueberry pancakes",
  "violet jellyfish",
  "wooden sailboat on waves",
  "chess knight on a board",
  "hot air balloon over green hills",
  "vinyl record player",
  "sunflower in a clay pot",
  "robot made of tin cans",
  "pineapple wearing sunglasses",
  "snowy mountain cabin",
  "espresso machine pouring coffee",
  "frog on a lily pad",
];

/** Deterministic per-bot prompt pick (bot index + attempt, pool-cycled). */
function promptFor(botIndex, attempt) {
  return PROMPT_POOL[(botIndex * 7 + attempt * 3) % PROMPT_POOL.length];
}

/**
 * Submit one prompt, honoring the server's cooldown / in-flight caps:
 *   - ack code "cooldown"          → sleep remainingMs + 200, retry
 *   - ack code "too_many_inflight" → sleep 500, retry
 *   - ack code "card_full"         → the team card hit 25 stickers: stop
 *                                    THIS bot (its remaining prompts are
 *                                    dropped), never fatal for the run.
 * Everything else is fatal (validation / moderation / phase problems).
 */
async function submitPrompt(sock, bot, text) {
  for (let attempt = 1; attempt <= SUBMIT_MAX_RETRIES; attempt++) {
    if (deadlineLeft() <= 2_000) fail(`overall deadline hit while bot ${bot.index} submitted "${text}"`);
    const ack = await emitAck(sock, "player:submitPrompt", { text });
    if (ack.ok) {
      summaries.stickers++;
      log(`bot ${bot.index} accepted "${text}" (itemId=${ack.itemId}, attempt ${attempt})`);
      return;
    }
    if (ack.code === "cooldown") {
      const wait = (ack.remainingMs ?? 5_000) + 200;
      log(`bot ${bot.index} cooldown for "${text}" — sleeping ${wait}ms (attempt ${attempt})`);
      await sleep(wait);
      continue;
    }
    if (ack.code === "too_many_inflight") {
      log(`bot ${bot.index} too_many_inflight for "${text}" — sleeping 500ms (attempt ${attempt})`);
      await sleep(500);
      continue;
    }
    if (ack.code === "card_full") {
      log(`bot ${bot.index} card_full — team card hit ${ack.maxItems ?? 25} stickers, stopping this bot`);
      bot.stopped = true;
      return;
    }
    throw new Error(`bot ${bot.index} submit "${text}" rejected: ${JSON.stringify(ack)}`);
  }
  throw new Error(`bot ${bot.index} submit "${text}" exhausted ${SUBMIT_MAX_RETRIES} retries`);
}

/** One rating. Transient/expected guards are skipped or stop the rater. */
async function submitScore(sock, bot, cardId, score) {
  const ack = await emitAck(sock, "score:submit", { cardId, score });
  if (ack.ok) {
    summaries.ratings++;
    return "ok";
  }
  const code = ack.reason ?? ack.code;
  if (code === "already_rated") return "duplicate"; // race with ourselves — skip
  if (code === "own_card") return "own"; // should never happen (we skip own)
  if (code === "locked" || code === "phase") {
    log(`bot ${bot.index} scoring closed (${code}) — stopping ratings`);
    bot.stopped = true;
    return "closed";
  }
  throw new Error(`bot ${bot.index} score:submit ${cardId}=${score} failed: ${JSON.stringify(ack)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`demo bots → ${URL} (teams=${OPTS.teamCount}, players/team=${OPTS.playersPerTeam}, prompts/bot=${OPTS.promptsPerBot}, gmDrive=${OPTS.gmDrive}, rate=${OPTS.rate}, stepTimeout=${STEP_TIMEOUT_MS / 1000}s)`);

  // 1) Game: create (POST /api/games → 201 with ALL joinTokens; greetings are
  //    auto-generated fire-and-forget) or join an existing one
  //    (GET /api/games/:code?full=1 exposes teams[].joinToken).
  let code;
  let teams;
  let phase;
  if (OPTS.code) {
    const res = await fetch(`${URL}/api/games/${OPTS.code}?full=1`);
    if (res.status !== 200) fail(`GET /api/games/${OPTS.code} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const game = await res_json(res);
    code = game.code;
    teams = game.teams;
    phase = game.phase;
    log(`joining game ${code} (phase=${phase}, ${teams.length} teams, theme=${JSON.stringify(game.theme)})`);
    log(`watch:  ${URL}/gm?code=${code}      <- GM console`);
    log(`watch:  ${URL}/present/${code}   <- presenter big screen`);
    if (OPTS.teamCount !== 2) log(`note: --team-count ignored when --code is given (game has ${teams.length} teams)`);
    if (!["LOBBY", "GREETINGS"].includes(phase)) {
      fail(`game ${code} is in phase ${phase} — players can only join during LOBBY/GREETINGS`);
    }
  } else {
    const res = await fetch(`${URL}/api/games`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamCount: OPTS.teamCount, theme: OPTS.theme }),
    });
    if (res.status !== 201) fail(`POST /api/games → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const game = await res_json(res);
    code = game.code;
    teams = game.teams;
    phase = game.phase;
    log(`game ${code} created (phase=${phase}, ${teams.length} teams)`);
    log(`watch:  ${URL}/gm?code=${code}      <- GM console`);
    log(`watch:  ${URL}/present/${code}   <- presenter big screen`);
  }
  summaries.teams = teams.length;
  const firstTeamId = teams[0].id;
  const targetItems = teams.length * OPTS.playersPerTeam * OPTS.promptsPerBot;

  // 2) GM socket (drive mode): joins the gm room + every team room, so
  //    item:ready arrives once per room — dedupe by itemId.
  let gm = null;
  if (OPTS.gmDrive) {
    gm = mkSocket({ role: "gm", gameCode: code });
    gm.connect();
    await waitConnect(gm, "gm");
    const gmJoin = await emitAck(gm, "join", { role: "gm", joinToken: code });
    if (!gmJoin.ok) fail(`gm join rejected: ${JSON.stringify(gmJoin)}`);
    gm.on("phaseChanged", (p) => log(`PHASE → ${p.phase}`));
    gm.on("item:pending", (p) => log(`item:pending ${p.itemId} "${p.promptRaw}" (${p.nickname})`));
    gm.on("item:failed", (p) => {
      itemFailed.push(p);
      log(`item:failed ${p.itemId}: ${p.reason}`);
    });
    gm.on("item:ready", (p) => {
      // The GM socket sits in BOTH the gm room and the team room, so room-
      // targeted events arrive twice — dedupe by itemId.
      if (itemsReady.some((r) => r.itemId === p.itemId)) return;
      itemsReady.push(p);
      log(`item:ready ${itemsReady.length}/${targetItems} ${p.itemId}`);
    });
  }

  // 3) Players join via the join event (LOBBY/GREETINGS only — before
  //    approveGreetings), staggered to mimic humans trickling in.
  const bots = [];
  let botIndex = 0;
  for (const team of teams) {
    for (let i = 1; i <= OPTS.playersPerTeam; i++) {
      const sock = mkSocket({ role: "player" });
      const bot = {
        index: botIndex++,
        teamLabel: team.label,
        nickname: `Bot ${team.label}${i}`,
        sock,
        scoring: null, // {cards, yourTeamCardId} once scoring:started lands
        rated: new Set(),
        stopped: false,
      };
      sock.on("scoring:started", (p) => {
        bot.scoring = p;
        log(`bot ${bot.index} saw scoring:started (${p.cards.length} cards, own=${p.yourTeamCardId})`);
      });
      sock.connect();
      await waitConnect(sock, bot.nickname);
      const ack = await emitAck(sock, "join", {
        role: "player",
        joinToken: team.joinToken,
        nickname: bot.nickname,
      });
      if (!ack.ok) fail(`player ${bot.nickname} join rejected: ${JSON.stringify(ack)}`);
      bots.push(bot);
      summaries.players++;
      log(`${bot.nickname} joined team ${team.label}`);
      if (OPTS.staggerMs > 0) await sleep(OPTS.staggerMs);
      if (deadlineLeft() <= 5_000) fail("overall deadline hit while joining players");
    }
  }

  // 4) GM approves greetings (GREETINGS → BUILD). Bots must already be in —
  //    join is rejected once the game is underway.
  if (OPTS.gmDrive) {
    const approve = await emitAck(gm, "gm:approveGreetings", {});
    if (!approve.ok || approve.phase !== "BUILD") fail(`approveGreetings failed: ${JSON.stringify(approve)}`);
    log("greetings approved → BUILD");
  }

  // 4b) No GM drive: the game may still be in LOBBY/GREETINGS (no theme set,
  //     greetings not approved). Prompts are rejected with `before_theme` /
  //     phase guards until BUILD, so poll the game phase and wait for the
  //     human GM to set the theme + approve greetings on the GM console.
  if (!OPTS.gmDrive) {
    let phaseNow = (await (await fetch(`${URL}/api/games/${code}`)).json()).phase;
    if (phaseNow !== "BUILD") {
      log(`game is in ${phaseNow} — waiting for BUILD (set the theme and approve greetings on the GM console: ${URL}/gm?code=${code})`);
      const waitStart = Date.now();
      while (phaseNow !== "BUILD") {
        if (deadlineLeft() <= 5_000) fail("overall deadline hit waiting for BUILD phase");
        if (Date.now() - waitStart > 120_000) fail(`game still in ${phaseNow} after 120s — start the build on the GM console first`);
        await sleep(2000);
        phaseNow = (await (await fetch(`${URL}/api/games/${code}`)).json()).phase;
      }
      log("BUILD started — bots submitting");
    }
  }

  // 5) BUILD: every bot submits its prompts. Cooldown is PER PLAYER, so bots
  //    run in parallel; each bot spaces its own prompts by --submit-gap-ms.
  const buildStart = Date.now();
  await Promise.all(
    bots.map(async (bot) => {
      for (let k = 0; k < OPTS.promptsPerBot; k++) {
        if (bot.stopped) return;
        if (k > 0) await sleep(OPTS.submitGapMs);
        await submitPrompt(bot.sock, bot, promptFor(bot.index, k));
        if (bot.stopped) return; // card_full inside submitPrompt
      }
    }),
  );
  log(`build submissions done in ${((Date.now() - buildStart) / 1000).toFixed(1)}s (${summaries.stickers}/${targetItems} accepted)`);

  // 6) Wait for every team's stickers to come out READY (mock mode finishes
  //    all of them; a real provider needs real time here).
  const itemsStart = Date.now();
  while (itemsReady.length < targetItems) {
    stepLeft(itemsStart, "waiting for item:ready targets");
    if (itemFailed.length > 0 && itemsReady.length + itemFailed.length >= targetItems) {
      fail(`${itemFailed.length} item(s) FAILED — targets can never be met`);
    }
    await sleep(250);
  }
  log(`all ${itemsReady.length} items READY`);

  // 7) → SCORING. Drive mode ends BUILD early; otherwise the bots wait for
  //    whoever is driving the real GM console.
  if (OPTS.gmDrive) {
    const stop = await emitAck(gm, "gm:stopBuild", {});
    if (!stop.ok || stop.phase !== "SCORING") fail(`gm:stopBuild failed: ${JSON.stringify(stop)}`);
  }
  if (OPTS.rate) {
    log("PHASE → SCORING");
    const scoringStart = Date.now();
    while (bots.some((b) => !b.scoring)) {
      stepLeft(scoringStart, "waiting for scoring:started broadcasts");
      await sleep(250);
    }

    // 8) Every bot rates every NON-OWN card with a deterministic score
    //    (position in its shuffled scoring copy). cardIndex ≠ team order —
    //    the scoring order is Fisher–Yates shuffled per game:round, so read
    //    the positions off the payload, never assume them.
    const rateStart = Date.now();
    await Promise.all(
      bots.map(async (bot) => {
        const cards = bot.scoring.cards.filter((c) => c.cardId !== bot.scoring.yourTeamCardId);
        for (const [index, card] of cards.entries()) {
          if (bot.stopped) return;
          const score = (index % 10) + 1; // deterministic 1..10
          const outcome = await submitScore(bot.sock, bot, card.cardId, score);
          if (outcome === "closed") return;
        }
      }),
    );
    log(`ratings done in ${((Date.now() - rateStart) / 1000).toFixed(1)}s (${summaries.ratings} submitted)`);
  }

  // 9) JUDGING → REVEAL → RESULTS (drive mode only; otherwise the human GM
  //    finishes the game and the bots' work is already done).
  if (OPTS.gmDrive) {
    const stopScoring = await emitAck(gm, "gm:stopScoring", {});
    if (!stopScoring.ok || stopScoring.phase !== "JUDGING") {
      fail(`gm:stopScoring failed: ${JSON.stringify(stopScoring)}`);
    }
    log("PHASE → JUDGING");

    const winnerPromise = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("winnerAnnounced timeout")), STEP_TIMEOUT_MS);
      gm.once("winnerAnnounced", (p) => {
        clearTimeout(t);
        res(p);
      });
    });
    const pick = await emitAck(gm, "judging:winner", { teamId: firstTeamId });
    if (!pick.ok || pick.phase !== "REVEAL") fail(`judging:winner failed: ${JSON.stringify(pick)}`);
    log("PHASE → REVEAL");

    const announced = await winnerPromise;
    summaries.standings = announced.standings ?? null;
    log(`winner team ${announced.winnerTeamId} (peoples choice: ${announced.peoplesChoiceTeamId ?? "n/a"})`);

    const reveal = await emitAck(gm, "reveal:ack", {});
    if (!reveal.ok || reveal.phase !== "RESULTS") fail(`reveal:ack failed: ${JSON.stringify(reveal)}`);
    log("PHASE → RESULTS");
  }

  // 10) Tear down + summary.
  if (gm) gm.close();
  for (const bot of bots) bot.sock.close();

  console.log("\n=== DEMO BOTS SUMMARY ===");
  console.log(`game:            ${code}`);
  console.log(`teams:           ${summaries.teams}`);
  console.log(`players:         ${summaries.players}`);
  console.log(`stickers:        ${summaries.stickers} accepted, ${itemsReady.length} ready, ${itemFailed.length} failed`);
  console.log(`ratings:         ${summaries.ratings}`);
  if (summaries.standings) {
    console.log("final standings (avg desc):");
    for (const [i, s] of summaries.standings.entries()) {
      console.log(`  ${i + 1}. team ${s.label} — avg ${s.avg} (${s.count} ratings)`);
    }
  }
  console.log(`BOTS PASS: done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
