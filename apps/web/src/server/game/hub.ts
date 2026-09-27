/**
 * GameHub — the IO layer of the game engine (Step 3).
 *
 * Owns:
 *  - the registry of live games (GameRuntimeState keyed by gameId), hydrated
 *    lazily from a Repository;
 *  - the event loop: `applyEvent` runs the PURE state-machine transition,
 *    persists phase-scoped changes (updateGame) and executes the resulting
 *    Effects (socket emits via RoomEmitter, timers via TimerService, item
 *    persistence for accepted prompts);
 *  - the player join flow (joinToken → team → nickname auto-suffix →
 *    sessionToken → player row), including team capacity enforcement;
 *  - a per-game monotonic `seq` counter stamped onto every outbound event
 *    envelope `{ gameId, round, ts, seq }` (in-memory, resets on hydrate —
 *    clients treat seq as an ordering hint within one connection session).
 *
 * Known Step-3 limitations (documented, resolved in later steps):
 *  - Team membership/capacity is enforced through the Repository
 *    (`countTeamMembers` excludes soft-removed players), so capacity and
 *    sync:full snapshots survive restarts and kicks. A small in-memory
 *    player cache (this.players) is only a read-through accelerator.
 *  - GM/presenter auth is "knows the game code" — fine for a local party
 *    game; a GM token on Game would require a schema change (README TODO).
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_CARD_CONFIG,
  MAX_TEAMS,
  MAX_TEAM_MEMBERS,
  type CardConfig,
} from "@cardcrafters/shared";

import { gameRoom, playerRoom, teamRoom } from "../ws/rooms";
import { RepoError } from "../repo/memory-repo";
import type { GamePatch, GameRow, PlayerRow, Repository, RoundRole, TeamRow } from "../repo/repository";
import { transition } from "./state-machine";
import { createInitialRuntimeState } from "./types";
import type { Effect, GameEvent, GameRuntimeState, TransitionResult } from "./types";
import { TimerService } from "./timer-service";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Anything that can receive room-scoped emits (Socket.IO Server satisfies this). */
export interface RoomEmitter {
  to(room: string): { emit(event: string, ...args: unknown[]): void };
}

export interface GameSetup {
  game: GameRow;
  teams: TeamRow[];
}

export interface JoinPlayerInput {
  /** QR/URL join token of the team (required for brand-new players). */
  joinToken?: string;
  /** Desired nickname; auto-suffixed ("Alex", "Alex 2", ...) on collision. */
  nickname?: string;
  /** Existing session token — reconnects the same player when it resolves. */
  sessionToken?: string;
}

export interface JoinPlayerResult {
  player: PlayerRow;
  team: TeamRow;
  game: GameRow;
  isNewPlayer: boolean;
}

// ---------------------------------------------------------------------------
// Team naming (pool of fun craft-themed names; edit freely)
// ---------------------------------------------------------------------------

/** Column labels A..J (MAX_TEAMS = 10). */
export const TEAM_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;

/** ≥20 craft-themed team names; assigned uniquely per game, in shuffled order. */
export const TEAM_NAME_POOL: readonly string[] = [
  "Team Papercraft",
  "The Glue Guns",
  "Ink & Imagination",
  "The Fold Cats",
  "Scissors & Sons",
  "Ribbon Riots",
  "Glitter Guild",
  "The Paper Trail",
  "Crayon Cartel",
  "The Washi Warriors",
  "Sticker Syndicate",
  "The Origami Order",
  "Bead Brigade",
  "Felt & Fabrications",
  "The Sequin Society",
  "Hole Punch Heroes",
  "Cut & Paste Club",
  "Emboss & Embellish",
  "The Stamp Collectors",
  "Marbled Marvels",
  "The Doodle Squad",
  "Paste & Circumstance",
];

/** Fisher–Yates copy, then take `count` unique names. */
function pickTeamNames(count: number, random: () => number = Math.random): string[] {
  const pool = [...TEAM_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  if (count > pool.length) throw new RepoError(`not enough team names for ${count} teams`);
  return pool.slice(0, count);
}

// ---------------------------------------------------------------------------
// Session token helpers
// ---------------------------------------------------------------------------

/** Fresh opaque session token (stored plaintext on the Player row). */
export function newSessionToken(): string {
  return randomUUID();
}

/** SHA-256 hex of a token — for comparing/storing token digests, never plaintext. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time token verification against a digest from `hashSessionToken`. */
export function verifySessionToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSessionToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// GameHub
// ---------------------------------------------------------------------------

export interface GameHubOptions {
  /** Injectable clock (epoch ms) — stamped into envelopes and events. */
  now?: () => number;
  /** Timer service override (tests); defaults to one wired back into this hub. */
  timers?: TimerService;
}

export class GameHub {
  /** Live runtime states, keyed by gameId. */
  private runtime = new Map<string, GameRuntimeState>();
  /** Per-game monotonic seq counter for outbound envelopes (resets on hydrate). */
  private seq = new Map<string, number>();
  /** Every player this hub instance created/rehydrated, by id (read-through
   *  cache; the Repository remains the source of truth for membership). */
  private players = new Map<string, PlayerRow>();
  /** Players this hub has observed as kicked (fast path for submit guards;
   *  unknown ids fall back to a repo lookup). */
  private kickedPlayers = new Set<string>();

  readonly timers: TimerService;

  private readonly now: () => number;

  constructor(
    private repo: Repository,
    private io: RoomEmitter,
    opts: GameHubOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.timers =
      opts.timers ??
      new TimerService((gameId, phase) => {
        void this.applyEvent(gameId, { type: "timer:expired", phase, now: this.now() }).catch(
          (err) => console.error(`[hub] timer:expired failed for ${gameId}:`, err),
        );
      }, { now: this.now });
  }

  // -- Game creation / hydration ---------------------------------------------

  /**
   * Create a game + `teamCount` teams with labels A.., unique joinTokens and
   * fun auto-generated names. Returns the full setup (game + teams).
   */
  async createGame(
    config: CardConfig = DEFAULT_CARD_CONFIG,
    opts: { teamCount?: number } = {},
  ): Promise<GameSetup> {
    const requested = opts.teamCount ?? 2;
    const teamCount = Math.min(Math.max(requested, 1), MAX_TEAMS);
    const game = await this.repo.createGame({ config });
    const names = pickTeamNames(teamCount);
    const teams: TeamRow[] = [];
    for (let i = 0; i < teamCount; i++) {
      const team = await this.repo.createTeam({
        gameId: game.id,
        name: names[i]!,
        label: TEAM_LABELS[i]!,
        joinToken: randomUUID(),
      });
      teams.push(team);
    }
    return { game, teams };
  }

  /** Load a game from the repo into the live registry (or return the cached state). */
  async hydrateGame(gameId: string): Promise<GameRuntimeState | null> {
    const game = await this.repo.getGame(gameId);
    if (!game) return null;
    // scoresLocked is not a Game column: it is restored from the phase
    // (JUDGING/REVEAL/RESULTS lock scores) and from locked Score rows.
    const phaseImpliesLock =
      game.phase === "JUDGING" || game.phase === "REVEAL" || game.phase === "RESULTS";
    const lockedRows = await this.repo.areScoresLocked(gameId, game.round);
    // Winner picks restore the round's announced winners.
    const picks = await this.repo.listWinnerPicks(gameId, game.round);
    const gmWinner = picks.find((p) => p.role === "GM_WINNER");
    const peoplesChoice = picks.find((p) => p.role === "PEOPLES_CHOICE");
    const state: GameRuntimeState = {
      ...createInitialRuntimeState(game.id, game.config),
      phase: game.phase,
      round: game.round,
      theme: game.theme ?? undefined,
      phaseEndsAt: game.phaseEndsAt ?? undefined,
      cutoffAt: game.cutoffAt ?? undefined,
      scoresLocked: phaseImpliesLock || lockedRows,
      ...(gmWinner ? { winnerTeamId: gmWinner.teamId } : {}),
      ...(peoplesChoice ? { peoplesChoiceTeamId: peoplesChoice.teamId } : {}),
    };
    this.runtime.set(gameId, state);
    this.seq.set(gameId, 0); // per-game seq resets on hydrate (documented)
    return state;
  }

  /** Hydrate-on-demand accessor; throws RepoError for unknown games. */
  async getOrCreateHubGame(gameId: string): Promise<GameRuntimeState> {
    const cached = this.runtime.get(gameId);
    if (cached) return cached;
    const state = await this.hydrateGame(gameId);
    if (!state) throw new RepoError(`game ${gameId} not found`);
    return state;
  }

  /** Snapshot of a live game's runtime state (hydrating first if needed). */
  async runtimeState(gameId: string): Promise<GameRuntimeState> {
    return this.getOrCreateHubGame(gameId);
  }

  // -- Event application -------------------------------------------------------

  /**
   * Run one GameEvent through the pure state machine, persist state changes
   * and execute the resulting Effects. Non-phase events (player:join,
   * player:submitPrompt guards) flow through here too. A rejected event
   * persists and emits NOTHING.
   */
  async applyEvent(gameId: string, event: GameEvent): Promise<TransitionResult> {
    const current = await this.getOrCreateHubGame(gameId);
    const result = transition(current, event);
    if (!result.ok) return result; // illegal → no persistence, no effects

    const next = result.state;
    // Persist only the fields that map onto the Game row.
    const patch: GamePatch = {};
    if (next.phase !== current.phase) patch.phase = next.phase;
    if (next.round !== current.round) patch.round = next.round;
    if ((next.theme ?? null) !== (current.theme ?? null)) patch.theme = next.theme ?? null;
    if ((next.phaseEndsAt ?? null) !== (current.phaseEndsAt ?? null)) {
      patch.phaseEndsAt = next.phaseEndsAt ?? null;
    }
    if ((next.cutoffAt ?? null) !== (current.cutoffAt ?? null)) {
      patch.cutoffAt = next.cutoffAt ?? null;
    }
    if (Object.keys(patch).length > 0) {
      await this.repo.updateGame(gameId, patch);
    }

    this.runtime.set(gameId, next);

    try {
      for (const effect of result.effects) {
        const outcome = await this.runEffect(gameId, next, effect);
        // An effect that cannot be completed (e.g. the submitting player has
        // vanished from the repo) surfaces as an event rejection so callers
        // (WS handlers) can ack ok:false instead of silently dropping work.
        if (outcome && outcome.ok === false) return outcome;
      }
    } catch (err) {
      console.error(`[hub] effect execution failed for ${gameId}:`, err);
      return { ok: false, reason: err instanceof RepoError ? err.message : "effect_failed" };
    }
    return result;
  }

  /**
   * Execute one Effect on behalf of the pure state machine. Returns
   * `{ ok: false, reason }` when the effect could not be completed (the event
   * is then reported as rejected); void on success.
   */
  private async runEffect(
    gameId: string,
    state: GameRuntimeState,
    effect: Effect,
  ): Promise<{ ok: false; reason: string } | void> {
    switch (effect.type) {
      case "emit":
        this.emitToRooms(gameId, state.round, effect.event, effect.payload, effect.rooms);
        return;
      case "startTimer":
        this.timers.arm(gameId, effect.phase, effect.endsAt);
        return;
      case "clearTimer":
        this.timers.clear(gameId);
        return;
      case "lockScores":
        // Persistently lock every Score row of the round at JUDGING entry;
        // the repo's upsertScore refuses writes for locked rounds.
        await this.repo.lockScores(gameId, state.round);
        return;
      case "setCutoff":
        // Already persisted via updateGame (state.cutoffAt diff, above).
        return;
      case "incrementRound":
        // Already persisted via updateGame (state.round diff, above).
        return;
      case "notify":
        this.emitToRooms(gameId, state.round, "notify", { playerId: effect.playerId, message: effect.message }, [
          playerRoom(gameId, effect.playerId),
        ]);
        return;
      case "announceWinner": {
        await this.persistWinnerPicks(gameId, state.round, effect.teamId, effect.peoplesChoiceTeamId);
        const teams = await this.repo.listTeams(gameId);
        const winner = teams.find((t) => t.id === effect.teamId);
        this.emitToRooms(
          gameId,
          state.round,
          "winnerAnnounced",
          {
            winnerTeamId: effect.teamId,
            label: winner?.label ?? null,
            ...(effect.peoplesChoiceTeamId ? { peoplesChoiceTeamId: effect.peoplesChoiceTeamId } : {}),
            revealToken: randomUUID(),
          },
          [gameRoom(gameId)],
        );
        return;
      }
      case "accept-submission":
        // ITEM CREATION OWNERSHIP (build-phase step 1): Item rows are created
        // by the prompt pipeline (../flows/prompt-pipeline.ts), NOT here. The
        // state machine still emits this effect so the BUILD phase + cutoff
        // guard remains the single phase authority — but persistence, AI
        // validation/moderation and item events live in the pipeline, which
        // is the ONE owner of item rows + item events.
        return;
      default: {
        const exhaustive: never = effect;
        void exhaustive;
        return;
      }
    }
  }

  /** Persist GM_WINNER (+ optional PEOPLES_CHOICE) picks, idempotently. */
  private async persistWinnerPicks(
    gameId: string,
    round: number,
    winnerTeamId: string,
    peoplesChoiceTeamId?: string,
  ): Promise<void> {
    const existing = await this.repo.listWinnerPicks(gameId, round);
    const has = (role: RoundRole) => existing.some((p) => p.role === role);
    if (!has("GM_WINNER")) {
      await this.repo.insertWinnerPick({ gameId, round, teamId: winnerTeamId, role: "GM_WINNER" });
    }
    if (peoplesChoiceTeamId && !has("PEOPLES_CHOICE")) {
      await this.repo.insertWinnerPick({
        gameId,
        round,
        teamId: peoplesChoiceTeamId,
        role: "PEOPLES_CHOICE",
      });
    }
  }

  // -- Player join flow ---------------------------------------------------------

  /**
   * Join (or rejoin) a player. Reconnection happens when a sessionToken
   * resolves to a live player of the target game; otherwise joinToken +
   * nickname are required. Enforces the 12-per-team capacity cap and the
   * "new players only in LOBBY" phase guard.
   */
  async joinPlayer(input: JoinPlayerInput): Promise<JoinPlayerResult> {
    // 1) Reconnect by session token.
    if (input.sessionToken) {
      const existing = await this.repo.getPlayerBySessionToken(input.sessionToken);
      if (existing && existing.removedAt === null) {
        const team = await this.teamOf(existing);
        const game = await this.repo.getGame(existing.gameId);
        if (!team || !game) throw new RepoError("stale session: game or team no longer exists");
        await this.repo.setPlayerConnected(existing.id, true);
        await this.applyEvent(existing.gameId, {
          type: "player:join",
          playerId: existing.id,
          isNewPlayer: false,
          now: this.now(),
        });
        const player = { ...existing, connected: true };
        this.registerPlayer(player);
        this.emitToRooms(
          game.id,
          game.round,
          "player:joined",
          {
            playerId: player.id,
            nickname: player.nickname,
            teamId: team.id,
            teamLabel: team.label,
            isNewPlayer: false,
          },
          [gameRoom(game.id)],
        );
        return { player, team, game, isNewPlayer: false };
      }
    }

    // 2) Brand-new player: validate the join token → team.
    if (!input.joinToken) throw new RepoError("joinToken required");
    const team = await this.repo.getTeamByJoinToken(input.joinToken);
    if (!team) throw new RepoError("invalid joinToken");
    const game = await this.repo.getGame(team.gameId);
    if (!game) throw new RepoError("game not found for team");
    const state = await this.getOrCreateHubGame(team.gameId);

    // Capacity: at most MAX_TEAM_MEMBERS (12) non-removed players per team,
    // counted from the REPOSITORY so restarts and kicks are reflected.
    const memberCount = await this.repo.countTeamMembers(team.id);
    if (memberCount >= MAX_TEAM_MEMBERS) {
      throw new RepoError(`team ${team.label} is full (max ${MAX_TEAM_MEMBERS})`);
    }

    // Phase guard: brand-new players may only enter during LOBBY. Dry-run the
    // pure transition before creating anything; the follow-up applyEvent below
    // is an idempotent no-op transition (state unchanged, no effects).
    const guard = transition(state, {
      type: "player:join",
      playerId: "",
      isNewPlayer: true,
      now: this.now(),
    });
    if (!guard.ok) throw new RepoError(guard.reason);

    // 3) Create the player (nickname auto-suffix handled by the repo).
    const player = await this.repo.createPlayer({
      gameId: team.gameId,
      teamId: team.id,
      nickname: input.nickname ?? "Player",
      sessionToken: newSessionToken(),
      autoSuffix: true,
    });
    const connected = await this.repo.setPlayerConnected(player.id, true);
    await this.applyEvent(team.gameId, {
      type: "player:join",
      playerId: player.id,
      isNewPlayer: true,
      now: this.now(),
    });

    this.registerPlayer(connected);
    this.emitToRooms(
      game.id,
      state.round,
      "player:joined",
      {
        playerId: player.id,
        nickname: connected.nickname,
        teamId: team.id,
        teamLabel: team.label,
        isNewPlayer: true,
      },
      [gameRoom(game.id)],
    );
    return { player: connected, team, game, isNewPlayer: true };
  }

  /** Mark a player disconnected (socket left) and broadcast player:left. */
  async markPlayerDisconnected(playerId: string): Promise<PlayerRow | null> {
    const known = this.players.get(playerId);
    try {
      const row = await this.repo.setPlayerConnected(playerId, false);
      this.players.set(playerId, row);
      this.emitToRooms(
        row.gameId,
        this.runtime.get(row.gameId)?.round ?? 1,
        "player:left",
        { playerId, nickname: row.nickname },
        [gameRoom(row.gameId)],
      );
      return row;
    } catch (err) {
      if (err instanceof RepoError) return known ?? null;
      throw err;
    }
  }

  // -- Membership / snapshots ------------------------------------------------------

  /**
   * Players on a team, resolved through the Repository (excludes soft-removed
   * players). The in-memory cache is only a fast path for known players.
   */
  async listTeamMembers(teamId: string): Promise<PlayerRow[]> {
    return this.repo.listTeamPlayers(teamId);
  }

  /**
   * Soft-kick a player: repo row kept (removedAt), presence cleared,
   * `player:left {reason:'kick'}` broadcast to the game room. The WS layer
   * additionally force-disconnects the victim's sockets.
   */
  async kickPlayer(playerId: string): Promise<PlayerRow> {
    const kicked = await this.repo.kickPlayer(playerId, this.now());
    this.kickedPlayers.add(playerId);
    this.players.set(playerId, kicked);
    this.emitToRooms(
      kicked.gameId,
      this.runtime.get(kicked.gameId)?.round ?? 1,
      "player:left",
      { playerId, nickname: kicked.nickname, reason: "kick" },
      [gameRoom(kicked.gameId)],
    );
    return kicked;
  }

  /**
   * Whether a player has been kicked: checked against the in-memory kicked
   * set first, falling back to a repo lookup (with caching) for unknown ids.
   */
  async isKicked(playerId: string): Promise<boolean> {
    if (this.kickedPlayers.has(playerId)) return true;
    try {
      const row = await this.repo.getPlayer(playerId);
      if (row?.removedAt != null) {
        this.kickedPlayers.add(playerId);
        return true;
      }
    } catch {
      // unknown player → not kicked
    }
    return false;
  }

  /** Resolve a player by session token (used by the WS auth layer). */
  async playerBySessionToken(token: string): Promise<PlayerRow | null> {
    return this.repo.getPlayerBySessionToken(token);
  }

  /** Look up a game by its 6-char code, hydrating it into the registry. */
  async gameByCode(code: string): Promise<GameRow | null> {
    const game = await this.repo.getGameByCode(code);
    if (game) await this.getOrCreateHubGame(game.id);
    return game;
  }

  /**
   * Next envelope for a DIRECT (socket-only) emit such as sync:full.
   * Room-scoped emits are stamped inside emitToRooms.
   */
  stamp(gameId: string): { gameId: string; round: number; ts: number; seq: number } {
    const seq = (this.seq.get(gameId) ?? 0) + 1;
    this.seq.set(gameId, seq);
    return { gameId, round: this.runtime.get(gameId)?.round ?? 1, ts: this.now(), seq };
  }

  /** Graceful shutdown: no timers left behind. */
  shutdown(): void {
    this.timers.clearAll();
  }

  // -- internals ------------------------------------------------------------

  private registerPlayer(player: PlayerRow): void {
    this.players.set(player.id, player);
  }

  private async teamOf(player: PlayerRow): Promise<TeamRow | null> {
    const teams = await this.repo.listTeams(player.gameId);
    return teams.find((t) => t.id === player.teamId) ?? null;
  }

  /** Emit `event` to every room with the standard `{gameId, round, ts, seq}` envelope. */
  private emitToRooms(
    gameId: string,
    round: number,
    event: string,
    payload: Record<string, unknown>,
    rooms: string[],
  ): Record<string, unknown> {
    const stamped = this.stamp(gameId);
    // Prefer the live round over the caller-supplied one.
    const enveloped = {
      ...payload,
      gameId,
      round: this.runtime.get(gameId)?.round ?? round,
      ts: stamped.ts,
      seq: stamped.seq,
    };
    for (const room of rooms) {
      this.io.to(room).emit(event, enveloped);
    }
    return enveloped;
  }
}

// Re-export for convenience of higher layers (server.ts wiring).
export type { GameEvent, GameRuntimeState, TransitionResult };
