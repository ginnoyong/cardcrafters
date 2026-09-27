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
 *   4. Waiting screen: team roster (live), theme, phase badge, connection dot.
 *   5. BUILD: the card canvas (my team, live layout) + prompt bar + my
 *      submissions + team activity feed, all wired to the store's build-phase
 *      events (item:pending / item:ready / layout:updated team-wide;
 *      item:rejected / item:failed owner-only).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W, PHASE } from "@cardcrafters/shared";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});
import ActivityFeed from "@/components/player/ActivityFeed";
import MySubmissions from "@/components/player/MySubmissions";
import NoUndoNotice from "@/components/player/NoUndoNotice";
import PromptBar, { createPromptBarHandle, type PromptBarHandle } from "@/components/player/PromptBar";
import { selectMyItems } from "@/components/player/my-items";
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
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  // PromptBar socket wiring (refs owned here; PromptBar reads/writes them):
  // submitRef → the socket emit; deliverRef → PromptBar's ack handler.
  const submitRef = useRef<((promptRaw: string) => void) | null>(null);
  const deliverRef = useRef<((ack: {
    ok: boolean;
    itemId?: string;
    code?: string;
    reason?: string;
    error?: string;
    remainingMs?: number;
    exampleFix?: string;
  }) => void) | null>(null);
  const promptWiring = useMemo(() => ({ submitRef, deliverRef }), []);
  const pendingPromptRef = useRef("");
  // The LIVE player socket (set in the effect below) — submits go through it.
  const activeSocketRef = useRef<ReturnType<typeof createGameSocket> | null>(null);

  useEffect(() => {
    setMyPlayerId(identity.playerId);
  }, [identity.playerId, setMyPlayerId]);

  useEffect(() => {
    const socket = createGameSocket({ role: "player", sessionToken: identity.sessionToken });
    activeSocketRef.current = socket;
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
        // Forward the owner ledger (resync) + pass the player id so rows
        // attributed to me rebuild myItems on reconnect.
        dispatch({
          type: "sync:full",
          snapshot: normalizeSyncFull(payload, snapshotRef.current?.myItems ?? {}, identity.playerId),
        });
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
      // Live greeting updates — the store reducer keys on teamId, so events
      // for other teams are ignored naturally (own-team filter is implicit).
      onEvent<{ teamId: string; text: string; status: string; round?: number }>(
        socket,
        "greeting:updated",
        (p) => dispatch({ type: "greetingUpdated", teamId: p.teamId, text: p.text, status: p.status, round: p.round }),
      ),
      // -------------------------------------------------------------------
      // Build-phase events. Team-room events carry teamId (route by payload);
      // owner-only events (item:rejected / item:failed) do NOT — the store's
      // patchItemEverywhere finds the single team that has the item.
      // -------------------------------------------------------------------
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
      activeSocketRef.current = null;
      for (const off of unsubscribers) off();
      socket.close();
    };
    // snapshotRef keeps the latest snapshot for the resync merge without
    // re-subscribing the socket on every store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, identity.sessionToken]);

  // Latest-snapshot ref (read inside the socket effect's sync:full handler).
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Flash timer for "find on card": highlight a submission's sticker briefly.
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleHighlight = useCallback((itemId: string) => {
    setHighlightItemId(itemId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightItemId(null), 2200);
  }, []);
  useEffect(() => {
    return () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const team = snapshot?.teams.find((t) => t.id === identity.teamId) ?? null;
  const build = snapshot?.phase === PHASE.BUILD;
  const myItems = snapshot && team ? selectMyItems(snapshot, identity.teamId, identity.playerId) : [];
  // NO-UNDO notice: only before the player's FIRST accepted submission
  // (ledger empty) — NoUndoNotice itself also checks the localStorage ack.
  const noUndoNeeded = build && Object.keys(snapshot?.myItems ?? {}).length === 0;

  // Socket submit + ack completion (PromptBar calls submitRef.current on
  // submit; the server ack flows back through deliverRef → PromptBar).
  const handleSubmit = useCallback(
    (promptRaw: string) => {
      const socket = activeSocketRef.current;
      if (!socket) return;
      void emitAck<{
        ok: boolean;
        itemId?: string;
        code?: string;
        reason?: string;
        error?: string;
        remainingMs?: number;
        exampleFix?: string;
      }>(socket, "player:submitPrompt", { text: promptRaw }).then(
        (ack) => {
          if (ack.ok && typeof ack.itemId === "string") {
            // Register the accepted submission in the owner ledger (the
            // team-wide item:pending echo agrees with this moments later).
            dispatch({ type: "mySubmitted", itemId: ack.itemId, promptRaw: pendingPromptRef.current });
          }
          deliverRef.current?.(ack);
        },
        (err: unknown) => {
          deliverRef.current?.({
            ok: false,
            error: err instanceof Error ? err.message : "Something went wrong — please try again.",
          });
        },
      );
    },
    [dispatch],
  );
  submitRef.current = handleSubmit;

  const handleSubmitStart = useCallback((promptRaw: string) => {
    pendingPromptRef.current = promptRaw;
  }, []);

  return (
    <main className="cc-main">
      <header className="cc-header">
        <h1>{build ? "Build the card!" : "Waiting to craft…"}</h1>
        <ConnectionDot connected={connected} />
      </header>
      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}

      {build && snapshot && team ? (
        <>
          <section className="cc-card" aria-label="your team">
            <h2>{team.name}</h2>
            <p className="cc-badge">
              {phaseLabel(snapshot.phase)} · round {snapshot.round}
              {snapshot.phaseEndsAt ? " · timed" : ""}
            </p>
            {snapshot.theme ? (
              <p>
                Theme: <strong>{snapshot.theme}</strong>
              </p>
            ) : null}
          </section>

          <CardCanvas
            items={team.items}
            layout={team.layout}
            greeting={team.greeting.text}
            cardRatioW={DEFAULT_CARD_RATIO_W}
            cardRatioH={DEFAULT_CARD_RATIO_H}
            myPlayerId={identity.playerId}
            highlightItemId={highlightItemId}
            onItemTap={handleHighlight}
            ariaLabel={`your team's card — ${team.items.filter((i) => i.status === "ready").length} stickers placed`}
          />

          {noUndoNeeded ? <NoUndoNotice /> : null}

          <PromptBar
            disabled={!connected}
            onSubmitted={() => {
              /* owner-ledger registration already happened on the ack path */
            }}
            onSubmitStart={handleSubmitStart}
            wiring={promptWiring}
          />

          <MySubmissions items={myItems} onHighlight={handleHighlight} />

          <ActivityFeed entries={team.activity} />
        </>
      ) : (
        <>
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

          {team?.greeting.text ? (
            <section className="cc-card cc-greeting-card" aria-label="your card greeting">
              <h3>Your card will say:</h3>
              <p className="cc-greeting">“{team.greeting.text}”</p>
            </section>
          ) : null}

          {/* Simple placeholder for the non-build phases we don't render fully
              yet (GM/presenter surfaces land in a later batch). */}
          {snapshot &&
          [PHASE.SCORING, PHASE.JUDGING, PHASE.REVEAL, PHASE.RESULTS].includes(
            snapshot.phase as (typeof PHASE)[keyof typeof PHASE],
          ) ? (
            <section className="cc-card" aria-label="phase status" data-testid="phase-placeholder">
              <h3>{phaseLabel(snapshot.phase)}</h3>
              <p>
                {team ? team.name : "Your team"} · round {snapshot.round}
              </p>
            </section>
          ) : null}
        </>
      )}
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

  // GameStoreProvider wraps both screens — WaitingScreen's hooks and any
  // future store consumers live under it.
  if (identity) {
    return (
      <GameStoreProvider>
        <WaitingScreen identity={identity} />
      </GameStoreProvider>
    );
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
