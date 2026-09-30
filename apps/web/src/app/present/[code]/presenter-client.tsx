"use client";

/**
 * Presenter view — team cards (name, player count, phase, countdown, join
 * QR) plus a LIVE card grid: one read-only CardCanvas mini per team, fed by
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
import QRCode from "qrcode";

import { MAX_TEAM_MEMBERS, PHASE } from "@cardcrafters/shared";

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
import { GameStoreProvider, normalizeSyncFull, phaseLabel, useGameStore, type SyncFullEvent } from "@/lib/store";

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
  joinToken,
  phase,
  phaseEndsAt,
  serverNow,
  greetingText,
}: {
  name: string;
  label: string;
  memberCount: number;
  joinToken: string | null;
  phase: string;
  phaseEndsAt: number | null;
  serverNow: number;
  greetingText?: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const remaining = useCountdown(phaseEndsAt, serverNow);

  useEffect(() => {
    if (!joinToken) return;
    let alive = true;
    QRCode.toDataURL(`${window.location.origin}/join/${joinToken}`, { width: 160, margin: 1 })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [joinToken]);

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
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={`QR code to join ${name}`} width={120} height={120} />
      ) : null}
    </div>
  );
}

function PresenterBoard({ code }: { code: string }) {
  const { snapshot, dispatch } = useGameStore();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinTokens, setJoinTokens] = useState<Record<string, string>>({});
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
        dispatch({ type: "sync:full", snapshot: normalizeSyncFull(payload) });
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

  // The presenter snapshot has no join tokens — fetch them once (full=1 is
  // the GM/QR convenience route).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/games/${encodeURIComponent(code)}?full=1`);
        if (!res.ok) return;
        const body = (await res.json()) as { teams: Array<{ id: string; joinToken: string }> };
        const map: Record<string, string> = {};
        for (const t of body.teams) map[t.id] = t.joinToken;
        setJoinTokens(map);
      } catch {
        // QRs stay hidden; not critical for the presenter lobby
      }
    })();
  }, [code]);

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
            joinToken={joinTokens[team.id] ?? null}
            phase={snapshot?.phase ?? "LOBBY"}
            phaseEndsAt={snapshot?.phaseEndsAt ?? null}
            serverNow={snapshot?.serverNow ?? Date.now()}
            greetingText={team.greeting?.text || undefined}
          />
        ))}
      </section>
      {/* Live card grid: one read-only mini canvas per team, right under the
          team overview cards (GREETINGS: greeting + empty canvas; BUILD:
          live items + layout). */}
      {snapshot && snapshot.teams.length > 0 ? (
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
          <WinnerBanner label={winnerLabel || "…"} testId="presenter-winner-banner" />
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

export default function PresenterClient({ code }: { code: string }) {
  return (
    <GameStoreProvider>
      <PresenterBoard code={code} />
    </GameStoreProvider>
  );
}