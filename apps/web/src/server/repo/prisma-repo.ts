/**
 * Prisma-backed Repository — the production implementation (postgres).
 *
 * Delegates to @prisma/client (schema at repo root: prisma/schema.prisma).
 * Prisma `DateTime` columns are converted to epoch-ms numbers at the boundary,
 * and JSON columns (config, styleHint, placements, usage) map to typed objects.
 * Unique constraints (code, joinToken, sessionToken, [gameId,label],
 * [gameId,nickname], [teamId,round], [teamId,round,promptRaw,playerId],
 * [round,voterPlayerId,targetTeamId], [gameId,round,role]) are enforced by the
 * database; violations surface as Prisma P2002 errors, rethrown as RepoError.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import type { CardConfig, GreetingStyle, ItemStatus, Placement } from "@cardcrafters/shared";

import { RepoError } from "./memory-repo";
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
  RoundRole,
  ScoreAggregate,
  ScoreRow,
  TeamPatch,
  TeamRow,
  UpsertScoreInput,
  WinnerPickRow,
} from "./repository";

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/** Map a Prisma unique-violation (or other known error) to RepoError. */
function wrap(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return new RepoError(`unique constraint violated: ${e.meta?.target ?? "(unknown)"}`);
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
    return new RepoError("record not found");
  }
  return e;
}

export class PrismaRepo implements Repository {
  private prisma: PrismaClient;

  constructor(client?: PrismaClient) {
    this.prisma = client ?? new PrismaClient();
  }

  /** Allow graceful shutdown by the host process. */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  // -- Games ---------------------------------------------------------------

  async createGame(input: CreateGameInput): Promise<GameRow> {
    try {
      const g = await this.prisma.game.create({
        data: {
          code: input.code ?? (await this.generateCode()),
          config: input.config as unknown as Prisma.InputJsonValue,
          phase: "LOBBY",
          round: 1,
        },
      });
      return this.mapGame(g);
    } catch (e) {
      throw wrap(e);
    }
  }

  /** 6-char code from the unambiguous alphabet, retried on collision. */
  private async generateCode(): Promise<string> {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const existing = await this.prisma.game.findUnique({ where: { code } });
      if (!existing) return code;
    }
    throw new RepoError("could not generate a unique game code");
  }

  async getGame(id: string): Promise<GameRow | null> {
    const g = await this.prisma.game.findUnique({ where: { id } });
    return g ? this.mapGame(g) : null;
  }

  async getGameByCode(code: string): Promise<GameRow | null> {
    const g = await this.prisma.game.findUnique({ where: { code } });
    return g ? this.mapGame(g) : null;
  }

  async listGames(): Promise<GameRow[]> {
    try {
      const rows = await this.prisma.game.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((g) => this.mapGame(g));
    } catch (e) {
      throw wrap(e);
    }
  }

  async updateGame(id: string, patch: GamePatch): Promise<GameRow> {
    try {
      const g = await this.prisma.game.update({
        where: { id },
        data: {
          phase: patch.phase,
          round: patch.round,
          theme: patch.theme,
          config: patch.config
            ? (patch.config as unknown as Prisma.InputJsonValue)
            : undefined,
          phaseEndsAt: patch.phaseEndsAt === undefined ? undefined : patch.phaseEndsAt === null ? null : new Date(patch.phaseEndsAt),
          cutoffAt: patch.cutoffAt === undefined ? undefined : patch.cutoffAt === null ? null : new Date(patch.cutoffAt),
        },
      });
      return this.mapGame(g);
    } catch (e) {
      throw wrap(e);
    }
  }

  private mapGame(g: {
    id: string;
    code: string;
    phase: string;
    round: number;
    theme: string | null;
    config: unknown;
    phaseEndsAt: Date | null;
    cutoffAt: Date | null;
    createdAt: Date;
  }): GameRow {
    return {
      id: g.id,
      code: g.code,
      phase: g.phase as GameRow["phase"],
      round: g.round,
      theme: g.theme,
      config: g.config as CardConfig,
      phaseEndsAt: ms(g.phaseEndsAt),
      cutoffAt: ms(g.cutoffAt),
      createdAt: g.createdAt.getTime(),
    };
  }

  // -- Teams ---------------------------------------------------------------

  async createTeam(input: CreateTeamInput): Promise<TeamRow> {
    try {
      const t = await this.prisma.team.create({ data: input });
      return this.mapTeam(t);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listTeams(gameId: string): Promise<TeamRow[]> {
    const teams = await this.prisma.team.findMany({
      where: { gameId },
      orderBy: { label: "asc" },
    });
    return teams.map((t) => this.mapTeam(t));
  }

  async getTeamByJoinToken(token: string): Promise<TeamRow | null> {
    const t = await this.prisma.team.findUnique({ where: { joinToken: token } });
    return t ? this.mapTeam(t) : null;
  }

  async updateTeam(id: string, patch: TeamPatch): Promise<TeamRow> {
    try {
      const t = await this.prisma.team.update({ where: { id }, data: patch });
      return this.mapTeam(t);
    } catch (e) {
      throw wrap(e);
    }
  }

  private mapTeam(t: {
    id: string;
    gameId: string;
    name: string;
    label: string;
    joinToken: string;
  }): TeamRow {
    return {
      id: t.id,
      gameId: t.gameId,
      name: t.name,
      label: t.label,
      joinToken: t.joinToken,
    };
  }

  // -- Players ---------------------------------------------------------------

  async createPlayer(input: CreatePlayerInput): Promise<PlayerRow> {
    try {
      const p = await this.prisma.player.create({
        data: {
          gameId: input.gameId,
          teamId: input.teamId,
          nickname: input.nickname,
          sessionToken: input.sessionToken,
        },
      });
      return this.mapPlayer(p);
    } catch (e) {
      // Auto-suffix: "Alex" taken → try "Alex 2", "Alex 3", ... (max 99).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && input.autoSuffix) {
        for (let i = 2; i <= 99; i++) {
          try {
            const p = await this.prisma.player.create({
              data: {
                gameId: input.gameId,
                teamId: input.teamId,
                nickname: `${input.nickname} ${i}`,
                sessionToken: input.sessionToken,
              },
            });
            return this.mapPlayer(p);
          } catch (retry) {
            if (
              retry instanceof Prisma.PrismaClientKnownRequestError &&
              retry.code === "P2002"
            ) {
              continue; // nickname collision — try next suffix
            }
            throw wrap(retry);
          }
        }
        throw new RepoError("could not derive a free nickname");
      }
      throw wrap(e);
    }
  }

  async findNicknames(gameId: string): Promise<string[]> {
    const players = await this.prisma.player.findMany({
      where: { gameId },
      select: { nickname: true },
      orderBy: { nickname: "asc" },
    });
    return players.map((p) => p.nickname);
  }

  async getPlayerBySessionToken(token: string): Promise<PlayerRow | null> {
    const p = await this.prisma.player.findUnique({ where: { sessionToken: token } });
    return p ? this.mapPlayer(p) : null;
  }

  async setPlayerConnected(playerId: string, connected: boolean): Promise<PlayerRow> {
    try {
      const p = await this.prisma.player.update({
        where: { id: playerId },
        data: { connected },
      });
      return this.mapPlayer(p);
    } catch (e) {
      throw wrap(e);
    }
  }

  async kickPlayer(playerId: string, now: number): Promise<PlayerRow> {
    try {
      const p = await this.prisma.player.update({
        where: { id: playerId },
        data: { removedAt: new Date(now), connected: false },
      });
      return this.mapPlayer(p);
    } catch (e) {
      throw wrap(e);
    }
  }

  private mapPlayer(p: {
    id: string;
    teamId: string;
    gameId: string;
    nickname: string;
    sessionToken: string;
    connected: boolean;
    removedAt: Date | null;
  }): PlayerRow {
    return {
      id: p.id,
      teamId: p.teamId,
      gameId: p.gameId,
      nickname: p.nickname,
      sessionToken: p.sessionToken,
      connected: p.connected,
      removedAt: ms(p.removedAt),
    };
  }

  // -- Greetings -------------------------------------------------------------

  async createGreeting(input: CreateGreetingInput): Promise<GreetingRow> {
    try {
      const g = await this.prisma.greeting.create({
        data: {
          teamId: input.teamId,
          round: input.round,
          text: input.text,
          status: input.status ?? "proposed",
          styleHint: (input.styleHint ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      return this.mapGreeting(g);
    } catch (e) {
      throw wrap(e);
    }
  }

  async updateGreeting(teamId: string, round: number, patch: GreetingPatch): Promise<GreetingRow> {
    try {
      const g = await this.prisma.greeting.update({
        where: { teamId_round: { teamId, round } },
        data: {
          text: patch.text,
          status: patch.status,
          styleHint:
            patch.styleHint === undefined
              ? undefined
              : (patch.styleHint ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
        },
      });
      return this.mapGreeting(g);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listGreetings(gameId: string, round: number): Promise<GreetingRow[]> {
    const greetings = await this.prisma.greeting.findMany({
      where: { round, team: { gameId } },
      orderBy: { teamId: "asc" },
    });
    return greetings.map((g) => this.mapGreeting(g));
  }

  private mapGreeting(g: {
    id: string;
    teamId: string;
    round: number;
    text: string;
    status: string;
    styleHint: unknown;
  }): GreetingRow {
    return {
      id: g.id,
      teamId: g.teamId,
      round: g.round,
      text: g.text,
      status: g.status,
      styleHint: (g.styleHint as GreetingStyle | null) ?? null,
    };
  }

  // -- Items -----------------------------------------------------------------

  async createItem(input: CreateItemInput): Promise<ItemRow> {
    try {
      const i = await this.prisma.item.create({
        data: {
          teamId: input.teamId,
          playerId: input.playerId,
          round: input.round,
          promptRaw: input.promptRaw,
          subject: input.subject ?? null,
          status: input.status ?? "PENDING",
        },
      });
      return this.mapItem(i);
    } catch (e) {
      throw wrap(e);
    }
  }

  async updateItem(id: string, patch: ItemPatch): Promise<ItemRow> {
    try {
      const i = await this.prisma.item.update({
        where: { id },
        data: {
          ...patch,
          placedAt:
            patch.placedAt === undefined
              ? undefined
              : patch.placedAt === null
                ? null
                : new Date(patch.placedAt),
        },
      });
      return this.mapItem(i);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listItems(teamId: string, round: number, statuses?: ItemStatus[]): Promise<ItemRow[]> {
    const items = await this.prisma.item.findMany({
      where: {
        teamId,
        round,
        ...(statuses ? { status: { in: statuses } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return items.map((i) => this.mapItem(i));
  }

  private mapItem(i: {
    id: string;
    teamId: string;
    playerId: string;
    round: number;
    promptRaw: string;
    subject: string | null;
    status: string;
    imageUrl: string | null;
    width: number | null;
    height: number | null;
    visualWeight: number | null;
    failReason: string | null;
    createdAt: Date;
    placedAt: Date | null;
  }): ItemRow {
    return {
      id: i.id,
      teamId: i.teamId,
      playerId: i.playerId,
      round: i.round,
      promptRaw: i.promptRaw,
      subject: i.subject,
      status: i.status as ItemStatus,
      imageUrl: i.imageUrl,
      width: i.width,
      height: i.height,
      visualWeight: i.visualWeight,
      failReason: i.failReason,
      createdAt: i.createdAt.getTime(),
      placedAt: ms(i.placedAt),
    };
  }

  // -- Layout ----------------------------------------------------------------

  async upsertLayoutState(teamId: string, round: number, patch: LayoutStatePatch): Promise<LayoutStateRow> {
    try {
      const l = await this.prisma.layoutState.upsert({
        where: { teamId_round: { teamId, round } },
        create: {
          teamId,
          round,
          version: patch.version,
          placements: patch.placements as unknown as Prisma.InputJsonValue,
          greetingStyle: (patch.greetingStyle ?? undefined) as Prisma.InputJsonValue | undefined,
          source: patch.source,
        },
        update: {
          version: patch.version,
          placements: patch.placements as unknown as Prisma.InputJsonValue,
          ...(patch.greetingStyle !== undefined
            ? { greetingStyle: patch.greetingStyle as Prisma.InputJsonValue }
            : {}),
          source: patch.source,
        },
      });
      return this.mapLayout(l);
    } catch (e) {
      throw wrap(e);
    }
  }

  async getLayoutState(teamId: string, round: number): Promise<LayoutStateRow | null> {
    const l = await this.prisma.layoutState.findUnique({
      where: { teamId_round: { teamId, round } },
    });
    return l ? this.mapLayout(l) : null;
  }

  private mapLayout(l: {
    teamId: string;
    round: number;
    version: number;
    placements: unknown;
    greetingStyle: unknown;
    source: string;
    updatedAt: Date;
  }): LayoutStateRow {
    return {
      teamId: l.teamId,
      round: l.round,
      version: l.version,
      placements: l.placements as Placement[],
      greetingStyle: (l.greetingStyle as GreetingStyle | null) ?? null,
      source: l.source,
      updatedAt: l.updatedAt.getTime(),
    };
  }

  // -- Scores ----------------------------------------------------------------

  async upsertScore(input: UpsertScoreInput): Promise<ScoreRow> {
    try {
      // Locked check: if the target score row exists and is locked, refuse.
      const existing = await this.prisma.score.findUnique({
        where: {
          round_voterPlayerId_targetTeamId: {
            round: input.round,
            voterPlayerId: input.voterPlayerId,
            targetTeamId: input.targetTeamId,
          },
        },
      });
      if (existing?.locked) {
        throw new RepoError(`score is locked (round ${input.round})`);
      }
      const s = await this.prisma.score.upsert({
        where: {
          round_voterPlayerId_targetTeamId: {
            round: input.round,
            voterPlayerId: input.voterPlayerId,
            targetTeamId: input.targetTeamId,
          },
        },
        create: {
          gameId: input.gameId,
          round: input.round,
          voterPlayerId: input.voterPlayerId,
          voterTeamId: input.voterTeamId,
          targetTeamId: input.targetTeamId,
          value: input.value,
          locked: input.locked ?? false,
        },
        update: {
          value: input.value,
          ...(input.locked !== undefined ? { locked: input.locked } : {}),
        },
      });
      return this.mapScore(s);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listScores(gameId: string, round: number, targetTeamId?: string): Promise<ScoreRow[]> {
    const scores = await this.prisma.score.findMany({
      where: { gameId, round, ...(targetTeamId ? { targetTeamId } : {}) },
      orderBy: { id: "asc" },
    });
    return scores.map((s) => this.mapScore(s));
  }

  async aggregateScores(gameId: string, round: number): Promise<ScoreAggregate[]> {
    const scores = await this.prisma.score.findMany({
      where: { gameId, round },
      select: { targetTeamId: true, value: true },
    });
    const byTarget = new Map<string, number[]>();
    for (const s of scores) {
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

  private mapScore(s: {
    id: string;
    gameId: string;
    round: number;
    voterPlayerId: string;
    voterTeamId: string;
    targetTeamId: string;
    value: number;
    locked: boolean;
  }): ScoreRow {
    return {
      id: s.id,
      gameId: s.gameId,
      round: s.round,
      voterPlayerId: s.voterPlayerId,
      voterTeamId: s.voterTeamId,
      targetTeamId: s.targetTeamId,
      value: s.value,
      locked: s.locked,
    };
  }

  // -- Winner picks ------------------------------------------------------------

  async insertWinnerPick(input: InsertWinnerPickInput): Promise<WinnerPickRow> {
    try {
      const w = await this.prisma.winnerPick.create({
        data: { gameId: input.gameId, round: input.round, teamId: input.teamId, role: input.role },
      });
      return this.mapPick(w);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listWinnerPicks(gameId: string, round?: number): Promise<WinnerPickRow[]> {
    const picks = await this.prisma.winnerPick.findMany({
      where: { gameId, ...(round !== undefined ? { round } : {}) },
      orderBy: { round: "asc" },
    });
    return picks.map((w) => this.mapPick(w));
  }

  private mapPick(w: {
    id: string;
    gameId: string;
    round: number;
    teamId: string;
    role: string;
  }): WinnerPickRow {
    return {
      id: w.id,
      gameId: w.gameId,
      round: w.round,
      teamId: w.teamId,
      role: w.role as RoundRole,
    };
  }

  // -- AI calls ----------------------------------------------------------------

  async insertAiCall(input: InsertAiCallInput): Promise<AiCallRow> {
    try {
      const c = await this.prisma.aiCall.create({
        data: {
          gameId: input.gameId ?? null,
          task: input.task,
          model: input.model,
          status: input.status,
          latencyMs: input.latencyMs,
          costUsd: input.costUsd ?? 0,
          usage: (input.usage ?? undefined) as Prisma.InputJsonValue | undefined,
          retries: input.retries ?? 0,
          fallbackUsed: input.fallbackUsed ?? false,
          error: input.error ?? null,
        },
      });
      return this.mapAiCall(c);
    } catch (e) {
      throw wrap(e);
    }
  }

  async listAiCalls(gameId: string): Promise<AiCallSummary> {
    const calls = await this.prisma.aiCall.findMany({
      where: { gameId },
      orderBy: { createdAt: "asc" },
    });
    const rows = calls.map((c) => this.mapAiCall(c));
    const taskMap = new Map<string, AiTaskStats>();
    let totalCostUsd = 0;
    for (const c of rows) {
      totalCostUsd += c.costUsd;
      const stats =
        taskMap.get(c.task) ??
        { task: c.task, count: 0, avgLatencyMs: 0, totalCostUsd: 0, errorCount: 0, fallbackCount: 0 };
      stats.count += 1;
      stats.totalCostUsd += c.costUsd;
      stats.avgLatencyMs += c.latencyMs;
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

  private mapAiCall(c: {
    id: string;
    gameId: string | null;
    task: string;
    model: string;
    status: string;
    latencyMs: number;
    costUsd: number;
    usage: unknown;
    retries: number;
    fallbackUsed: boolean;
    error: string | null;
    createdAt: Date;
  }): AiCallRow {
    return {
      id: c.id,
      gameId: c.gameId,
      task: c.task,
      model: c.model,
      status: c.status as AiCallRow["status"],
      latencyMs: c.latencyMs,
      costUsd: c.costUsd,
      usage: (c.usage as Record<string, unknown> | null) ?? null,
      retries: c.retries,
      fallbackUsed: c.fallbackUsed,
      error: c.error,
      createdAt: c.createdAt.getTime(),
    };
  }
}

/** Round a USD cost to 6 decimals to avoid float drift in summaries. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}