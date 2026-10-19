/**
 * Repository interface — the ONLY data-access surface the rest of the server
 * (steps 3–13) is allowed to use. Two implementations exist:
 *  - memory-repo.ts (tests, zero-infra mode)
 *  - prisma-repo.ts (postgres via @prisma/client)
 *
 * Both must enforce identical unique constraints (duplicate gameId+nickname,
 * gameId+label, joinToken collision, score upsert overwrite, ...) so contract
 * drift between the in-memory and real databases is caught by tests.
 *
 * Conventions:
 *  - All timestamps are epoch milliseconds (numbers), matching the shared
 *    kernel; PrismaRepo converts Date↔number at the boundary.
 *  - Row shapes are plain objects mirroring the Prisma models in
 *    prisma/schema.prisma; JSON columns map to typed objects.
 */

import type {
  CardConfig,
  ContentBox,
  GreetingStyle,
  ItemStatus,
  LayoutCritique,
  Phase,
  Placement,
  ScoringOrder,
  StyleDerivation,
} from "@cardcrafters/shared";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type RoundRole = "PEOPLES_CHOICE" | "GM_WINNER" | "NONE";
export type CallStatus = "OK" | "FALLBACK_OK" | "ERROR" | "TIMEOUT_BLOCKED";

export interface GameRow {
  id: string;
  code: string;
  phase: Phase;
  round: number;
  theme: string | null;
  config: CardConfig;
  style: StyleDerivation | null;
  phaseEndsAt: number | null;
  cutoffAt: number | null;
  /** Anonymous scoring order for the current round (null until SCORING entry;
   *  cleared when a new round starts). */
  scoringOrder: ScoringOrder | null;
  createdAt: number;
}

export interface TeamRow {
  id: string;
  gameId: string;
  name: string;
  label: string;
  joinToken: string;
}

export interface PlayerRow {
  id: string;
  teamId: string;
  gameId: string;
  nickname: string;
  sessionToken: string;
  connected: boolean;
  /** Soft-delete marker (kick); row survives. */
  removedAt: number | null;
}

export interface GreetingRow {
  id: string;
  teamId: string;
  round: number;
  text: string;
  /** Free-form status: "proposed" | "approved" | ... (string per schema). */
  status: string;
  styleHint: GreetingStyle | null;
}

export interface ItemRow {
  id: string;
  teamId: string;
  playerId: string;
  round: number;
  promptRaw: string;
  subject: string | null;
  status: ItemStatus;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  visualWeight: number | null;
  contentBox: ContentBox | null;
  failReason: string | null;
  createdAt: number;
  placedAt: number | null;
}

export interface LayoutStateRow {
  teamId: string;
  round: number;
  version: number;
  placements: Placement[];
  greetingStyle: GreetingStyle | null;
  /** Final vision critique verdict (persisted during Phase A settle). */
  critique: LayoutCritique | null;
  source: string;
  updatedAt: number;
}

export interface ScoreRow {
  id: string;
  gameId: string;
  round: number;
  voterPlayerId: string;
  voterTeamId: string;
  targetTeamId: string;
  /** 1..10 (validated upstream by scoreSubmitSchema). */
  value: number;
  locked: boolean;
}

export interface WinnerPickRow {
  id: string;
  gameId: string;
  round: number;
  teamId: string;
  role: RoundRole;
}

export type MontageStatus = "STAGED" | "PROMPTED" | "GENERATING" | "READY" | "FALLBACK";

/** One staged player sticker input in a team's montage ({@link MontageStateRow}). */
export interface MontageInput {
  itemId: string;
  promptRaw: string;
  subject: string;
  playerId: string;
  nickname: string;
  seq: number;
}

export interface MontageStateRow {
  id: string;
  teamId: string;
  round: number;
  seq: number;
  stagedInputs: MontageInput[];
  status: MontageStatus;
  promptText: string | null;
  imageUrl: string | null;
  imageSeq: number | null;
  fallbackUsed: boolean;
  updatedAt: number;
}

export interface AiCallRow {
  id: string;
  gameId: string | null;
  task: string;
  model: string;
  status: CallStatus;
  latencyMs: number;
  costUsd: number;
  usage: Record<string, unknown> | null;
  retries: number;
  fallbackUsed: boolean;
  error: string | null;
  createdAt: number;
}

/** Aggregated scores for one target team in one round. */
export interface ScoreAggregate {
  targetTeamId: string;
  count: number;
  avg: number;
  /** distribution[i] = number of scores with value i+1 (index 0..9). */
  distribution: number[];
}

/** Per-task AI usage statistics. */
export interface AiTaskStats {
  task: string;
  count: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  errorCount: number;
  fallbackCount: number;
}

/** Summary of AI calls for a game (cost tracking against aiBudgetUsd). */
export interface AiCallSummary {
  rows: AiCallRow[];
  perTask: AiTaskStats[];
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export interface GamePatch {
  phase?: Phase;
  round?: number;
  theme?: string | null;
  config?: CardConfig;
  style?: StyleDerivation | null;
  phaseEndsAt?: number | null;
  cutoffAt?: number | null;
  scoringOrder?: ScoringOrder | null;
}

export interface TeamPatch {
  name?: string;
  label?: string;
}

export interface PlayerPatch {
  nickname?: string;
  connected?: boolean;
}

export interface GreetingPatch {
  text?: string;
  status?: string;
  styleHint?: GreetingStyle | null;
}

export interface ItemPatch {
  subject?: string | null;
  status?: ItemStatus;
  imageUrl?: string | null;
  width?: number | null;
  height?: number | null;
  visualWeight?: number | null;
  contentBox?: ContentBox | null;
  failReason?: string | null;
  placedAt?: number | null;
}

export interface LayoutStatePatch {
  version: number;
  placements: Placement[];
  greetingStyle?: GreetingStyle | null;
  /** Persist the critique verdict without touching placements. */
  critique?: LayoutCritique | null;
  source: string;
}

export interface MontagePatch {
  status?: MontageStatus;
  promptText?: string | null;
  imageUrl?: string | null;
  imageSeq?: number | null;
  fallbackUsed?: boolean;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateGameInput {
  config: CardConfig;
  /** 6-char join code; generated when omitted. Must be globally unique. */
  code?: string;
}

export interface CreateTeamInput {
  gameId: string;
  name: string;
  label: string;
  joinToken: string;
}

export interface CreatePlayerInput {
  gameId: string;
  teamId: string;
  nickname: string;
  sessionToken: string;
  /** When true, a duplicate gameId+nickname becomes "Alex", "Alex 2", ... */
  autoSuffix?: boolean;
}

export interface CreateGreetingInput {
  teamId: string;
  round: number;
  text: string;
  status?: string;
  styleHint?: GreetingStyle | null;
}

export interface CreateItemInput {
  teamId: string;
  playerId: string;
  round: number;
  promptRaw: string;
  subject?: string | null;
  status?: ItemStatus;
}

export interface UpsertScoreInput {
  gameId: string;
  round: number;
  voterPlayerId: string;
  voterTeamId: string;
  targetTeamId: string;
  value: number;
  locked?: boolean;
}

export interface InsertWinnerPickInput {
  gameId: string;
  round: number;
  teamId: string;
  role: RoundRole;
}

export interface InsertAiCallInput {
  gameId?: string | null;
  task: string;
  model: string;
  status: CallStatus;
  latencyMs: number;
  costUsd?: number;
  usage?: Record<string, unknown> | null;
  retries?: number;
  fallbackUsed?: boolean;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface Repository {
  // -- Games ---------------------------------------------------------------

  /** Create a game with the given (or default) config and a unique code. */
  createGame(input: CreateGameInput): Promise<GameRow>;
  /** Fetch a game by id, or null. */
  getGame(id: string): Promise<GameRow | null>;
  /** Fetch a game by its 6-char join code, or null. */
  getGameByCode(code: string): Promise<GameRow | null>;
  /** All games (used by the timer service's boot reconciliation). */
  listGames(): Promise<GameRow[]>;
  /** Partial update of phase/round/theme/config/timers; returns the new row. */
  updateGame(id: string, patch: GamePatch): Promise<GameRow>;

  // -- Teams ---------------------------------------------------------------

  /** Create a team; throws when gameId+label already exists. */
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  /** All teams of a game, ordered by label. */
  listTeams(gameId: string): Promise<TeamRow[]>;
  /** Resolve a team by its QR join token, or null. */
  getTeamByJoinToken(token: string): Promise<TeamRow | null>;
  /** Partial update of team name/label. */
  updateTeam(id: string, patch: TeamPatch): Promise<TeamRow>;

  // -- Players ---------------------------------------------------------------

  /** Create a player; throws on duplicate gameId+nickname unless autoSuffix. */
  createPlayer(input: CreatePlayerInput): Promise<PlayerRow>;
  /** All nicknames ever used in a game (including kicked players — the DB
   *  unique [gameId, nickname] covers soft-deleted rows too); for auto-suffix. */
  findNicknames(gameId: string): Promise<string[]>;
  /** Resolve a player by id (kick authz, membership fallback), or null. */
  getPlayer(playerId: string): Promise<PlayerRow | null>;
  /** Resolve a player by their session token (auth), or null. */
  getPlayerBySessionToken(token: string): Promise<PlayerRow | null>;
  /** Number of ACTIVE (removedAt === null) players on a team — capacity checks. */
  countTeamMembers(teamId: string): Promise<number>;
  /** All ACTIVE (removedAt === null) players on a team, ordered by nickname. */
  listTeamPlayers(teamId: string): Promise<PlayerRow[]>;
  /** Mark a player connected/disconnected (presence). */
  setPlayerConnected(playerId: string, connected: boolean): Promise<PlayerRow>;
  /** Soft-kick: sets removedAt, keeps the row for history. */
  kickPlayer(playerId: string, now: number): Promise<PlayerRow>;

  // -- Greetings -------------------------------------------------------------

  /** Create the round's greeting for a team; throws on duplicate teamId+round. */
  createGreeting(input: CreateGreetingInput): Promise<GreetingRow>;
  /** Update text/status/styleHint for a team's round greeting. */
  updateGreeting(teamId: string, round: number, patch: GreetingPatch): Promise<GreetingRow>;
  /** All greetings of a game in a round (join through teams). */
  listGreetings(gameId: string, round: number): Promise<GreetingRow[]>;

  // -- Items -----------------------------------------------------------------

  /** Create a card item; throws on duplicate teamId+round+promptRaw+playerId. */
  createItem(input: CreateItemInput): Promise<ItemRow>;
  /** Fetch one item by id, or null (image worker status guard). */
  getItem(id: string): Promise<ItemRow | null>;
  /** Partial update (status transitions, image, placement metadata). */
  updateItem(id: string, patch: ItemPatch): Promise<ItemRow>;
  /** Items of a team in a round, optionally filtered by status set. */
  listItems(teamId: string, round: number, statuses?: ItemStatus[]): Promise<ItemRow[]>;

  // -- Layout ----------------------------------------------------------------

  /** Last-write-wins layout upsert keyed by teamId+round. */
  upsertLayoutState(teamId: string, round: number, patch: LayoutStatePatch): Promise<LayoutStateRow>;
  /** Current layout for a team+round, or null. */
  getLayoutState(teamId: string, round: number): Promise<LayoutStateRow | null>;

  // -- Montage ---------------------------------------------------------------

  /** Current montage state for a team+round, or null. */
  getMontageState(teamId: string, round: number): Promise<MontageStateRow | null>;
  /**
   * Create-if-missing / patch the montage row keyed by teamId+round.
   * When `init.input` is given, the input is atomically appended to
   * stagedInputs and `seq` is incremented in the same operation.
   */
  upsertMontageState(
    teamId: string,
    round: number,
    init: { input?: MontageInput; patch?: MontagePatch },
  ): Promise<MontageStateRow>;
  /** All montage rows of a game in a round (join through teams). */
  listMontageStates(gameId: string, round: number): Promise<MontageStateRow[]>;

  // -- Scores ----------------------------------------------------------------

  /**
   * Insert or overwrite the voter's score for a target team in a round
   * (unique: round+voterPlayerId+targetTeamId). Throws once scores are locked.
   */
  upsertScore(input: UpsertScoreInput): Promise<ScoreRow>;
  /** Persistently lock every Score row of a game+round (JUDGING entry);
   *  returns the number of rows locked. */
  lockScores(gameId: string, round: number): Promise<number>;
  /** True when any Score row of the game+round is locked (or the game phase
   *  implies locking — callers may combine this with a phase check). */
  areScoresLocked(gameId: string, round: number): Promise<boolean>;
  /** Score rows of a game+round, optionally only those targeting one team. */
  listScores(gameId: string, round: number, targetTeamId?: string): Promise<ScoreRow[]>;
  /** Per-target count/avg/distribution for a game+round. */
  aggregateScores(gameId: string, round: number): Promise<ScoreAggregate[]>;

  // -- Winner picks ------------------------------------------------------------

  /** Record JUDGING pick; throws on duplicate gameId+round+role. */
  insertWinnerPick(input: InsertWinnerPickInput): Promise<WinnerPickRow>;
  /** Winner picks of a game, optionally restricted to one round. */
  listWinnerPicks(gameId: string, round?: number): Promise<WinnerPickRow[]>;

  // -- AI calls ----------------------------------------------------------------

  /** Record one AI call (cost/latency/usage) for budget tracking. */
  insertAiCall(input: InsertAiCallInput): Promise<AiCallRow>;
  /** Rows + per-task stats + total cost for budget monitoring. */
  listAiCalls(gameId: string): Promise<AiCallSummary>;
}