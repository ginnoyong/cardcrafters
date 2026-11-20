/**
 * Tiny JSON API router (no express) — dev/GM conveniences handled by the raw
 * http server BEFORE the Next.js handler (see apps/web/server.ts).
 *
 * Routes:
 *   POST /api/games          create a game (+ required theme) → 201 with phase
 *                            "GREETINGS"; greeting generation runs in the
 *                            background and each finished greeting is broadcast
 *                            as `greeting:updated` to gm+team rooms (await via
 *                            flows.waitForGreetings if you must synchronize)
 *   GET  /api/games/:code    game summary → { phase, round, theme, teams[] }
 *                            (joinToken per team + per-team greeting only
 *                            with ?full=1 — GM/QR use)
 *
 * NOTE: gmUrl embeds the game code (/gm?code=…). GM auth IS "knowing the
 * code" for this party game (documented in ws/auth.ts) — anyone with the URL
 * can control the game. Deliberate scope trade-off, not a security boundary.
 */

import type { CardConfig } from "@cardcrafters/shared";
import { DEFAULT_CARD_CONFIG, MAX_TEAMS, MAX_TIMER_SECONDS } from "@cardcrafters/shared";
import archiver from "archiver";
import { readFile, stat } from "node:fs/promises";
import nodePath from "node:path";
import { z } from "zod";

import type { AiRouter } from "../ai/router";
import { DEFAULT_MONTAGE_DIR } from "../flows/montage-accumulator";
import { generateGreetingsForGame } from "../flows/greetings";
import type { GameHub, RoomEmitter } from "../game/hub";
import { deriveGradingFromStyle, renderCardPng, type RenderableItem } from "../render/card-render";
import type { Repository, GameRow } from "../repo/repository";
import { gmRoom, teamRoom } from "../ws/rooms";

/**
 * Body schema for POST /api/games — theme is REQUIRED (drives greetings).
 * Optional top-level timer overrides (seconds; 0 = untimed, GM stops manually)
 * are validated as non-negative ints and merged into CardConfig below. They
 * may also arrive inside the free-form `config` object (merged over defaults
 * by mergeCardConfig); the top-level fields win when both are present.
 */
const createGameSchema = z.object({
  teamCount: z.number().int().min(1).max(MAX_TEAMS).optional(),
  theme: z.string().trim().min(1).max(120),
  config: z.unknown().optional(),
  buildTimerSeconds: z.number().int().min(0).max(MAX_TIMER_SECONDS).optional(),
  scoringTimerSeconds: z.number().int().min(0).max(MAX_TIMER_SECONDS).optional(),
});

/** Options for creating a game via POST /api/games. */
interface CreateGameBody {
  teamCount?: unknown;
  config?: unknown;
  buildTimerSeconds?: unknown;
  scoringTimerSeconds?: unknown;
}

/** Read + JSON-parse a request body (rejects >1MB, malformed JSON). */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Deep-ish merge of a partial CardConfig over the defaults (limits merged too). */
export function mergeCardConfig(partial: unknown): CardConfig {
  const base = DEFAULT_CARD_CONFIG;
  if (!partial || typeof partial !== "object") {
    return { ...base, limits: { ...base.limits } };
  }
  const p = partial as Partial<CardConfig>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  // Phase timers: whole seconds ≥ 0 ONLY — 0 is meaningful (untimed), anything
  // else invalid falls back to the default rather than silently disarming.
  // Above MAX_TIMER_SECONDS (24 h) also falls back: a setTimeout delay beyond
  // 2^31−1 ms gets clamped by Node to ~1 ms, ending the phase instantly.
  const secs = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_TIMER_SECONDS
      ? v
      : undefined;
  const pl = (p.limits ?? {}) as Partial<CardConfig["limits"]>;
  return {
    cardRatioW: num(p.cardRatioW) ?? base.cardRatioW,
    cardRatioH: num(p.cardRatioH) ?? base.cardRatioH,
    // Absent/invalid timers fall back to the documented defaults (600s/300s);
    // an explicit 0 passes through as untimed.
    buildTimerSeconds: secs(p.buildTimerSeconds) ?? base.buildTimerSeconds,
    scoringTimerSeconds: secs(p.scoringTimerSeconds) ?? base.scoringTimerSeconds,
    limits: {
      cooldownMs: num(pl.cooldownMs) ?? base.limits.cooldownMs,
      maxInflightPerPlayer: num(pl.maxInflightPerPlayer) ?? base.limits.maxInflightPerPlayer,
      maxItemsPerCard: num(pl.maxItemsPerCard) ?? base.limits.maxItemsPerCard,
    },
    scoringVisibleOnPresenter:
      typeof p.scoringVisibleOnPresenter === "boolean" ? p.scoringVisibleOnPresenter : base.scoringVisibleOnPresenter,
    aiBudgetUsd: num(p.aiBudgetUsd) ?? base.aiBudgetUsd,
  };
}

/**
 * Gather one team's finished card (layout + READY items + greeting) and render
 * it as a PNG. Serves the scoring-card route (player rating preview /
 * presenter big screen). Renders the FINAL polished montage card (feathered
 * stickers + style-pack grading); the route is phase-gated at SCORING or
 * later, so the montage pass has already settled. The render itself is
 * fail-open about missing stickers, but a hard failure propagates to the
 * caller (routes turn it into a 500).
 */
async function renderTeamCardPng(
  repo: Repository,
  game: GameRow,
  teamId: string,
  opts: { runtimeRound?: number } = {},
): Promise<Buffer> {
  // Round-source alignment (step 2): the authoritative round is the HUB's
  // runtime state round (what `scoringOrder` and the phase gates are keyed
  // on), NOT the potentially stale persisted `game.round`. Callers pass the
  // runtime round when available; otherwise fall back to the persisted row.
  const round = opts.runtimeRound ?? game.round;
  const layout = await repo.getLayoutState(teamId, round);
  const items: RenderableItem[] = (await repo.listItems(teamId, round, ["READY"]))
    .filter((r) => (r.width ?? 0) > 0 && (r.height ?? 0) > 0)
    .map((r) => ({ itemId: r.id, imageUrl: r.imageUrl, width: r.width!, height: r.height! }));
  const greeting = (await repo.listGreetings(game.id, round)).find(
    (g) => g.teamId === teamId,
  );
  return renderCardPng(
    items,
    { placements: layout?.placements ?? [] },
    greeting?.text ?? "",
    {
      cardRatioW: game.config.cardRatioW,
      cardRatioH: game.config.cardRatioH,
      finalPass: true,
      grading: deriveGradingFromStyle(game.style, teamId),
    },
  );
}

/**
 * Handle an API request. Returns true when the request was consumed (matched
 * an /api/games route); false lets the caller fall through (health/Next).
 */
export async function handleApiRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  hub: GameHub,
  repo: Repository,
  ai?: AiRouter,
  io?: RoomEmitter,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // POST /api/games — create a game (GM console landing).
  if (req.method === "POST" && (path === "/api/games" || path === "/api/games/")) {
    let body: CreateGameBody = {};
    try {
      body = (await readJsonBody(req)) as CreateGameBody;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad body" });
      return true;
    }
    // teamCount: integer 1..MAX_TEAMS, default 5 (GM-convenience default).
    // theme: required, trimmed 1..120 chars (400 with a friendly message otherwise).
    const parsed = createGameSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "body";
      const friendly =
        field === "theme"
          ? "theme is required (1..120 characters)"
          : field === "buildTimerSeconds" || field === "scoringTimerSeconds"
            ? `${field} must be a whole number of seconds between 0 and ${MAX_TIMER_SECONDS} (0 = untimed)`
            : `invalid ${field}: ${issue?.message ?? "invalid payload"}`;
      sendJson(res, 400, { ok: false, error: friendly });
      return true;
    }
    const teamCount = parsed.data.teamCount ?? 5;
    const theme = parsed.data.theme;
    // Merge the free-form config with the validated top-level timer overrides
    // (top level wins) before normalizing over the defaults.
    const configInput = {
      ...((typeof parsed.data.config === "object" && parsed.data.config !== null
        ? parsed.data.config
        : {}) as Record<string, unknown>),
      ...(parsed.data.buildTimerSeconds !== undefined
        ? { buildTimerSeconds: parsed.data.buildTimerSeconds }
        : {}),
      ...(parsed.data.scoringTimerSeconds !== undefined
        ? { scoringTimerSeconds: parsed.data.scoringTimerSeconds }
        : {}),
    };
    try {
      const setup = await hub.createGame(mergeCardConfig(configInput), { teamCount });
      // Persist the theme immediately (LOBBY → GREETINGS) so the phase and
      // theme survive even before greeting generation finishes.
      await hub.applyEvent(setup.game.id, {
        type: "gm:setTheme",
        theme,
        now: Date.now(),
      });
      const code = setup.game.code;
      // Fire-and-forget generation (mock mode is ~instant). Each finished
      // greeting is broadcast as greeting:updated to gm + team rooms.
      if (ai) {
        void generateGreetingsForGame(hub, repo, ai, setup.game.id)
          .then((batch) => {
            if (!io) return;
            for (const greeting of batch.created) {
              const payload = {
                ...hub.stamp(setup.game.id),
                teamId: greeting.teamId,
                text: greeting.text,
                status: greeting.status,
              };
              io.to(gmRoom(setup.game.id)).emit("greeting:updated", payload);
              io.to(teamRoom(setup.game.id, greeting.teamId)).emit("greeting:updated", payload);
            }
          })
          .catch((err: unknown) =>
            console.error(`[api] greeting generation failed for ${setup.game.id}:`, err),
          );
      }
      sendJson(res, 201, {
        ok: true,
        gameId: setup.game.id,
        code,
        teams: setup.teams.map((t) => ({ id: t.id, name: t.name, label: t.label, joinToken: t.joinToken })),
        // The GM URL embeds the code — the code IS the GM credential here.
        gmUrl: `/gm?code=${code}`,
        presenterUrl: `/present/${code}`,
        phase: "GREETINGS",
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : "create failed" });
    }
    return true;
  }

  // GET /api/games/:code/scoring-card/:cardId?token=[&variant=poster] — one
  // scoring card's finished image. Two audiences:
  //  - a PLAYER rating it, authenticated by a valid session token (?token=…);
  //  - the PRESENTER big screen, TOKENLESS: the game code is the capability
  //    (same "knowing the code" trade-off as GM auth, documented at the top
  //    of this file) — the anonymous scoring stage needs the same images the
  //    players' tokens already serve, and the card→team mapping stays
  //    server-side either way.
  // When a token IS supplied it is validated exactly as before (403
  // invalid_token on any mismatch); a tokenless request skips the player
  // check but keeps every downstream guard. Only served during
  // SCORING/JUDGING (409 otherwise) and only for a cardId in the round's
  // scoring order (404 otherwise); cache-control: no-store keeps the phase
  // gate honest. variant=poster serves the team's AI montage poster when it
  // is READY (the poster-first scoring UI); anything else falls back to the
  // composed renderTeamCardPng render. All phase/round/cardId guards run
  // BEFORE the variant handling.
  const scoringCardMatch = /^\/api\/games\/([A-Za-z0-9]+)\/scoring-card\/([A-Za-z0-9-]+)$/.exec(
    path,
  );
  if (req.method === "GET" && scoringCardMatch) {
    const code = scoringCardMatch[1]!;
    const cardId = scoringCardMatch[2]!;
    const token = url.searchParams.get("token") ?? "";
    const game = await hub.gameByCode(code);
    if (!game) {
      sendJson(res, 404, { ok: false, error: "unknown_code", code });
      return true;
    }
    if (token !== "") {
      const player = await repo.getPlayerBySessionToken(token);
      if (!player || player.gameId !== game.id || player.removedAt !== null) {
        sendJson(res, 403, { ok: false, error: "invalid_token" });
        return true;
      }
    }
    // Tokenless (presenter) access: no player check — the game code in the
    // URL is the capability. Every guard below (phase gate, scoring-order
    // membership) still applies.
    const state = await hub.runtimeState(game.id);
    if (state.phase !== "SCORING" && state.phase !== "JUDGING") {
      sendJson(res, 409, { ok: false, error: "not_scoring", phase: state.phase });
      return true;
    }
    const order = game.scoringOrder;
    if (!order || order.round !== state.round || !order.cards.some((c) => c.cardId === cardId)) {
      sendJson(res, 404, { ok: false, error: "unknown_card", cardId });
      return true;
    }
    const card = order.cards.find((c) => c.cardId === cardId)!;
    // variant=poster (poster-first scoring UI): serve the team's AI montage
    // poster when the accumulator has persisted a READY row. The imageUrl
    // ("/static/montages/{gameId}/{teamId}/{file}") maps 1:1 onto the
    // montage storage root ({DEFAULT_MONTAGE_DIR}/{gameId}/{teamId}/{file}),
    // so the fs path is reconstructed by joining the round's gameId + the
    // card's teamId + the URL basename. Any miss (no row / not READY / no
    // imageUrl / file gone) falls through to the composed render.
    if (url.searchParams.get("variant") === "poster") {
      const montage = await repo.getMontageState(card.teamId, state.round);
      if (montage && montage.status === "READY" && montage.imageUrl) {
        try {
          const fsPath = nodePath.join(
            DEFAULT_MONTAGE_DIR,
            game.id,
            card.teamId,
            nodePath.basename(montage.imageUrl),
          );
          await stat(fsPath); // throws if the file is gone → composed fallback
          const ext = nodePath.extname(fsPath).toLowerCase();
          const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
          const image = await readFile(fsPath);
          res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
          res.end(image);
          return true;
        } catch {
          // Poster file unreadable — fall back to the composed render below.
        }
      }
    }
    let png: Buffer;
    try {
      png = await renderTeamCardPng(repo, game, card.teamId, { runtimeRound: state.round });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : "card render failed",
      });
      return true;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(png);
    return true;
  }

/**
 * Sanitize a team name into a filename fragment: lowercase, [a-z0-9] kept,
 * everything else (and runs of them) collapsed to single dashes. Bounded so
 * pathological names can't produce absurd headers.
 */
function sanitizeFileNamePart(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "team"
  );
}

// GET /api/games/:code/export/cards — ALL-cards zip export for the GM
// RESULTS screen. Auth follows the same code-as-capability model as the rest
// of the GM surface: the game code in the URL IS the credential (anyone who
// knows the code can already run the game), so no extra token — every
// downstream guard (phase gate) still applies. Phase-gated at RESULTS only
// (409 "not_exportable" otherwise) — the round is fully settled there, the
// winner exists and every card is final. For each team the zip carries the
// CURRENT RUNTIME round's READY montage poster file byte-for-byte (no
// re-encode; ext kept dynamic, jpg included) — any miss (no row / FALLBACK /
// no imageUrl / file gone) falls back to the composed renderTeamCardPng
// render (fail-open, same as the scoring-card poster branch) — plus the
// sticker card as the composed finalPass render. Every byte buffer is
// rendered BEFORE any response headers are written: a render failure turns
// into a clean 500 JSON instead of a half-flushed zip.
const exportMatch = /^\/api\/games\/([A-Za-z0-9]+)\/export\/cards$/.exec(path);
if (req.method === "GET" && exportMatch) {
  const code = exportMatch[1]!;
  const game = await hub.gameByCode(code);
  if (!game) {
    sendJson(res, 404, { ok: false, error: "unknown_code", code });
    return true;
  }
  const state = await hub.runtimeState(game.id);
  if (state.phase !== "RESULTS") {
    sendJson(res, 409, { ok: false, error: "not_exportable", phase: state.phase });
    return true;
  }
  const teams = await repo.listTeams(game.id);

  // Pre-render EVERYTHING before touching headers — all-or-nothing.
  const entries: { name: string; bytes: Buffer }[] = [];
  try {
    for (const team of teams) {
      const namePart = sanitizeFileNamePart(team.name);
      // Poster: READY montage file from disk when possible, composed fallback
      // otherwise (ext kept dynamic — poster files may be jpg).
      let posterBytes: Buffer | null = null;
      let posterExt = "png";
      const montage = await repo.getMontageState(team.id, state.round);
      if (montage && montage.status === "READY" && montage.imageUrl) {
        try {
          const fsPath = nodePath.join(
            DEFAULT_MONTAGE_DIR,
            game.id,
            team.id,
            nodePath.basename(montage.imageUrl),
          );
          await stat(fsPath); // throws if the file is gone → composed fallback
          const pathExt = nodePath.extname(fsPath).toLowerCase();
          posterExt = pathExt === ".jpg" || pathExt === ".jpeg" ? "jpg" : "png";
          posterBytes = await readFile(fsPath);
        } catch {
          // Poster file unreadable — fall back to the composed render below.
        }
      }
      if (!posterBytes) {
        posterBytes = await renderTeamCardPng(repo, game, team.id, { runtimeRound: state.round });
        posterExt = "png";
      }
      // Sticker: same settings as the scoring-card composed render (finalPass
      // + grading, native width) — the sticker card as rendered for rating.
      const stickerBytes = await renderTeamCardPng(repo, game, team.id, {
        runtimeRound: state.round,
      });
      entries.push({ name: `${namePart}-poster.${posterExt}`, bytes: posterBytes });
      entries.push({ name: `${namePart}-card.png`, bytes: stickerBytes });
    }
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : "card export failed",
    });
    return true;
  }

  res.writeHead(200, {
    "content-type": "application/zip",
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="cardcrafters-cards-${code}.zip"`,
  });
  const archive = archiver("zip");
  archive.on("error", () => res.destroy());
  archive.pipe(res);
  for (const entry of entries) {
    archive.append(entry.bytes, { name: entry.name });
  }
  void archive.finalize();
  return true;
}

  // GET /api/games/:code — game summary (presenter/players/GM polling).
  const match = /^\/api\/games\/([A-Za-z0-9]+)$/.exec(path);
  if (req.method === "GET" && match) {
    const code = match[1]!;
    const game = await hub.gameByCode(code);
    if (!game) {
      sendJson(res, 404, { ok: false, error: "unknown_code", code });
      return true;
    }
    const teams = await repo.listTeams(game.id);
    const full = url.searchParams.get("full") === "1";
    // ?full=1 also includes each team's current-round greeting (GM view).
    const greetings = full
      ? new Map((await repo.listGreetings(game.id, game.round)).map((g) => [g.teamId, g]))
      : new Map<string, never>();
    const teamSummaries = [];
    for (const team of teams) {
      const playerCount = await repo.countTeamMembers(team.id);
      const greeting = full ? greetings.get(team.id) : undefined;
      teamSummaries.push({
        id: team.id,
        name: team.name,
        label: team.label,
        playerCount,
        // Join tokens are only exposed with ?full=1 (the GM console's QR view).
        ...(full ? { joinToken: team.joinToken } : {}),
        ...(full
          ? {
              greeting: {
                teamId: team.id,
                text: greeting?.text ?? "",
                status: greeting?.status ?? null,
              },
            }
          : {}),
      });
    }
    sendJson(res, 200, {
      ok: true,
      gameId: game.id,
      code: game.code,
      phase: game.phase,
      round: game.round,
      theme: game.theme,
      teams: teamSummaries,
    });
    return true;
  }

  return false;
}