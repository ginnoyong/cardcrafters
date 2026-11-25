"use client";

/**
 * Presenter view — team cards (name, label, phase, timer, greeting — no
 * join QR: players join via the GM console, the QR is a GM-only concern)
 * plus a LIVE card grid: one read-only CardCanvas mini per team, fed by
 * the store's build-phase events (item:pending / item:ready /
 * layout:updated — the presenter socket joins every team room).
 *
 * Scoring/results phases (big-screen duty) — ALL of them render the SAME
 * unified side-by-side layout (components/PresenterTeamStage.tsx: AI-montage
 * poster + sticker CardCanvas from the client snapshot, so a 0-prompt team
 * shows its greeting + the phase-aware finished note instead of a blank
 * card):
 *  - SCORING: a LABEL-IDENTITY single-card stage — one card at a time with
 *    wrap-around prev/next and a live tally ("Card B · 7.5 avg · 3
 *    votes"); the team stage is suppressed (cycling team→card side by side
 *    would leak the card↔team mapping — server-side rule), and real team
 *    names are GM-only: players and the presenter get label identity only
 *    (cardId + "Card A"-style label, never teamName/teamId during SCORING).
 *    The card's team is resolved from the snapshot (prefer card.teamId —
 *    present from JUDGING onward; else a LABEL-LETTER match, "Card A" →
 *    team.label "A") and rendered via PresenterTeamStage with the prompt
 *    accordions SUPPRESSED (prompts are still anonymous during SCORING);
 *    the old flip-<img> PNG stage survives only as a defensive fallback
 *    when the team lookup misses (snapshot race / team removed).
 *  - JUDGING: PresenterTeamStage with the live tally chip and the prompt
 *    accordions ENABLED (promptText is public from JUDGING); Pick winner +
 *    Return ride the stage header's actions row.
 *  - REVEAL/RESULTS: PresenterTeamStage with per-viewed-team banners: the
 *    brass "🏆 WINNER" banner only when the viewed team IS the winner, the
 *    sage "👏 Crowd Favourite" banner only when it is the People's Choice.
 *    REVEAL adds "Add 30 more seconds" (reveal:extend) and "Show results"
 *    (reveal:ack — the server allows GM OR presenter; the hub also
 *    auto-expires REVEAL after 30 s, the button just moves things along) to
 *    the stage header; both phases add a Return button back to the GM
 *    console. RESULTS keeps the public standings list (shared
 *    components/Standings.tsx, fed by the winnerAnnounced payload) below
 *    the stage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W, MAX_TEAM_MEMBERS, PHASE } from "@cardcrafters/shared";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});

import {
  createGameSocket,
  emitAck,
  friendlyJoinError,
  joinPayload,
  onEvent,
  type AckResult,
} from "@/lib/socket";
import {
  resolvePresenterCardIndex,
  resolvePresenterCardTeam,
} from "@/lib/presenter-focus";
import { sortByTeamLabel } from "@/lib/team-label-sort";
import { StandingsList } from "@/components/Standings";
import PresenterTeamStage from "@/components/PresenterTeamStage";
import { GameStoreProvider, phaseLabel, useGameStore, type SyncFullEvent, type ClientScoringCard, type ClientTeam } from "@/lib/store";

function useCountdown(phaseEndsAt: number | null, serverNow: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  const driftRef = useRef(Date.now() - serverNow);
  useEffect(() => {
    if (phaseEndsAt === null) {
      setRemaining(null);
      return;
    }
    driftRef.current = Date.now() - serverNow;
    const tick = () => {
      const left = Math.max(0, phaseEndsAt - (Date.now() - driftRef.current));
      setRemaining(Math.ceil(left / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phaseEndsAt, serverNow]);
  return remaining;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PresenterBoard({
  code,
  focusCardId,
  focusTeamId: initialFocusTeamId,
}: {
  code: string;
  /** Deep-link focus (GM "View" → /present/<code>?card=<cardId>): once the
   *  snapshot's scoring cards land, the SCORING carousel jumps to this card
   *  and JUDGING+ latches the stage onto its team. Unknown ids are ignored
   *  (the default first card / plain stage cycle applies). */
  focusCardId?: string;
  /** Legacy team-level deep link (?team=<id>): the stage latches onto this
   *  team once the snapshot lands. */
  focusTeamId?: string;
}) {
  const { snapshot, dispatch } = useGameStore();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live socket ref — the REVEAL "Show results" button emits reveal:ack over
  // the SAME socket the board joined with.
  const socketRef = useRef<ReturnType<typeof createGameSocket> | null>(null);

  useEffect(() => {
    const socket = createGameSocket({ role: "presenter", gameCode: code });
    socketRef.current = socket;
    const unsubscribers: Array<() => void> = [];

    socket.on("connect", () => {
      void emitAck<AckResult>(socket, "join", joinPayload({ role: "presenter", joinToken: code })).then(
        (ack) => {
          if (ack.ok) setConnected(true);
          else setError(ack.error);
        },
      );
    });

    unsubscribers.push(
      onEvent<SyncFullEvent>(socket, "sync:full", (payload) => {
        dispatch({ type: "sync:full", snapshot: payload });
      }),
      onEvent<Record<string, unknown>>(socket, "phaseChanged", (payload) =>
        dispatch({ type: "phaseChanged", payload }),
      ),
      onEvent<{ playerId: string; nickname: string; teamId: string }>(socket, "player:joined", (p) =>
        dispatch({ type: "playerJoined", playerId: p.playerId, nickname: p.nickname, teamId: p.teamId }),
      ),
      onEvent<{ playerId: string; reason?: string }>(socket, "player:left", (p) =>
        dispatch({ type: "playerLeft", playerId: p.playerId, kicked: p.reason === "kick" }),
      ),
      // Live greeting updates so team cards show text as soon as it lands.
      onEvent<{ teamId: string; text: string; status: string; round?: number }>(
        socket,
        "greeting:updated",
        (p) => dispatch({ type: "greetingUpdated", teamId: p.teamId, text: p.text, status: p.status, round: p.round }),
      ),
      // Build-phase events (presenter joins every team room). GM-only events
      // and mySubmitted don't exist for the presenter.
      onEvent<Record<string, unknown>>(socket, "item:pending", (payload) =>
        dispatch({ type: "itemPending", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "item:ready", (payload) =>
        dispatch({ type: "itemReady", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "layout:updated", (payload) =>
        dispatch({ type: "layoutUpdated", payload }),
      ),
      // Montage (poster) accumulator — the presenter screen shows the same
      // per-team status as the GM (generating indicator / finished poster).
      onEvent<Record<string, unknown>>(socket, "montage:generating", (payload) =>
        dispatch({ type: "montageGenerating", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "montage:updated", (payload) =>
        dispatch({ type: "montageUpdated", payload }),
      ),
      // NOTE: no item:rejected / item:failed listeners here — those events
      // are OWNER-ONLY (emitted directly to the submitting player's sockets)
      // and never reach the presenter.
      // -------------------------------------------------------------------
      // Scoring/results events. The presenter's scoring:started carries
      // LABEL-IDENTITY cards (cardId + "Card A"-style labels; never teamId
      // during SCORING, and no yourTeamCardId for this surface); scores:update
      // rides the whole game room (anonymous per-card tallies);
      // winnerAnnounced carries the winner + People's Choice + public
      // standings for the results board.
      // -------------------------------------------------------------------
      onEvent<Record<string, unknown>>(socket, "scoring:started", (payload) =>
        dispatch({ type: "scoringStarted", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "scores:update", (payload) =>
        dispatch({ type: "scoresUpdated", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "winnerAnnounced", (payload) =>
        dispatch({ type: "winnerAnnounced", payload }),
      ),
    );

    socket.connect();
    return () => {
      for (const off of unsubscribers) off();
      socket.close();
      socketRef.current = null;
    };
  }, [code, dispatch]);

  // REVEAL → RESULTS via reveal:ack ("Show results" button). The server
  // allows GM OR presenter; failure surfaces once in the banner (the hub's
  // 30 s auto-expiry still moves the game to RESULTS as a backstop).
  const showResults = useCallback(async (): Promise<void> => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      const ack = await emitAck<AckResult>(socket, "reveal:ack", {});
      if (!ack.ok) setError(ack.error ?? "Could not show the results yet.");
    } catch {
      setError("Could not reach the game server — please try again.");
    }
  }, []);

  // Return to the GM console — shared by EVERY presenter phase's Return
  // button (scoring stage, JUDGING/REVEAL/RESULTS stage headers).
  // history.length is
  // unreliable for a fresh _blank tab (Chromium reports 2 for the initial
  // about:blank entry, so back() can land on a blank page) — the coded GM
  // URL is the deterministic path back.
  const returnToGm = useCallback((): void => {
    window.location.assign(`/gm?code=${encodeURIComponent(code)}`);
  }, [code]);

  // Keep the reveal on screen for another 30 s (reveal:extend — same socket,
  // same ack shape as reveal:ack; the server only honours it during REVEAL).
  const extendReveal = useCallback(async (): Promise<void> => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      const ack = await emitAck<AckResult>(socket, "reveal:extend", {});
      if (!ack.ok) setError(ack.error ?? "Could not extend the reveal.");
    } catch {
      setError("Could not reach the game server — please try again.");
    }
  }, []);

  // One-at-a-time stage (SCORING onward): which team's showcase fills the
  // screen. Wrap-around prev/next; the index clamps when the team count
  // shrinks (a team leaves / round reset) so the stage never shows empty.
  // The cycle runs over a LABEL-SORTED COPY of the snapshot teams
  // (compareTeamLabels order: A → B → …) so the big-screen stage order is
  // identity-stable even when the raw snapshot array order drifts (the
  // server's shuffled scoring order / multi-round resets). Pure copy —
  // snapshot.teams itself is never mutated; the winner-latch effect below is
  // unaffected (it latches on team id, not array position).
  const stageTeams = useMemo(
    () => (snapshot ? sortByTeamLabel(snapshot.teams) : []),
    [snapshot],
  );
  const teamCount = stageTeams.length;
  const [stageIndex, setStageIndex] = useState(0);
  // Judging: pending flag while the Pick winner ack is in flight (prevents
  // double-picks from rapid clicks; the phase change to REVEAL unmounts the
  // button anyway).
  const [pickingWinner, setPickingWinner] = useState(false);
  // Focus latch (?team=<id> deep link from the GM judging "View" link): once
  // the snapshot lands and the focused team exists, the stage renders THAT
  // team regardless of stageIndex — latched, i.e. it stays put while
  // phase-driven re-renders would otherwise keep stageIndex's pick on
  // screen. The latch only engages while the team exists (a round reset can
  // drop it → plain stageIndex logic resumes). Cycling hands control back to
  // stageIndex: stepStage clears the latch and jumps stageIndex to the
  // focused team's neighbour, so the next step continues from the team
  // actually on screen instead of wherever stageIndex was left.
  const [focusTeamId, setFocusTeamId] = useState<string | null>(initialFocusTeamId ?? null);

  // Phase-entry latch rules:
  //  - Entering REVEAL/RESULTS with a winner set → latch onto the WINNING
  //    team so the big screen opens the next phase on the winning card
  //    (whether the pick happened here or on the GM console). If the viewed
  //    team is ALSO the crowd favourite, the banner block stacks naturally.
  //  - Otherwise (entering any other phase with a latch): clear it — a
  //    latched team must not survive a phase change (review L3).
  //  - Fresh page load directly in REVEAL/RESULTS with a winner and NO
  //    deep-link latch → open on the winner too.
  // Cycling (stepStage) clears the latch and hands control back to the
  // plain cycle; the effect never re-pins after that (it only fires on
  // phase-entry transitions).
  const latchPhaseRef = useRef<string | null>(null);
  const latchPhaseArmed = useRef(false);
  useEffect(() => {
    const phase = snapshot?.phase ?? null;
    const isResults = phase === PHASE.REVEAL || phase === PHASE.RESULTS;
    const winnerId = snapshot?.winnerTeamId ?? null;
    const entering = latchPhaseRef.current !== null && latchPhaseRef.current !== phase;

    if (entering && isResults && winnerId) {
      setFocusTeamId(winnerId);
    } else if (entering && focusTeamId) {
      setFocusTeamId(null);
    } else if (!latchPhaseArmed.current && phase !== null && isResults && winnerId && !focusTeamId) {
      // Fresh page load directly in REVEAL/RESULTS with no deep-link latch —
      // open on the winner.
      setFocusTeamId(winnerId);
      latchPhaseArmed.current = true;
    }
    if (!latchPhaseArmed.current && phase !== null) latchPhaseArmed.current = true;
    latchPhaseRef.current = phase;
  }, [snapshot?.phase, snapshot?.winnerTeamId, focusTeamId]);

  const clampedStageIndex = teamCount > 0 ? Math.min(stageIndex, teamCount - 1) : 0;
  const focusedIndex = focusTeamId
    ? (stageTeams.findIndex((t) => t.id === focusTeamId))
    : -1;
  const latched = focusedIndex >= 0;
  const stageTeam = stageTeams[latched ? focusedIndex : clampedStageIndex] ?? null;
  // JUDGING: the viewed team's scoring card + live tally (the mapping is
  // public on this stage surface — card.teamId rides the payload from
  // JUDGING onward).
  const judgingCard: ClientScoringCard | null =
    snapshot && stageTeam
      ? (snapshot.scoring?.cards.find((c) => c.teamId === stageTeam.id) ?? null)
      : null;
  const judgingTally = judgingCard ? (snapshot!.scores[judgingCard.cardId] ?? null) : null;
  // SCORING is EXCLUDED from the team stage: cycling team→card side by side
  // would reveal which team made which card while the room is rating. SCORING
  // renders the anonymous single-card stage below instead (JUDGING/REVEAL/
  // RESULTS only here).
  const showStage =
    !!snapshot &&
    !!stageTeam &&
    [PHASE.JUDGING, PHASE.REVEAL, PHASE.RESULTS].includes(
      snapshot.phase as (typeof PHASE)[keyof typeof PHASE],
    );
  const stepStage = useCallback(
    (delta: number) => {
      // Latch hand-off (see focusTeamId above): clear the latch and jump
      // stageIndex relative to the focused team. If the focused team is gone
      // (round reset), just clear the latch and let the plain cycle run.
      if (focusTeamId) {
        const idx = stageTeams.findIndex((t) => t.id === focusTeamId);
        setFocusTeamId(null);
        if (idx >= 0) {
          if (teamCount > 0) setStageIndex((idx + delta + teamCount) % teamCount);
          return;
        }
      }
      setStageIndex((i) => {
        if (teamCount <= 0) return 0;
        const base = Math.min(i, teamCount - 1);
        return (base + delta + teamCount) % teamCount;
      });
    },
    [teamCount, focusTeamId, stageTeams],
  );

  // -----------------------------------------------------------------------
  // SCORING: anonymous single-card stage. One card at a time (poster-first
  // flip view), wrap-around prev/next, live tally underneath — the team
  // stage above is suppressed during SCORING (names would leak the
  // card↔team mapping).
  // -----------------------------------------------------------------------
  const scoringCards = snapshot?.scoring?.cards ?? [];
  const scoringCount = scoringCards.length;
  const [scoringCardIndex, setScoringCardIndex] = useState(0);
  // Clamp when the card count shrinks (round reset / scoring aborted); the
  // wrap-around steps below keep the index in range otherwise.
  const clampedScoringIndex = scoringCount > 0 ? Math.min(scoringCardIndex, scoringCount - 1) : 0;
  const scoringCard = scoringCards[clampedScoringIndex] ?? null;
  // Label identity — real team names are GM-only; the presenter shows the
  // card's public label ("Card A"…).
  const scoringCardName = scoringCard ? scoringCard.label : null;
  // cardId → team lookup for the unified side-by-side stage: prefer
  // card.teamId (the mapping rides the presenter payload from JUDGING
  // onward, e.g. after a JUDGING resync), else match the card's LABEL
  // SUFFIX against the team label ("Card A" → team.label "A") — label
  // identity is stable per round (buildScoringOrder pins card letters to
  // team letters), so the match is exact and leaks nothing. Null when
  // neither resolves (snapshot race / team removed) → the defensive PNG
  // <img> fallback below keeps the stage from ever going blank.
  const scoringCardTeam: ClientTeam | null = (() => {
    if (!snapshot || !scoringCard) return null;
    if (scoringCard.teamId) {
      const byId = snapshot.teams.find((t) => t.id === scoringCard.teamId);
      if (byId) return byId;
    }
    // Label-letter match: "Card A" (or a bare "A") → team.label === "A".
    const m = /^(?:Card\s+)?([A-Za-z])$/.exec(scoringCard.label.trim());
    if (m) {
      const byLabel = snapshot.teams.filter((t) => t.label === m[1]!.toUpperCase());
      if (byLabel.length === 1) return byLabel[0]!;
    }
    return null;
  })();
  const stepScoringCard = useCallback(
    (delta: number) => {
      setScoringCardIndex((i) => {
        if (scoringCount <= 0) return 0;
        const base = Math.min(i, scoringCount - 1);
        return (base + delta + scoringCount) % scoringCount;
      });
    },
    [scoringCount],
  );

  // -----------------------------------------------------------------------
  // Card-level deep link (?card=<cardId> from the GM judge boxes). Once the
  // snapshot's scoring cards land (they come with the first sync), resolve
  // the param ONCE against the CURRENT phase's stage:
  //  - SCORING → position the anonymous card carousel on the card. The
  //    scoring order is shuffled per game+round, so the cardId must be
  //    matched against the snapshot's own order (an index-based link would
  //    show the wrong team).
  //  - JUDGING/REVEAL/RESULTS → latch the team stage onto the card's team
  //    (teamId rides the presenter payload from JUDGING onward; a label-
  //    letter match — "Card A" → team.label "A" — is the fallback).
  // Unknown or stale ids are ignored: the stage keeps its default
  // positioning (first card / plain cycle). One-shot per param value, so
  // later manual stepping or syncs never snap the stage back.
  const focusAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusCardId || !snapshot) return;
    if (focusAppliedRef.current === focusCardId) return;
    const cards = snapshot.scoring?.cards ?? [];
    if (cards.length === 0) return;
    focusAppliedRef.current = focusCardId;

    if (snapshot.phase === PHASE.SCORING) {
      const idx = resolvePresenterCardIndex(cards, focusCardId, 0);
      if (cards[idx]?.cardId === focusCardId) setScoringCardIndex(idx);
    } else {
      const team = resolvePresenterCardTeam(cards, focusCardId, snapshot.teams);
      if (team) setFocusTeamId(team.id);
    }
  }, [focusCardId, snapshot]);

  return (
    <main className="cc-main">
      <header className="cc-header">
        <h1>
          Card Crafters — <span className="cc-code">{code}</span>
        </h1>
        <span className="cc-dot" role="status" aria-label={connected ? "connected" : "disconnected"}>
          {connected ? "● live" : "○ connecting…"}
        </span>
      </header>
      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}
      {!connected ? <p className="cc-hint">Connecting…</p> : null}

      {/* BUILD (and the pre-build LOBBY/GREETINGS phases): live card grid —
          one read-only mini canvas per team, right under the team overview
          cards (greeting + empty canvas; live items + layout). From SCORING
          onward this grid is REPLACED: SCORING by the anonymous scoring
          stage below, JUDGING/REVEAL/RESULTS by the one-at-a-time stage. */}
      {snapshot && snapshot.teams.length > 0 && !showStage && snapshot.phase !== PHASE.SCORING ? (
        <section aria-label="live cards" className="cc-mini-grid">
          {snapshot.teams.map((team) => {
            const readyCount = team.items.filter((i) => i.status === "ready").length;
            return (
              <div key={team.id} className="cc-mini" aria-label={`live preview of Team ${team.label}'s card`}>
                <h3>
                  {`Team ${team.label}`}
                </h3>
                <CardCanvas
                  items={team.items}
                  layout={team.layout}
                  greeting={team.greeting.text}
                  /* Explicit phase-derived `building`: this grid only renders
                     pre-SCORING (LOBBY/GREETINGS/BUILD — SCORING and the
                     stage phases replace it), so the BUILD teaser is the
                     correct empty-card note here. Stated explicitly (not
                     left to CardCanvas's default) so a future phase change
                     can't silently show the teaser on a finished-game
                     surface (lib/empty-card-note.ts contract). */
                  building={
                    [PHASE.LOBBY, PHASE.GREETINGS, PHASE.BUILD].includes(
                      snapshot.phase as (typeof PHASE)[keyof typeof PHASE],
                    )
                  }
                  ariaLabel={`Team ${team.label} card — ${readyCount} stickers placed`}
                />
                <p className="cc-hint" aria-live="polite">
                  {readyCount} sticker{readyCount === 1 ? "" : "s"} on the card
                </p>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* SCORING onward: one-at-a-time stage — a single team fills the
          screen, with ←/→ wrap-around cycle buttons. JUDGING/REVEAL/RESULTS
          all render the unified side-by-side PresenterTeamStage (poster +
          sticker cards): JUDGING adds the live tally chip and keeps the
          prompt accordions, REVEAL/RESULTS add the viewed team's WINNER /
          Crowd Favourite banner above the cards when it earned either;
          Pick winner + Return ride the stage header's actions row. */}
      {showStage && stageTeam ? (
        <section aria-label="team showcase stage" className="cc-present-stage" data-testid="presenter-stage">
          <div className="cc-present-stage-header">
            <h2>{`Team ${stageTeam.label}`}</h2>
            <span className="cc-badge">
              {(latched ? focusedIndex : clampedStageIndex) + 1} of {teamCount}
            </span>
            <div className="cc-present-stage-actions">
              <button
                type="button"
                className="cc-btn"
                data-testid="presenter-prev"
                aria-label={`Previous team (${(((latched ? focusedIndex : clampedStageIndex) - 1 + teamCount) % teamCount) + 1} of ${teamCount})`}
                onClick={() => stepStage(-1)}
              >
                ← Prev
              </button>
              <button
                type="button"
                className="cc-btn"
                data-testid="presenter-next"
                aria-label={`Next team (${(((latched ? focusedIndex : clampedStageIndex) + 1) % teamCount) + 1} of ${teamCount})`}
                onClick={() => stepStage(1)}
              >
                Next →
              </button>
              {/* JUDGING: Pick winner (the big screen can crown the winner;
                  REVEAL follows via the winnerAnnounced broadcast) + Return
                  ride the stage header's actions row — the unified
                  PresenterTeamStage below owns only the card faces. */}
              {snapshot.phase === PHASE.JUDGING ? (
                <button
                  type="button"
                  className="cc-btn cc-btn-primary"
                  data-testid="presenter-judge-pick"
                  disabled={pickingWinner}
                  onClick={() => {
                    if (pickingWinner) return;
                    setPickingWinner(true);
                    socketRef.current?.emit(
                      "judging:winner",
                      { teamId: stageTeam.id },
                      (ack: { ok?: boolean; code?: string } | undefined) => {
                        // On failure restore the button (REVEAL unmounts it
                        // on success via the phase change).
                        if (!ack?.ok) setPickingWinner(false);
                      },
                    );
                  }}
                >
                  {pickingWinner ? "Picking…" : "Pick winner"}
                </button>
              ) : null}
              {/* Return to the GM console — on every stage phase. */}
              {snapshot.phase === PHASE.JUDGING ? (
                <button
                  type="button"
                  className="cc-btn"
                  data-testid="presenter-judge-return"
                  onClick={returnToGm}
                >
                  Return
                </button>
              ) : null}
              {snapshot.phase === PHASE.REVEAL ? (
                <button
                  type="button"
                  className="cc-btn"
                  data-testid="presenter-reveal-return"
                  onClick={returnToGm}
                >
                  Return
                </button>
              ) : null}
              {snapshot.phase === PHASE.RESULTS ? (
                <button
                  type="button"
                  className="cc-btn"
                  data-testid="presenter-results-return"
                  onClick={returnToGm}
                >
                  Return
                </button>
              ) : null}
            </div>
          </div>
          {/* Unified side-by-side stage for JUDGING/REVEAL/RESULTS. JUDGING
              adds the live tally chip (card→tally lookup above) and keeps
              the prompt accordions (promptText is public from JUDGING);
              REVEAL/RESULTS get the winner / Crowd Favourite banners. */}
          <PresenterTeamStage
            team={stageTeam}
            cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
            cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
            testId={snapshot.phase === PHASE.JUDGING ? `presenter-judge-${stageTeam.id}` : "presenter-stage"}
            isWinner={snapshot.winnerTeamId === stageTeam.id}
            isPeoplesChoice={snapshot.peoplesChoiceTeamId === stageTeam.id}
            tally={snapshot.phase === PHASE.JUDGING ? judgingTally : undefined}
          />
        </section>
      ) : null}

      {/* RESULTS: the public standings list below the stage (fed by the
          winnerAnnounced payload / the post-pick snapshot). */}
      {snapshot?.phase === PHASE.RESULTS && snapshot.standings.length > 0 ? (
        <StandingsList
          standings={snapshot.standings}
          winnerTeamId={snapshot.winnerTeamId}
          peoplesChoiceTeamId={snapshot.peoplesChoiceTeamId}
          testId="presenter-standings"
        />
      ) : null}

      {snapshot && snapshot.teams.length === 0 ? (
        <p className="cc-hint">No teams yet…</p>
      ) : null}
      {!snapshot ? <p className="cc-hint">Waiting for the first sync…</p> : null}

      {/* SCORING: the label-identity single-card stage — replaces the team
          stage (cycling team→card side by side would leak the card↔team
          mapping) and the old chip console. Real team names are GM-only:
          the stage header shows the card's public label ("Card A"…), the
          card↔teamId mapping itself never rides the presenter payload
          during SCORING — the server strips it; the client resolves the team
          by label-letter match ("Card A" → team.label "A"). UNIFIED LAYOUT:
          the card renders via the same
          side-by-side PresenterTeamStage the REVEAL/RESULTS stage uses —
          fed from the client snapshot so a 0-prompt team shows its greeting
          + the phase-aware finished note on BOTH faces instead of a blank
          card. Prompt accordions are SUPPRESSED (prompts are still
          anonymous during SCORING); the live tally chip rides the stage and
          the standalone tally line below is kept for the big-screen read.
          The old flip-<img> PNG stage survives ONLY as a defensive fallback
          when the team lookup misses (snapshot race / team removed). */}
      {snapshot?.phase === PHASE.SCORING && scoringCard ? (
        <section
          aria-label="scoring stage"
          className="cc-scoring-stage"
          data-testid="presenter-scoring"
        >
          <div className="cc-scoring-stage-heading">
            <h3>Rate the cards</h3>
            <p className="cc-hint" aria-live="polite">
              Players are rating the cards from 1 to 10 — scores update live.
            </p>
          </div>
          <div className="cc-present-stage-header">
            <h2>{scoringCardName}</h2>
            <span className="cc-badge">
              {clampedScoringIndex + 1} of {scoringCount}
            </span>
            <div className="cc-present-stage-actions">
              <button
                type="button"
                className="cc-btn"
                data-testid="presenter-scoring-prev"
                aria-label={`Previous card (${(((clampedScoringIndex - 1 + scoringCount) % scoringCount) + 1)} of ${scoringCount})`}
                onClick={() => stepScoringCard(-1)}
              >
                ← Prev
              </button>
              <button
                type="button"
                className="cc-btn"
                data-testid="presenter-scoring-next"
                aria-label={`Next card (${(((clampedScoringIndex + 1) % scoringCount) + 1)} of ${scoringCount})`}
                onClick={() => stepScoringCard(1)}
              >
                Next →
              </button>
              <button
                type="button"
                className="cc-btn"
                data-testid="presenter-scoring-return"
                onClick={returnToGm}
              >
                Return
              </button>
            </div>
          </div>
          {scoringCardTeam ? (
            <PresenterTeamStage
              team={scoringCardTeam}
              cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
              cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
              testId="presenter-scoring-card"
              isWinner={false}
              isPeoplesChoice={false}
              showPromptAccordions={false}
              tally={snapshot.scores[scoringCard.cardId] ?? null}
              cardLabel={scoringCard.label}
            />
          ) : (
            /* Defensive fallback (team lookup missed — snapshot race or the
               team was removed): the legacy server-rendered PNG poster so
               the stage NEVER goes blank. Not the primary path. */
            <div className="cc-scoring-stage-card" data-testid="presenter-scoring-card-fallback">
              <img
                src={`/api/games/${code}/scoring-card/${scoringCard.cardId}?variant=poster`}
                alt={`${scoringCardName} — AI montage poster`}
                draggable={false}
              />
            </div>
          )}
          <p className="cc-scoring-stage-tally" aria-live="polite" data-testid="presenter-scoring-tally">
            {(() => {
              const tally = snapshot.scores[scoringCard.cardId];
              return tally
                ? `${tally.avg} avg · ${tally.count} vote${tally.count === 1 ? "" : "s"}`
                : "no votes yet";
            })()}
          </p>
        </section>
      ) : null}
    </main>
  );
}

export default function PresenterClient({
  code,
  focusCardId,
  focusTeamId,
}: {
  code: string;
  /** Deep-link focus (GM "View" → /present/<code>?card=<cardId>). */
  focusCardId?: string;
  /** Deep-link focus (legacy ?team=<id>): the stage latches onto this team. */
  focusTeamId?: string;
}) {
  return (
    <GameStoreProvider>
      <PresenterBoard
        code={code}
        focusCardId={focusCardId}
        focusTeamId={focusTeamId}
      />
    </GameStoreProvider>
  );
}