"use client";

/**
 * Player join + waiting screen.
 *
 * Flow:
 *   1. Nickname form (≤20 chars) → socket connect → `join` { joinToken, nickname }.
 *   2. On ack ok: persist the sessionToken (cc_session cookie, 24 h, SameSite
 *      Lax + localStorage) and switch to the waiting screen.
 *   3. Rejoin: if a cc_session cookie exists on mount, join with the
 *      sessionToken only (no nickname) → server resolves the same player and
 *      emits sync:full.
 *   4. Waiting screen: team roster (live), theme, phase badge, connection dot;
 *      when BUILD starts a placeholder card appears (item submission lands in
 *      a later build).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PHASE } from "@cardcrafters/shared";

import {
  createGameSocket,
  emitAck,
  friendlyJoinError,
  joinPayload,
  onEvent,
  type AckResult,
} from "@/lib/socket";
import {
  GameStoreProvider,
  normalizeSyncFull,
  phaseLabel,
  useGameStore,
  type SyncFullEvent,
} from "@/lib/store";

const SESSION_COOKIE = "cc_session";

function readSessionToken(): string | null {
  if (typeof document !== "undefined") {
    const match = document.cookie.split(";").find((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
    const fromCookie = decodeURIComponent(match?.split("=")[1] ?? "").trim();
    if (fromCookie) return fromCookie;
  }
  try {
    return window.localStorage.getItem(SESSION_COOKIE);
  } catch {
    return null;
  }
}

function persistSessionToken(token: string): void {
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; max-age=86400; path=/; SameSite=Lax`;
  try {
    window.localStorage.setItem(SESSION_COOKIE, token);
  } catch {
    // private mode etc. — the cookie is the important one
  }
}

/** Subset of the server's join ack identity we keep client-side. */
interface JoinIdentity {
  playerId: string;
  teamId: string;
  nickname: string;
  sessionToken: string;
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="cc-dot" role="status" aria-label={connected ? "connected" : "disconnected"}>
      {connected ? "● live" : "○ connecting…"}
    </span>
  );
}

/** Wait for the socket's `connect` (or reject on connect_error / timeout). */
function onceConnected(
  socket: ReturnType<typeof createGameSocket>,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("could not reach the game server — check your connection")),
      timeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Waiting screen
// ---------------------------------------------------------------------------

function WaitingScreen({ identity }: { identity: JoinIdentity }) {
  const { snapshot, dispatch, setMyPlayerId } = useGameStore();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMyPlayerId(identity.playerId);
  }, [identity.playerId, setMyPlayerId]);

  useEffect(() => {
    const socket = createGameSocket({ role: "player", sessionToken: identity.sessionToken });
    const unsubscribers: Array<() => void> = [];

    socket.on("connect", () => {
      // Rejoin with the sessionToken only (server reconnect path) → sync:full.
      void emitAck<AckResult>(socket, "join", joinPayload({ role: "player" })).then((ack) => {
        if (ack.ok) {
          setConnected(true);
          setError(null);
        } else {
          setError(friendlyJoinError(ack.error));
        }
      });
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
    );

    socket.connect();
    return () => {
      for (const off of unsubscribers) off();
      socket.close();
    };
  }, [dispatch, identity.sessionToken]);

  const team = snapshot?.teams.find((t) => t.id === identity.teamId) ?? null;

  return (
    <main className="cc-main">
      <header className="cc-header">
        <h1>Waiting to craft…</h1>
        <ConnectionDot connected={connected} />
      </header>
      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}

      <section className="cc-card" aria-label="your team">
        <h2>{team ? team.name : "Your team"}</h2>
        <p className="cc-badge">
          {snapshot ? `${phaseLabel(snapshot.phase)} · round ${snapshot.round}` : "Connecting…"}
        </p>
        {snapshot?.theme ? (
          <p>
            Theme: <strong>{snapshot.theme}</strong>
          </p>
        ) : null}

        <h3>Team roster</h3>
        {team && team.members.length > 0 ? (
          <ul className="cc-player-list">
            {team.members.map((m) => (
              <li key={m.id}>
                <span aria-hidden="true">{m.connected ? "●" : "○"}</span> {m.nickname}
                {m.id === identity.playerId ? <span className="cc-muted"> (you)</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="cc-hint">Waiting for teammates…</p>
        )}
      </section>

      {snapshot?.phase === PHASE.BUILD ? (
        <section className="cc-card" aria-label="build phase notice">
          <h3>Build phase started</h3>
          <p>Item submission arrives in a later build — hold tight!</p>
        </section>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Join form (nickname) + rejoin bootstrap
// ---------------------------------------------------------------------------

export default function JoinClient({ token }: { token: string }) {
  const [identity, setIdentity] = useState<JoinIdentity | null>(null);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attemptJoin = useCallback(
    async (payload: { role: "player"; joinToken?: string; nickname?: string }, sessionToken?: string) => {
      setError(null);
      setBusy(true);
      const socket = createGameSocket({ role: "player", ...(sessionToken ? { sessionToken } : {}) });
      try {
        socket.connect(); // autoConnect is false — connecting is required before any ack
        await onceConnected(socket);
        const ack = await emitAck<AckResult>(socket, "join", joinPayload(payload));
        if (!ack.ok || !ack.identity) {
          setError(friendlyJoinError(ack.ok ? "join failed" : ack.error));
          return false;
        }
        const ident = ack.identity as JoinIdentity;
        if (ident.sessionToken) persistSessionToken(ident.sessionToken);
        setIdentity(ident); // switches to the waiting screen (own socket)
        return true;
      } catch (err) {
        setError(friendlyJoinError(err instanceof Error ? err.message : undefined));
        return false;
      } finally {
        socket.close();
        setBusy(false);
      }
    },
    [],
  );

  // Rejoin on mount: a stored session token reconnects WITHOUT a nickname.
  useEffect(() => {
    const stored = readSessionToken();
    if (!stored) return;
    void attemptJoinWithSession(stored);
    async function attemptJoinWithSession(sessionToken: string): Promise<void> {
      await attemptJoin({ role: "player" }, sessionToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (identity) {
    return <WaitingScreen identity={identity} />;
  }

  return (
    <main className="cc-main">
      <h1>Join your team</h1>
      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}
      <form
        className="cc-card cc-setup"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void attemptJoin({ role: "player", joinToken: token, nickname: nickname.trim() });
        }}
      >
        <label htmlFor="nickname">
          Your nickname (max 20 characters)
          <input
            id="nickname"
            value={nickname}
            maxLength={20}
            required
            placeholder="e.g. Alex"
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>
        <button type="submit" className="cc-btn cc-btn-primary" disabled={busy}>
          {busy ? "Joining…" : "Join"}
        </button>
      </form>
    </main>
  );
}