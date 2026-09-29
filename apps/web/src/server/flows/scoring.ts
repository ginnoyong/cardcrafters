/**
 * Scoring flows — the bridge between the game engine (GameHub), the
 * repository and the WS layer for the SCORING phase.
 *
 * Responsibilities:
 *  - submitScore: the ONE owner of score writes during SCORING. Runs the
 *    guards in a fixed order (phase → kicked → scoring order/card → own-card
 *    → duplicate → lock) and, on success, broadcasts the anonymous running
 *    averages via hub.emitScoresUpdate.
 *  - pickPeoplesChoice: pure helper for the JUDGING handler — computes the
 *    People's Choice team from the round's aggregates (avg desc → count desc
 *    → label asc); null when nobody has scored yet.
 *
 * Privacy contract: a player only ever knows cardIds ("card-a"…), never the
 * card↔team mapping (except their OWN card, by construction of
 * `scoring:started`). The scores:update broadcast therefore carries ONLY
 * {cardId, avg, count} — never teamId.
 */

import { PHASE, type ScoringCard } from "@cardcrafters/shared";

import { RepoError } from "../repo/memory-repo";
import type { GameHub } from "../game/hub";
import type { Repository, ScoreAggregate, ScoreRow, TeamRow } from "../repo/repository";

/** One guarded submit outcome (mirrors prompt-pipeline's result shape). */
export type ScoreSubmitResult =
  | { ok: true; score: ScoreRow }
  | {
      ok: false;
      stage: "phase" | "kicked" | "unknown_card" | "own_card" | "already_rated" | "locked";
      error: string;
    };

export interface SubmitScoreInput {
  gameId: string;
  playerId: string;
  /** Anonymous card id ("card-a"…) — resolved to the target team here. */
  cardId: string;
  /** 1..10 (validated upstream by scoreSubmitSchema). */
  score: number;
}

/**
 * Submit one score for an anonymous card.
 *
 * Guard order (each rejection returns immediately, nothing is persisted):
 *  1. phase — scoring is only open during SCORING (hub.runtimeState);
 *  2. kicked — soft-kicked players must not mutate the game;
 *  3. scoring order — Game.scoringOrder must exist AND match the current
 *     round (stale orders are ignored), and the cardId must resolve;
 *  4. own card — card.teamId !== player.teamId (repo.getPlayer);
 *  5. duplicate — voter+target already has a row → "already_rated"
 *     (upsertScore itself overwrites by design for other callers; the
 *     explicit guard gives players a clear "you already rated" signal);
 *  6. lock — repo.upsertScore throws scores_locked once the round is frozen
 *     (defensive: the phase guard usually refuses first);
 *  7. success — hub.emitScoresUpdate broadcasts the running averages.
 */
export async function submitScore(
  deps: { hub: GameHub; repo: Repository },
  input: SubmitScoreInput,
): Promise<ScoreSubmitResult> {
  const { hub, repo } = deps;

  // 1) Phase guard — the hub's live runtime state is the phase authority.
  const state = await hub.runtimeState(input.gameId);
  if (state.phase !== PHASE.SCORING) {
    return {
      ok: false,
      stage: "phase",
      error: `scoring is only open during SCORING (current: ${state.phase})`,
    };
  }

  // 2) Kicked guard.
  if (await hub.isKicked(input.playerId)) {
    return { ok: false, stage: "kicked", error: "you were removed from this game" };
  }

  // 3) Scoring order + card resolution (round must match — no stale orders).
  const game = await repo.getGame(input.gameId);
  const order = game?.scoringOrder;
  if (!order || order.round !== state.round) {
    return { ok: false, stage: "unknown_card", error: "no scoring is running for this round" };
  }
  const card: ScoringCard | undefined = order.cards.find((c) => c.cardId === input.cardId);
  if (!card) {
    return { ok: false, stage: "unknown_card", error: `unknown card ${input.cardId}` };
  }

  // 4) Own-card guard.
  const player = await repo.getPlayer(input.playerId);
  if (!player || player.removedAt !== null) {
    // A vanished/removed player is treated as kicked (fail closed).
    return { ok: false, stage: "kicked", error: "you are not part of this game" };
  }
  if (card.teamId === player.teamId) {
    return { ok: false, stage: "own_card", error: "you cannot rate your own card" };
  }

  // 5) Duplicate guard — one score per (voter, target) pair.
  const existing = await repo.listScores(input.gameId, state.round);
  if (existing.some((s) => s.voterPlayerId === input.playerId && s.targetTeamId === card.teamId)) {
    return { ok: false, stage: "already_rated", error: "you already rated this card" };
  }

  // 6) Persist (the repo refuses writes for locked rounds).
  let score: ScoreRow;
  try {
    score = await repo.upsertScore({
      gameId: input.gameId,
      round: state.round,
      voterPlayerId: input.playerId,
      voterTeamId: player.teamId,
      targetTeamId: card.teamId,
      value: input.score,
    });
  } catch (err) {
    if (err instanceof RepoError && /scores_locked/.test(err.message)) {
      return { ok: false, stage: "locked", error: "scoring has closed for this round" };
    }
    throw err;
  }

  // 7) Broadcast the anonymous running averages to the game room.
  await hub.emitScoresUpdate(input.gameId);
  return { ok: true, score };
}

/**
 * People's Choice: the team with the best crowd score.
 *
 * Only teams with at least one score count; ties break avg desc → count
 * desc → label asc. Returns the team row (or null when nobody has scored).
 */
export function pickPeoplesChoice(
  aggregates: ScoreAggregate[],
  teams: TeamRow[],
): TeamRow | null {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const candidates = aggregates
    .filter((a) => a.count > 0 && byId.has(a.targetTeamId))
    .map((a) => ({ team: byId.get(a.targetTeamId)!, avg: a.avg, count: a.count }));
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => {
    if (y.avg !== x.avg) return y.avg - x.avg;
    if (y.count !== x.count) return y.count - x.count;
    return x.team.label.localeCompare(y.team.label);
  });
  return candidates[0]!.team;
}