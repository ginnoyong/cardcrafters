/**
 * In-memory Repository — Map-based, used by tests and zero-infra mode.
 *
 * Deliberately enforces the SAME unique constraints as the Prisma schema
 * (game code, joinToken, sessionToken, [gameId,label], [gameId,nickname],
 * [teamId,round] greetings, [teamId,round,promptRaw,playerId] items,
 * [round,voterPlayerId,targetTeamId] scores, [gameId,round,role] winner picks)
 * so contract drift between this and PrismaRepo surfaces in tests.
 */

import { randomUUID } from "node:crypto";

import type { CardConfig, ItemStatus } from "@cardcrafters/shared";

import type {
  AiCallRow,
  AiCallSummary,
  AiTaskStats,
  CreateGameInput,
  CreateGreetingInput,
  CreateItemInput,
  CreatePlayerInput,
  CreateTeamInput,
  GamePatch,
  GameRow,
  GreetingPatch,
  GreetingRow,
  InsertAiCallInput,
  InsertWinnerPickInput,
  ItemPatch,
  ItemRow,
  LayoutStatePatch,
  LayoutStateRow,
  PlayerPatch,
  PlayerRow,
  Repository,
  ScoreAggregate,
  ScoreRow,
  TeamPatch,
  TeamRow,
  UpsertScoreInput,
  WinnerPickRow,
} from "./repository";

/** Rejection error for unique-constraint / not-found violations. */
export class RepoError extends Error {}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Generate a 6-char join code from the unambiguous alphabet. */
export function generateGameCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** "Alex" → ["Alex", "Alex 2", "Alex 3", ...] candidate generator. */
export function nicknameCandidates(base: string): string[] {
  const candidates = [base];
  for (let i = 2; i <= 99; i++) candidates.push(`${base} ${i}`);
  return candidates;
}

export class MemoryRepo implements Repository {
  private games = new Map<string, GameRow>();
  private teams = new Map<string, TeamRow>();
  private players = new Map<string, PlayerRow>();
  private greetings = new Map<string, GreetingRow>();
  private items = new Map<string, ItemRow>();
  private layouts = new Map<string, LayoutStateRow>(); // key `${teamId}:${round}`
  private scores = new Map<string, ScoreRow>(); // key `${round}:${voterPlayerId}:${targetTeamId}`
  private winnerPicks = new Map<string, WinnerPickRow>(); // key `${gameId}:${round}:${role}`
  private aiCalls = new Map<string, AiCallRow>();

  // -- helpers --------------------------------------------------------------

  private layoutKey(teamId: string, round: number): string {
    return `${teamId}:${round}`;
  }

  private scoreKey(round: number, voterPlayerId: string, targetTeamId: string): string {
    return `${round}:${voterPlayerId}:${targetTeamId}`;
  }

  private pickKey(gameId: string, round: number, role: string): string {
    return `${gameId}:${round}:${role}`;
  }

  private requireGame(gameId: string): GameRow {
    const game = this.games.get(gameId);
    if (!game) throw new RepoError(`game ${gameId} not found`);
    return game;
  }

  private assertTeam(teamId: string): TeamRow {
    const team = this.teams.get(teamId);
    if (!team) throw new RepoError(`team ${teamId} not found`);
    return team;
  }

  private now(): number {
    return Date.now();
  }

  // -- Games ---------------------------------------------------------------

  async createGame(input: CreateGameInput): Promise<GameRow> {
    const code = input.code ?? generateGameCode();
    if ([...this.games.values()].some((g) => g.code === code)) {
      throw new RepoError(`game code ${code} already in use`);
    }
    const row: GameRow = {
      id: randomUUID(),
      code,
      phase: "LOBBY",
      round: 1,
      theme: null,
      config: input.config,
      phaseEndsAt: null,
      cutoffAt: null,
      createdAt: this.now(),
    };
    this.games.set(row.id, row);
    return { ...row };
  }

  async getGame(id: string): Promise<GameRow | null> {
    const row = this.games.get(id);
    return row ? { ...row } : null;
  }

  async getGameByCode(code: string): Promise<GameRow | null> {
    for (const row of this.games.values()) {
      if (row.code === code) return { ...row };
    }
    return null;
  }

  async listGames(): Promise<GameRow[]> {
    return [...this.games.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((g) => ({ ...g }));
  }

  async updateGame(id: string, patch: GamePatch): Promise<GameRow> {
    const row = this.games.get(id);
    if (!row) throw new RepoError(`game ${id} not found`);
    const next: GameRow = { ...row, ...patch };
    this.games.set(id, next);
    return { ...next };
  }

  // -- Teams ---------------------------------------------------------------

  async createTeam(input: CreateTeamInput): Promise<TeamRow> {
    this.requireGame(input.gameId);
    if ([...this.teams.values()].some((t) => t.gameId === input.gameId && t.label === input.label)) {
      throw new RepoError(`label "${input.label}" already used in game ${input.gameId}`);
    }
    if ([...this.teams.values()].some((t) => t.joinToken === input.joinToken)) {
      throw new RepoError(`joinToken already in use`);
    }
    const row: TeamRow = { id: randomUUID(), ...input };
    this.teams.set(row.id, row);
    return { ...row };
  }

  async listTeams(gameId: string): Promise<TeamRow[]> {
    return [...this.teams.values()]
      .filter((t) => t.gameId === gameId)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((t) => ({ ...t }));
  }

  async getTeamByJoinToken(token: string): Promise<TeamRow | null> {
    for (const row of this.teams.values()) {
      if (row.joinToken === token) return { ...row };
    }
    return null;
  }

  async updateTeam(id: string, patch: TeamPatch): Promise<TeamRow> {
    const row = this.teams.get(id);
    if (!row) throw new RepoError(`team ${id} not found`);
    if (patch.label !== undefined && patch.label !== row.label) {
      if (
        [...this.teams.values()].some(
          (t) => t.gameId === row.gameId && t.label === patch.label,
        )
      ) {
        throw new RepoError(`label "${patch.label}" already used in game ${row.gameId}`);
      }
    }
    const next: TeamRow = { ...row, ...patch };
    this.teams.set(id, next);
    return { ...next };
  }

  // -- Players ---------------------------------------------------------------

  async createPlayer(input: CreatePlayerInput): Promise<PlayerRow> {
    this.requireGame(input.gameId);
    this.assertTeam(input.teamId);
    if ([...this.players.values()].some((p) => p.sessionToken === input.sessionToken)) {
      throw new RepoError("sessionToken already in use");
    }
    const taken = new Set(
      [...this.players.values()].filter((p) => p.gameId === input.gameId).map((p) => p.nickname),
    );
    let nickname = input.nickname;
    if (taken.has(nickname)) {
      if (!input.autoSuffix) {
        throw new RepoError(`nickname "${nickname}" already used in game ${input.gameId}`);
      }
      const candidate = nicknameCandidates(input.nickname).find((c) => !taken.has(c));
      if (!candidate) throw new RepoError("could not derive a free nickname");
      nickname = candidate;
    }
    const row: PlayerRow = {
      id: randomUUID(),
      gameId: input.gameId,
      teamId: input.teamId,
      nickname,
      sessionToken: input.sessionToken,
      connected: false,
      removedAt: null,
    };
    this.players.set(row.id, row);
    return { ...row };
  }

  async findNicknames(gameId: string): Promise<string[]> {
    return [...this.players.values()]
      .filter((p) => p.gameId === gameId)
      .map((p) => p.nickname)
      .sort();
  }

  async getPlayer(playerId: string): Promise<PlayerRow | null> {
    const row = this.players.get(playerId);
    return row ? { ...row } : null;
  }

  async getPlayerBySessionToken(token: string): Promise<PlayerRow | null> {
    for (const row of this.players.values()) {
      if (row.sessionToken === token) return { ...row };
    }
    return null;
  }

  async setPlayerConnected(playerId: string, connected: boolean): Promise<PlayerRow> {
    const row = this.players.get(playerId);
    if (!row) throw new RepoError(`player ${playerId} not found`);
    const next: PlayerRow = { ...row, connected };
    this.players.set(playerId, next);
    return { ...next };
  }

  async kickPlayer(playerId: string, now: number): Promise<PlayerRow> {
    const row = this.players.get(playerId);
    if (!row) throw new RepoError(`player ${playerId} not found`);
    const next: PlayerRow = { ...row, removedAt: now, connected: false };
    this.players.set(playerId, next);
    return { ...next };
  }

  async countTeamMembers(teamId: string): Promise<number> {
    this.assertTeam(teamId);
    let count = 0;
    for (const row of this.players.values()) {
      if (row.teamId === teamId && row.removedAt === null) count += 1;
    }
    return count;
  }

  async listTeamPlayers(teamId: string): Promise<PlayerRow[]> {
    this.assertTeam(teamId);
    return [...this.players.values()]
      .filter((p) => p.teamId === teamId && p.removedAt === null)
      .sort((a, b) => a.nickname.localeCompare(b.nickname))
      .map((p) => ({ ...p }));
  }

  // -- Greetings -------------------------------------------------------------

  async createGreeting(input: CreateGreetingInput): Promise<GreetingRow> {
    this.assertTeam(input.teamId);
    const key = `${input.teamId}:${input.round}`;
    if (this.greetings.has(key)) {
      throw new RepoError(`greeting for team ${input.teamId} round ${input.round} already exists`);
    }
    const row: GreetingRow = {
      id: randomUUID(),
      teamId: input.teamId,
      round: input.round,
      text: input.text,
      status: input.status ?? "proposed",
      styleHint: input.styleHint ?? null,
    };
    this.greetings.set(key, row);
    return { ...row };
  }

  async updateGreeting(teamId: string, round: number, patch: GreetingPatch): Promise<GreetingRow> {
    const row = this.greetings.get(`${teamId}:${round}`);
    if (!row) throw new RepoError(`greeting for team ${teamId} round ${round} not found`);
    const next: GreetingRow = { ...row, ...patch };
    this.greetings.set(`${teamId}:${round}`, next);
    return { ...next };
  }

  async listGreetings(gameId: string, round: number): Promise<GreetingRow[]> {
    const teamIds = new Set([...this.teams.values()].filter((t) => t.gameId === gameId).map((t) => t.id));
    return [...this.greetings.values()]
      .filter((g) => g.round === round && teamIds.has(g.teamId))
      .sort((a, b) => a.teamId.localeCompare(b.teamId))
      .map((g) => ({ ...g }));
  }

  // -- Items -----------------------------------------------------------------

  async createItem(input: CreateItemInput): Promise<ItemRow> {
    this.assertTeam(input.teamId);
    const dup = [...this.items.values()].some(
      (i) =>
        i.teamId === input.teamId &&
        i.round === input.round &&
        i.promptRaw === input.promptRaw &&
        i.playerId === input.playerId,
    );
    if (dup) {
      throw new RepoError(
        `duplicate item (team ${input.teamId}, round ${input.round}, player ${input.playerId}, prompt "${input.promptRaw}")`,
      );
    }
    const row: ItemRow = {
      id: randomUUID(),
      teamId: input.teamId,
      playerId: input.playerId,
      round: input.round,
      promptRaw: input.promptRaw,
      subject: input.subject ?? null,
      status: input.status ?? "PENDING",
      imageUrl: null,
      width: null,
      height: null,
      visualWeight: null,
      failReason: null,
      createdAt: this.now(),
      placedAt: null,
    };
    this.items.set(row.id, row);
    return { ...row };
  }

  async getItem(id: string): Promise<ItemRow | null> {
    const row = this.items.get(id);
    return row ? { ...row } : null;
  }

  async updateItem(id: string, patch: ItemPatch): Promise<ItemRow> {
    const row = this.items.get(id);
    if (!row) throw new RepoError(`item ${id} not found`);
    const next: ItemRow = { ...row, ...patch };
    this.items.set(id, next);
    return { ...next };
  }

  async listItems(teamId: string, round: number, statuses?: ItemStatus[]): Promise<ItemRow[]> {
    return [...this.items.values()]
      .filter(
        (i) =>
          i.teamId === teamId &&
          i.round === round &&
          (statuses === undefined || statuses.includes(i.status as ItemStatus)),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((i) => ({ ...i }));
  }

  // -- Layout ----------------------------------------------------------------

  async upsertLayoutState(teamId: string, round: number, patch: LayoutStatePatch): Promise<LayoutStateRow> {
    this.assertTeam(teamId);
    const key = this.layoutKey(teamId, round);
    const existing = this.layouts.get(key);
    const next: LayoutStateRow = {
      teamId,
      round,
      version: patch.version,
      placements: patch.placements,
      greetingStyle: patch.greetingStyle ?? existing?.greetingStyle ?? null,
      source: patch.source,
      updatedAt: this.now(),
    };
    // Last-write-wins only when the incoming version is not older.
    if (existing && patch.version < existing.version) {
      throw new RepoError(
        `stale layout write: version ${patch.version} < current ${existing.version}`,
      );
    }
    this.layouts.set(key, next);
    return { ...next, placements: [...next.placements] };
  }

  async getLayoutState(teamId: string, round: number): Promise<LayoutStateRow | null> {
    const row = this.layouts.get(this.layoutKey(teamId, round));
    return row ? { ...row, placements: [...row.placements] } : null;
  }

  // -- Scores ----------------------------------------------------------------

  async upsertScore(input: UpsertScoreInput): Promise<ScoreRow> {
    this.requireGame(input.gameId);
    // Round-level lock: once any score of the round is locked, the round is
    // frozen — refuse ALL writes (new rows and overwrites alike).
    if (await this.areScoresLocked(input.gameId, input.round)) {
      throw new RepoError(`scores_locked: round ${input.round} of game ${input.gameId} is locked`);
    }
    const existing = this.scores.get(
      this.scoreKey(input.round, input.voterPlayerId, input.targetTeamId),
    );
    if (existing?.locked) {
      throw new RepoError(`score is locked (round ${input.round})`);
    }
    const row: ScoreRow = {
      id: existing?.id ?? randomUUID(),
      gameId: input.gameId,
      round: input.round,
      voterPlayerId: input.voterPlayerId,
      voterTeamId: input.voterTeamId,
      targetTeamId: input.targetTeamId,
      value: input.value,
      locked: input.locked ?? existing?.locked ?? false,
    };
    this.scores.set(this.scoreKey(row.round, row.voterPlayerId, row.targetTeamId), row);
    return { ...row };
  }

  /** Lock every score row of a game+round; returns how many rows were locked. */
  async lockScores(gameId: string, round: number): Promise<number> {
    this.requireGame(gameId);
    let count = 0;
    for (const [key, s] of this.scores) {
      if (s.gameId === gameId && s.round === round) {
        if (!s.locked) {
          this.scores.set(key, { ...s, locked: true });
        }
        count += 1;
      }
    }
    return count;
  }

  /** True when any score row of the game+round carries locked=true. */
  async areScoresLocked(gameId: string, round: number): Promise<boolean> {
    for (const s of this.scores.values()) {
      if (s.gameId === gameId && s.round === round && s.locked) return true;
    }
    return false;
  }

  async listScores(gameId: string, round: number, targetTeamId?: string): Promise<ScoreRow[]> {
    // Map preserves insertion order — deterministic without a timestamp column.
    return [...this.scores.values()]
      .filter(
        (s) => s.gameId === gameId && s.round === round && (targetTeamId === undefined || s.targetTeamId === targetTeamId),
      )
      .map((s) => ({ ...s }));
  }

  async aggregateScores(gameId: string, round: number): Promise<ScoreAggregate[]> {
    const byTarget = new Map<string, number[]>();
    for (const s of this.scores.values()) {
      if (s.gameId !== gameId || s.round !== round) continue;
      // Data-corruption guard: a value outside 1..10 would silently poison the
      // distribution buckets — fail loudly instead.
      if (!Number.isInteger(s.value) || s.value < 1 || s.value > 10) {
        throw new RepoError(
          `corrupt score row: value ${s.value} outside 1..10 (game ${gameId}, round ${round}, target ${s.targetTeamId})`,
        );
      }
      const bucket = byTarget.get(s.targetTeamId) ?? [];
      bucket.push(s.value);
      byTarget.set(s.targetTeamId, bucket);
    }
    const aggregates: ScoreAggregate[] = [];
    for (const [targetTeamId, values] of byTarget) {
      const distribution = new Array<number>(10).fill(0);
      let sum = 0;
      for (const v of values) {
        distribution[v - 1] += 1;
        sum += v;
      }
      aggregates.push({
        targetTeamId,
        count: values.length,
        avg: values.length === 0 ? 0 : sum / values.length,
        distribution,
      });
    }
    return aggregates.sort((a, b) => a.targetTeamId.localeCompare(b.targetTeamId));
  }

  // -- Winner picks ------------------------------------------------------------

  async insertWinnerPick(input: InsertWinnerPickInput): Promise<WinnerPickRow> {
    this.requireGame(input.gameId);
    const key = `${input.gameId}:${input.round}:${input.role}`;
    if (this.winnerPicks.has(key)) {
      throw new RepoError(`winner pick already recorded for round ${input.round} role ${input.role}`);
    }
    const row: WinnerPickRow = { id: randomUUID(), ...input };
    this.winnerPicks.set(key, row);
    return { ...row };
  }

  async listWinnerPicks(gameId: string, round?: number): Promise<WinnerPickRow[]> {
    return [...this.winnerPicks.values()]
      .filter((w) => w.gameId === gameId && (round === undefined || w.round === round))
      .sort((a, b) => a.round - b.round)
      .map((w) => ({ ...w }));
  }

  // -- AI calls ----------------------------------------------------------------

  async insertAiCall(input: InsertAiCallInput): Promise<AiCallRow> {
    const row: AiCallRow = {
      id: randomUUID(),
      gameId: input.gameId ?? null,
      task: input.task,
      model: input.model,
      status: input.status,
      latencyMs: input.latencyMs,
      costUsd: input.costUsd ?? 0,
      usage: input.usage ?? null,
      retries: input.retries ?? 0,
      fallbackUsed: input.fallbackUsed ?? false,
      error: input.error ?? null,
      createdAt: this.now(),
    };
    this.aiCalls.set(row.id, row);
    return { ...row };
  }

  async listAiCalls(gameId: string): Promise<AiCallSummary> {
    const rows = [...this.aiCalls.values()]
      .filter((c) => c.gameId === gameId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
    const taskMap = new Map<string, AiTaskStats>();
    let totalCostUsd = 0;
    for (const c of rows) {
      totalCostUsd += c.costUsd;
      const stats =
        taskMap.get(c.task) ??
        { task: c.task, count: 0, avgLatencyMs: 0, totalCostUsd: 0, errorCount: 0, fallbackCount: 0 };
      stats.count += 1;
      stats.totalCostUsd += c.costUsd;
      stats.avgLatencyMs += c.latencyMs; // accumulated; divided below
      if (c.status === "ERROR" || c.status === "TIMEOUT_BLOCKED") stats.errorCount += 1;
      if (c.fallbackUsed) stats.fallbackCount += 1;
      taskMap.set(c.task, stats);
    }
    const perTask = [...taskMap.values()].map((s) => ({
      ...s,
      avgLatencyMs: s.count === 0 ? 0 : s.avgLatencyMs / s.count,
      totalCostUsd: round6(s.totalCostUsd),
    }));
    return { rows, perTask, totalCostUsd: round6(totalCostUsd) };
  }
}

/** Round a USD cost to 6 decimals to avoid float drift in summaries. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}