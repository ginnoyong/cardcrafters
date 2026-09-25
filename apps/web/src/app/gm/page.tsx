"use client";

/**
 * GM console — landing (create game) + live game control.
 *
 * Flow:
 *   1. Pick team count (1–10) and an optional opening theme → POST /api/games.
 *   2. The console shows the code, live teams/players (QR join codes), and
 *      phase controls (gm:setTheme / gm:approveGreetings over sockets).
 *   3. Resume: /gm?code=CODE reloads the console for an existing game
 *      (join tokens come back via /api/games/:code?full=1).
 *
 * GM auth IS knowing the game code (party-game trade-off, see ws/auth.ts).
 * NOTE: approving greetings moves the game to BUILD but greeting generation
 * itself arrives in Step 6 — players see BUILD with no generation yet.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import { MAX_TEAMS, MAX_TEAM_MEMBERS } from "@cardcrafters/shared";

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

interface TeamSetup {
  id: string;
  name: string;
  label: string;
  joinToken: string;
}

interface CreatedGame {
  code: string;
  teams: TeamSetup[];
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="cc-dot" role="status" aria-label={connected ? "connected" : "disconnected"}>
      {connected ? "● connected" : "○ connecting…"}
    </span>
  );
}

function PhaseBadge({ phase, round }: { phase: string | null; round: number | null }) {
  return (
    <span
      className="cc-badge"
      aria-label={`phase ${phaseLabel(phase)}, round ${round ?? "unknown"}`}
    >
      {phaseLabel(phase)} · round {round ?? "—"}
    </span>
  );
}

/** One team's QR join card: QR code (data-URL), join URL, copy button. */
function TeamQrCard({ team, joinUrl }: { team: TeamSetup; joinUrl: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(joinUrl, { width: 240, margin: 1 })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [joinUrl]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [joinUrl]);

  return (
    <div className="cc-card cc-qr-card" aria-label={`team ${team.label} join card`}>
      <h3>
        {team.name} <span className="cc-muted">({team.label})</span>
      </h3>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={`QR code to join ${team.name}`} width={200} height={200} />
      ) : (
        <div className="cc-qr-placeholder" aria-hidden="true" />
      )}
      <p className="cc-join-url">{joinUrl}</p>
      <button
        type="button"
        className="cc-btn"
        onClick={copy}
        aria-label={`copy join link for ${team.name}`}
      >
        {copied ? "Copied ✓" : "Copy join link"}
      </button>
      <p className="cc-hint">Scan to join this team (max {MAX_TEAM_MEMBERS} players)</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Console (post-creation view) — socket + store wiring
// ---------------------------------------------------------------------------

function Console({ game, initialTheme }: { game: CreatedGame; initialTheme: string }) {
  const { snapshot, dispatch } = useGameStore();
  const [themeDraft, setThemeDraft] = useState(initialTheme);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<ReturnType<typeof createGameSocket> | null>(null);

  const gmAction = useCallback(async (event: string, payload: Record<string, unknown>) => {
    setActionError(null);
    try {
      const socket = socketRef.current;
      if (!socket) {
        setActionError("Not connected yet.");
        return;
      }
      const ack: AckResult = await emitAck<AckResult>(socket, event, payload);
      if (!ack.ok) setActionError(ack.error ?? "Action failed.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    }
  }, []);

  // Socket lifecycle: connect, join as GM, feed every event into the store.
  useEffect(() => {
    const socket = createGameSocket({ role: "gm", gameCode: game.code });
    socketRef.current = socket;
    const unsubscribers: Array<() => void> = [];

    socket.on("connect", () => {
      void emitAck<AckResult>(socket, "join", joinPayload({ role: "gm", joinToken: game.code }))
        .then((ack) => {
          if (!ack.ok) {
            setActionError(friendlyJoinError(ack.error));
            return;
          }
          setConnected(true);
          // Optional opening theme chosen on the landing form.
          if (initialTheme.trim().length > 0) {
            void emitAck<AckResult>(socket, "gm:setTheme", { theme: initialTheme.trim() });
          }
        })
        .catch((err: unknown) =>
          setActionError(friendlyJoinError(err instanceof Error ? err.message : undefined)),
        );
    });

    unsubscribers.push(
      onEvent<SyncFullEvent>(socket, "sync:full", (payload) => {
        dispatch({ type: "sync:full", snapshot: normalizeSyncFull(payload) });
      }),
      onEvent<Record<string, unknown>>(socket, "phaseChanged", (payload) =>
        dispatch({ type: "phaseChanged", payload }),
      ),
      onEvent<{ playerId: string; nickname: string; teamId: string }>(
        socket,
        "player:joined",
        (p) => dispatch({ type: "playerJoined", playerId: p.playerId, nickname: p.nickname, teamId: p.teamId }),
      ),
      onEvent<{ playerId: string; reason?: string }>(socket, "player:left", (p) =>
        dispatch({ type: "playerLeft", playerId: p.playerId, kicked: p.reason === "kick" }),
      ),
    );

    socket.connect();
    return () => {
      for (const off of unsubscribers) off();
      socket.close();
      socketRef.current = null;
    };
  }, [dispatch, game.code, initialTheme]);

  const phase = snapshot?.phase ?? null;
  const round = snapshot?.round ?? null;

  return (
    <div>
      <header className="cc-header">
        <div>
          <h2>
            Game code: <span className="cc-code">{game.code}</span>
          </h2>
          <PhaseBadge phase={phase} round={round} />
          {snapshot?.theme ? <span className="cc-badge">Theme: {snapshot.theme}</span> : null}
        </div>
        <ConnectionDot connected={connected} />
      </header>

      {actionError ? (
        <p role="alert" className="cc-error">
          {actionError}
        </p>
      ) : null}

      {/* Phase controls — GM events with acks over the socket. */}
      <section className="cc-controls" aria-label="phase controls">
        <label htmlFor="gm-theme">
          Theme
          <input
            id="gm-theme"
            value={themeDraft}
            onChange={(e) => setThemeDraft(e.target.value)}
            maxLength={100}
            placeholder="e.g. Dog birthday"
          />
        </label>
        <button
          type="button"
          className="cc-btn"
          disabled={themeDraft.trim().length === 0}
          onClick={() => void gmAction("gm:setTheme", { theme: themeDraft.trim() })}
        >
          Set theme (LOBBY → GREETINGS)
        </button>
        <button
          type="button"
          className="cc-btn cc-btn-primary"
          disabled={phase !== "GREETINGS"}
          onClick={() => void gmAction("gm:approveGreetings", {})}
        >
          Approve greetings → BUILD
        </button>
        <p className="cc-hint">Approving starts BUILD; greeting generation lands in a later build.</p>
      </section>

      {/* Teams: QR join cards + live rosters. */}
      <section aria-label="teams" className="cc-team-grid">
        {game.teams.map((team) => {
          const live = snapshot?.teams.find((t) => t.id === team.id);
          const members = live?.members ?? [];
          const joinUrl = `${window.location.origin}/join/${team.joinToken}`;
          return (
            <div key={team.id} className="cc-team">
              <TeamQrCard team={team} joinUrl={joinUrl} />
              <div className="cc-card cc-roster" aria-label={`team ${team.label} players`}>
                <h4>
                  Players{" "}
                  <span className="cc-muted">
                    {members.length}/{MAX_TEAM_MEMBERS}
                  </span>
                </h4>
                {members.length === 0 ? (
                  <p className="cc-hint">Nobody yet — share the QR!</p>
                ) : (
                  <ul className="cc-player-list">
                    {members.map((m) => (
                      <li key={m.id}>
                        <span aria-hidden="true">{m.connected ? "●" : "○"}</span> {m.nickname}
                        <button
                          type="button"
                          className="cc-btn cc-btn-small"
                          aria-label={`kick ${m.nickname}`}
                          onClick={() => void gmAction("gm:kick", { playerId: m.id })}
                        >
                          Kick
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing (create game) + top-level wiring
// ---------------------------------------------------------------------------

export default function GmPage() {
  const [game, setGame] = useState<CreatedGame | null>(null);
  const [teamCount, setTeamCount] = useState("5");
  const [theme, setTheme] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resume an existing game from ?code= (reload/share of the console URL).
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) return;
    void (async () => {
      try {
        const res = await fetch(`/api/games/${encodeURIComponent(code)}?full=1`);
        if (!res.ok) {
          setError(`No game with code ${code}.`);
          return;
        }
        const body = (await res.json()) as { code: string; teams: TeamSetup[] };
        setGame({ code: body.code, teams: body.teams });
      } catch {
        setError("Could not load the game summary.");
      }
    })();
  }, []);

  async function createGame(): Promise<void> {
    setError(null);
    setCreating(true);
    try {
      const count = Number(teamCount);
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Number.isInteger(count) ? { teamCount: count } : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { code: string; teams: TeamSetup[] };
      setGame({ code: body.code, teams: body.teams });
      // Keep the console shareable/reloadable.
      window.history.replaceState(null, "", `/gm?code=${body.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the game.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="cc-main">
      <h1>Card Crafters — Game Master</h1>
      {game ? (
        <GameStoreProvider>
          <Console game={game} initialTheme={theme.trim()} />
          <p className="cc-hint">
            Presenter view:{" "}
            <a className="cc-link" href={`/present/${game.code}`}>
              /present/{game.code}
            </a>
          </p>
        </GameStoreProvider>
      ) : (
        <form
          className="cc-card cc-setup"
          onSubmit={(e) => {
            e.preventDefault();
            if (!creating) void createGame();
          }}
        >
          <label htmlFor="team-count">
            Team count (1–{MAX_TEAMS})
            <input
              id="team-count"
              type="number"
              min={1}
              max={MAX_TEAMS}
              value={teamCount}
              onChange={(e) => setTeamCount(e.target.value)}
              required
            />
          </label>
          <label htmlFor="opening-theme">
            Opening theme (optional)
            <input
              id="opening-theme"
              value={theme}
              maxLength={100}
              placeholder="e.g. Dog birthday"
              onChange={(e) => setTheme(e.target.value)}
            />
          </label>
          <button type="submit" className="cc-btn cc-btn-primary" disabled={creating}>
            {creating ? "Creating…" : "Create game"}
          </button>
          {error ? (
            <p role="alert" className="cc-error">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}