/**
 * Tiny JSON API router (no express) — dev/GM conveniences handled by the raw
 * http server BEFORE the Next.js handler (see apps/web/server.ts).
 *
 * Routes:
 *   POST /api/games          create a game → 201 { gameId, code, teams[], gmUrl, presenterUrl }
 *   GET  /api/games/:code    game summary → { phase, round, theme, teams[] }
 *                            (joinToken per team only with ?full=1 — GM/QR use)
 *
 * NOTE: gmUrl embeds the game code (/gm?code=…). GM auth IS "knowing the
 * code" for this party game (documented in ws/auth.ts) — anyone with the URL
 * can control the game. Deliberate scope trade-off, not a security boundary.
 */

import type { CardConfig } from "@cardcrafters/shared";
import { DEFAULT_CARD_CONFIG, MAX_TEAMS } from "@cardcrafters/shared";

import type { GameHub } from "../game/hub";
import type { Repository } from "../repo/repository";

/** Options for creating a game via POST /api/games. */
interface CreateGameBody {
  teamCount?: unknown;
  config?: unknown;
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
  const pl = (p.limits ?? {}) as Partial<CardConfig["limits"]>;
  return {
    cardRatioW: num(p.cardRatioW) ?? base.cardRatioW,
    cardRatioH: num(p.cardRatioH) ?? base.cardRatioH,
    ...(num(p.buildTimerSeconds) !== undefined ? { buildTimerSeconds: num(p.buildTimerSeconds) } : {}),
    ...(num(p.scoringTimerSeconds) !== undefined
      ? { scoringTimerSeconds: num(p.scoringTimerSeconds) }
      : {}),
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
 * Handle an API request. Returns true when the request was consumed (matched
 * an /api/games route); false lets the caller fall through (health/Next).
 */
export async function handleApiRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  hub: GameHub,
  repo: Repository,
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
    let teamCount = 5;
    if (body.teamCount !== undefined) {
      const n = Number(body.teamCount);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TEAMS) {
        sendJson(res, 400, { ok: false, error: `teamCount must be an integer 1..${MAX_TEAMS}` });
        return true;
      }
      teamCount = n;
    }
    try {
      const setup = await hub.createGame(mergeCardConfig(body.config), { teamCount });
      const code = setup.game.code;
      sendJson(res, 201, {
        ok: true,
        gameId: setup.game.id,
        code,
        teams: setup.teams.map((t) => ({ id: t.id, name: t.name, label: t.label, joinToken: t.joinToken })),
        // The GM URL embeds the code — the code IS the GM credential here.
        gmUrl: `/gm?code=${code}`,
        presenterUrl: `/present/${code}`,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : "create failed" });
    }
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
    const teamSummaries = [];
    for (const team of teams) {
      const playerCount = await repo.countTeamMembers(team.id);
      teamSummaries.push({
        id: team.id,
        name: team.name,
        label: team.label,
        playerCount,
        // Join tokens are only exposed with ?full=1 (the GM console's QR view).
        ...(full ? { joinToken: team.joinToken } : {}),
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