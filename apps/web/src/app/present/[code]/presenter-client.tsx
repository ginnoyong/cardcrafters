"use client";

/**
 * Presenter view — team cards (name, player count, phase, countdown, join
 * QR) plus a LIVE card grid: one read-only CardCanvas mini per team, fed by
 * the store's build-phase events (item:pending / item:ready /
 * layout:updated — the presenter socket joins every team room).
 */

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import QRCode from "qrcode";

import { MAX_TEAM_MEMBERS } from "@cardcrafters/shared";

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

  useEffect(() => {
    const socket = createGameSocket({ role: "presenter", gameCode: code });
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
      onEvent<Record<string, unknown>>(socket, "item:rejected", (payload) =>
        dispatch({ type: "itemRejected", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "item:failed", (payload) =>
        dispatch({ type: "itemFailed", payload }),
      ),
    );

    socket.connect();
    return () => {
      for (const off of unsubscribers) off();
      socket.close();
    };
  }, [code, dispatch]);

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