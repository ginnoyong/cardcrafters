"use client";

/**
 * Presenter view — team cards (name, label, phase, timer, greeting — no
 * join QR: players join via the GM console, the QR is a GM-only concern)
 * plus a LIVE card grid: one read-only CardCanvas mini per team, fed by
 * the store's build-phase events (item:pending / item:ready /
 * layout:updated — the presenter socket joins every team room).
 *
 * Scoring/results phases (big-screen duty):
 *  - SCORING: an ANONYMOUS live scoreboard ("Card B · 7.5 avg · 3 votes") —
 *    the card↔team mapping never reaches this surface (server-side rule).
 *  - REVEAL: the 3D reveal moment (Three.js floating card, components/
 *    Reveal3D.tsx) — the winning card materializes and floats; without WebGL
 *    / with reduced motion it falls back to the same static "The winner is…
 *    🏆" banner, plus a "Show results" button (reveal:ack — the server allows
 *    GM OR presenter; the hub also auto-expires REVEAL after 30 s, the button
 *    just moves things along).
 *  - RESULTS: winner banner + People's Choice banner + public standings
 *    (shared components/Standings.tsx, fed by the winnerAnnounced payload).
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
  PeoplesChoiceBanner,
  StandingsList,
  WinnerBanner,
  teamLabel,
} from "@/components/Standings";
import { Reveal3D } from "@/components/Reveal3D";
import TeamJudgeCard from "@/components/TeamJudgeCard";
import TeamShowcase from "@/components/TeamShowcase";
import { GameStoreProvider, phaseLabel, useGameStore, type SyncFullEvent } from "@/lib/store";

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

function TeamCard({
  name,
  label,
  memberCount,
  phase,
  phaseEndsAt,
  serverNow,
  greetingText,
}: {
  name: string;
  label: string;
  memberCount: number;
  phase: string;
  phaseEndsAt: number | null;
  serverNow: number;
  greetingText?: string;
}) {
  const remaining = useCountdown(phaseEndsAt, serverNow);

  return (
    <div className="cc-card cc-present-team" aria-label={`team ${label} card`}>
      <h3>
        {name} <span className="cc-muted">({label})</span>
      </h3>
      <p className="cc-badge">
        {phaseLabel(phase)} · {memberCount}/{MAX_TEAM_MEMBERS} players
      </p>
      {greetingText ? <p className="cc-greeting">“{greetingText}”</p> : null}
      {remaining !== null ? (
        <p className="cc-timer" aria-label="phase timer">
          ⏱ {fmt(remaining)}
        </p>
      ) : null}
    </div>
  );
}

function PresenterBoard({
  code,
  focusTeamId: initialFocusTeamId,
}: {
  code: string;
  /** Deep-link focus (GM judging "View" → /present/<code>?team=<id>): the
   *  stage latches onto this team once the snapshot lands. */
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
      // ANONYMOUS cards only (no teamId, no yourTeamCardId — the server
      // strips the mapping for this surface); scores:update rides the whole
      // game room (anonymous per-card tallies); winnerAnnounced carries the
      // winner + People's Choice + public standings for the results board.
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

  // Results-stage labels: the live team list first (the presenter knows the
  // teams), the public standings' labels as the refresh fallback (a sync:full
  // resync carries winnerTeamId but never the standings rows).
  const winnerLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.winnerTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.winnerTeamId)?.label ||
    "";
  const peoplesChoiceLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.peoplesChoiceTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.peoplesChoiceTeamId)?.label ||
    "";

  // One-at-a-time stage (SCORING onward): which team's showcase fills the
  // screen. Wrap-around prev/next; the index clamps when the team count
  // shrinks (a team leaves / round reset) so the stage never shows empty.
  const teamCount = snapshot?.teams.length ?? 0;
  const [stageIndex, setStageIndex] = useState(0);
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

  // Review L3: a deep-linked team latch must not survive a phase change —
  // otherwise the GM picking a winner while a View tab is latched pins that
  // team through REVEAL/RESULTS and the next round. Clear on phase change.
  const latchPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    const phase = snapshot?.phase ?? null;
    if (latchPhaseRef.current !== null && latchPhaseRef.current !== phase && focusTeamId) {
      setFocusTeamId(null);
    }
    latchPhaseRef.current = phase;
  }, [snapshot?.phase, focusTeamId]);

  const clampedStageIndex = teamCount > 0 ? Math.min(stageIndex, teamCount - 1) : 0;
  const focusedIndex = focusTeamId
    ? (snapshot?.teams.findIndex((t) => t.id === focusTeamId) ?? -1)
    : -1;
  const latched = focusedIndex >= 0;
  const stageTeam = snapshot?.teams[latched ? focusedIndex : clampedStageIndex] ?? null;
  const showStage =
    !!snapshot &&
    !!stageTeam &&
    [PHASE.SCORING, PHASE.JUDGING, PHASE.REVEAL, PHASE.RESULTS].includes(
      snapshot.phase as (typeof PHASE)[keyof typeof PHASE],
    );
  const stepStage = useCallback(
    (delta: number) => {
      // Latch hand-off (see focusTeamId above): clear the latch and jump
      // stageIndex relative to the focused team. If the focused team is gone
      // (round reset), just clear the latch and let the plain cycle run.
      if (focusTeamId) {
        const idx = snapshot?.teams.findIndex((t) => t.id === focusTeamId) ?? -1;
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
    [teamCount, focusTeamId, snapshot],
  );

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

      <section aria-label="team overview" className="cc-team-grid">
        {(snapshot?.teams ?? []).map((team) => (
          <TeamCard
            key={team.id}
            name={team.name}
            label={team.label}
            memberCount={team.members.length > 0 ? team.members.length : team.memberCount}
            phase={snapshot?.phase ?? "LOBBY"}
            phaseEndsAt={snapshot?.phaseEndsAt ?? null}
            serverNow={snapshot?.serverNow ?? Date.now()}
            greetingText={team.greeting?.text || undefined}
          />
        ))}
      </section>
      {/* BUILD (and the pre-build LOBBY/GREETINGS phases): live card grid —
          one read-only mini canvas per team, right under the team overview
          cards (greeting + empty canvas; live items + layout). From SCORING
          onward this grid is REPLACED by the one-at-a-time stage below. */}
      {snapshot && snapshot.teams.length > 0 && !showStage ? (
        <section aria-label="live cards" className="cc-mini-grid">
          {snapshot.teams.map((team) => {
            const readyCount = team.items.filter((i) => i.status === "ready").length;
            return (
              <div key={team.id} className="cc-mini" aria-label={`live preview of ${team.name}'s card`}>
                <h3>
                  {team.name} <span className="cc-muted">({team.label})</span>
                </h3>
                <CardCanvas
                  items={team.items}
                  layout={team.layout}
                  greeting={team.greeting.text}
                  ariaLabel={`${team.name} card — ${readyCount} stickers placed`}
                />
                <p className="cc-hint" aria-live="polite">
                  {readyCount} sticker{readyCount === 1 ? "" : "s"} on the card
                </p>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* SCORING onward: one-at-a-time stage — a single team's showcase fills
          the screen (same main/sub layout as the player view), with ←/→
          wrap-around cycle buttons; the meta TeamCard grid (roster/timer)
          stays
          above. The montage surfaces live inside TeamShowcase now (poster
          hero / generating indicator), so the per-mini montage blocks are
          gone. In JUDGING the stage renders the shared TeamJudgeCard
          (poster-first flip view + sticker prompts) with ONLY a Return
          button — no score chip / Pick winner (presenter payloads carry no
          scores and judging stays the GM's call). */}
      {showStage && stageTeam ? (
        <section aria-label="team showcase stage" className="cc-present-stage" data-testid="presenter-stage">
          <div className="cc-present-stage-header">
            <h2>
              {stageTeam.name} <span className="cc-muted">({stageTeam.label})</span>
            </h2>
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
            </div>
          </div>
          {snapshot.phase === PHASE.JUDGING ? (
            /* JUDGING: the shared judge card (full-screen variant). No
               cardLabel exists on presenter payloads (the JUDGING
               phaseChanged carries no scoring order) — TeamJudgeCard falls
               back to the team's label. tally=null: the presenter never
               receives scores. */
            <TeamJudgeCard
              team={stageTeam}
              cardLabel={null}
              tally={null}
              cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
              cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
              testId={`presenter-judge-${stageTeam.id}`}
              actions={
                <button
                  type="button"
                  className="cc-btn"
                  data-testid="presenter-judge-return"
                  onClick={() => {
                    // history.length is unreliable for a fresh _blank tab
                    // (Chromium reports 2 for the initial about:blank entry,
                    // so back() can land on a blank page). The coded GM URL
                    // is the deterministic path back.
                    window.location.assign(`/gm?code=${encodeURIComponent(code)}`);
                  }}
                >
                  Return
                </button>
              }
            />
          ) : (
            <TeamShowcase
              team={stageTeam}
              cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
              cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
              testId={`presenter-showcase-${stageTeam.id}`}
            />
          )}
        </section>
      ) : null}

      {snapshot && snapshot.teams.length === 0 ? (
        <p className="cc-hint">No teams yet…</p>
      ) : null}
      {!snapshot ? <p className="cc-hint">Waiting for the first sync…</p> : null}

      {/* SCORING: anonymous live scoreboard — card labels + running averages
          only. The card↔team mapping NEVER reaches the big screen before the
          reveal (server strips it from every presenter payload). */}
      {snapshot?.phase === PHASE.SCORING && (snapshot.scoring?.cards.length ?? 0) > 0 ? (
        <section className="cc-card cc-scoring-console" aria-label="scoring progress" data-testid="presenter-scoring">
          <h3>Rate the cards</h3>
          <p className="cc-hint" aria-live="polite">
            Players are rating the cards from 1 to 10 — scores update live.
          </p>
          <ul className="cc-score-chips">
            {snapshot.scoring!.cards.map((card) => {
              const tally = snapshot.scores[card.cardId];
              return (
                <li key={card.cardId} className="cc-score-chip">
                  <span className="cc-score-chip-team">{card.label}</span>
                  <span className="cc-score-chip-score" aria-live="polite">
                    {tally
                      ? `${tally.avg} avg · ${tally.count} vote${tally.count === 1 ? "" : "s"}`
                      : "no votes yet"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* REVEAL: the 3D reveal moment — the winning card materializes in a
          small Three.js scene; any miss (reduced motion, no WebGL, texture
          or Three.js load failure) falls back to the same static banner.
          winnerTeamId rides the phase change; the name lands with the
          winnerAnnounced broadcast a moment later — the heading reads "The
          winner is…" until then. The "Show results" button (reveal:ack)
          skips the 30 s auto-expiry wait. */}
      {snapshot?.phase === PHASE.REVEAL && snapshot.winnerTeamId ? (
        <section className="cc-reveal" aria-label="the reveal" data-testid="presenter-reveal">
          <Reveal3D code={code} label={winnerLabel || "…"} testId="presenter-winner-banner" />
          <div className="cc-btn-row cc-reveal-actions">
            <button
              type="button"
              className="cc-btn"
              data-testid="presenter-reveal-extend"
              onClick={() => void extendReveal()}
            >
              Add 30 more seconds
            </button>
            <button
              type="button"
              className="cc-btn cc-btn-primary cc-btn-start"
              onClick={() => void showResults()}
            >
              Show results
            </button>
          </div>
        </section>
      ) : null}

      {/* RESULTS: winner + People's Choice + the public standings (fed by the
          winnerAnnounced payload / the post-pick snapshot). */}
      {snapshot?.phase === PHASE.RESULTS && snapshot.winnerTeamId ? (
        <>
        <div data-reveal-mode="results">
          <WinnerBanner label={winnerLabel || "…"} testId="presenter-winner-banner" />
        </div>
          {peoplesChoiceLabel ? (
            <PeoplesChoiceBanner label={peoplesChoiceLabel} testId="presenter-peoples-choice" />
          ) : null}
          {snapshot.standings.length > 0 ? (
            <StandingsList
              standings={snapshot.standings}
              winnerTeamId={snapshot.winnerTeamId}
              peoplesChoiceTeamId={snapshot.peoplesChoiceTeamId}
              testId="presenter-standings"
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

export default function PresenterClient({
  code,
  focusTeamId,
}: {
  code: string;
  /** Deep-link focus (GM judging "View" → /present/<code>?team=<id>). */
  focusTeamId?: string;
}) {
  return (
    <GameStoreProvider>
      <PresenterBoard code={code} focusTeamId={focusTeamId} />
    </GameStoreProvider>
  );
}