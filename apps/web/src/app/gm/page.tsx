"use client";

/**
 * GM console — landing (create game) + live game control.
 *
 * Flow:
 *   1. Team count (1–10) + REQUIRED theme → POST /api/games. The SERVER sets
 *      the theme and auto-generates each team's greeting (the console never
 *      emits gm:setTheme).
 *   2. Console: one FLIPPABLE card per team — front = the generated greeting
 *      (inline edit + regenerate) plus join status/roster, back = QR join
 *      code + copyable link.
 *   3. A single "Start building" button below the grid emits
 *      gm:approveGreetings once every team's greeting is ready; after BUILD
 *      starts it disappears.
 *   4. Greeting text reaches the console via sync:full (buildSyncFull now
 *      carries teams[].greeting) and live via `greeting:updated`.
 *   5. Resume: /gm?code=CODE reloads the console for an existing game
 *      (tokens + greetings come back via /api/games/:code?full=1 AND the
 *      join-time sync:full snapshot).
 *   6. Live previews: below the flippable cards, one read-only CardCanvas
 *      mini per team fed by the store (GREETINGS: greeting + empty canvas;
 *      BUILD: live item:pending/ready + layout:updated updates — the GM's
 *      socket joins every team room, so team-room events land here).
 *
 * GM auth IS knowing the game code (party-game trade-off, see ws/auth.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
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
// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});
import {
  GameStoreProvider,
  normalizeSyncFull,
  phaseLabel,
  useGameStore,
  type ClientTeam,
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

/** Result shape for greeting mutations (ack passthrough). */
interface GreetingMutationResult {
  ok: boolean;
  error?: string;
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

// ---------------------------------------------------------------------------
// One flippable team card: front = greeting + roster, back = QR + join link.
// ---------------------------------------------------------------------------

function TeamFlipCard({
  team,
  joinUrl,
  greetingText,
  members,
  onKick,
  onEditGreeting,
  onRegenGreeting,
}: {
  team: TeamSetup;
  joinUrl: string;
  greetingText: string;
  members: Array<{ id: string; nickname: string; connected: boolean }>;
  onKick: (playerId: string) => void;
  onEditGreeting: (teamId: string, text: string) => Promise<GreetingMutationResult>;
  onRegenGreeting: (teamId: string) => Promise<GreetingMutationResult>;
}) {
  const [flipped, setFlipped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  function startEditing(): void {
    setDraft(greetingText);
    setError(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0) {
      setError("Greeting text can't be empty.");
      return;
    }
    setError(null);
    const res = await onEditGreeting(team.id, text);
    if (!res.ok) {
      setError(res.error ?? "Could not save the greeting.");
      return;
    }
    setEditing(false);
  }

  async function regenerate(): Promise<void> {
    setError(null);
    setRegenBusy(true);
    try {
      const res = await onRegenGreeting(team.id);
      if (!res.ok) setError(res.error ?? "Could not regenerate.");
    } finally {
      setRegenBusy(false);
    }
  }

  const toggle = () => {
    setFlipped((f) => !f);
    setError(null);
    setEditing(false);
  };

  return (
    <div className="cc-team" aria-label={`team ${team.label} card`}>
      <div className="cc-flip-head">
        <h3>
          {team.name} <span className="cc-muted">({team.label})</span>
        </h3>
        <button
          type="button"
          className="cc-btn cc-btn-small"
          aria-pressed={flipped}
          aria-label={flipped ? `show greeting for ${team.name}` : `show QR code for ${team.name}`}
          onClick={toggle}
        >
          {flipped ? "Show greeting" : "Show QR"}
        </button>
      </div>

      <div className={`cc-flip${flipped ? " is-flipped" : ""}`}>
        <div className="cc-flip-inner">
          {/* FRONT — greeting + join status/roster */}
          <div className="cc-flip-face cc-flip-front cc-card">
            {regenBusy ? (
              <p className="cc-greeting cc-shimmer" aria-live="polite">
                Rolling a fresh greeting…
              </p>
            ) : greetingText ? (
              <p className="cc-greeting" aria-live="polite">
                “{greetingText}”
              </p>
            ) : (
              <p className="cc-greeting cc-shimmer" aria-live="polite">
                Writing the first draft…
              </p>
            )}

            {editing ? (
              <div className="cc-edit-block">
                <label htmlFor={`greet-${team.id}`}>
                  Greeting text (max 60 characters)
                  <textarea
                    id={`greet-${team.id}`}
                    value={draft}
                    maxLength={60}
                    rows={2}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </label>
                <div className="cc-btn-row">
                  <button type="button" className="cc-btn cc-btn-primary cc-btn-small" onClick={() => void save()}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="cc-btn cc-btn-small"
                    onClick={() => {
                      setEditing(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="cc-btn-row">
                <button type="button" className="cc-btn cc-btn-small" onClick={startEditing}>
                  Edit
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn-small"
                  disabled={regenBusy}
                  onClick={() => void regenerate()}
                >
                  {regenBusy ? "Regenerating…" : "Regenerate"}
                </button>
              </div>
            )}
            {error ? (
              <p role="alert" className="cc-error">
                {error}
              </p>
            ) : null}

            <p className="cc-hint" aria-label={`team ${team.label} join status`}>
              {members.length}/{MAX_TEAM_MEMBERS} joined
            </p>
            <div className="cc-dots" aria-hidden="true">
              {Array.from({ length: MAX_TEAM_MEMBERS }, (_, i) => (
                <span key={i} className={`cc-dot-chip${i < members.length ? " is-in" : ""}`} />
              ))}
            </div>

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
                      onClick={() => onKick(m.id)}
                    >
                      Kick
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* BACK — QR + join link */}
          <div className="cc-flip-face cc-flip-back cc-card cc-qr-card">
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
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live card mini: one read-only CardCanvas per team (GM console preview).
// ---------------------------------------------------------------------------

function TeamMiniCanvas({ team }: { team: ClientTeam }) {
  const readyCount = team.items.filter((i) => i.status === "ready").length;
  return (
    <div className="cc-mini" aria-label={`live preview of ${team.name}'s card`}>
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
}

// ---------------------------------------------------------------------------
// Console (post-creation view) — socket + store wiring
// ---------------------------------------------------------------------------

function Console({ game }: { game: CreatedGame }) {
  const { snapshot, dispatch } = useGameStore();
  const [actionError, setActionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<ReturnType<typeof createGameSocket> | null>(null);

  /** Core ack emitter — returns the result without touching the banner. */
  const emitGm = useCallback(
    async (event: string, payload: Record<string, unknown>): Promise<GreetingMutationResult> => {
      try {
        const socket = socketRef.current;
        if (!socket) return { ok: false, error: "Not connected yet." };
        const ack: AckResult = await emitAck<AckResult>(socket, event, payload);
        if (!ack.ok) return { ok: false, error: ack.error ?? "Action failed." };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Action failed." };
      }
    },
    [],
  );

  /** Generic GM action with ack — errors surface once, in the banner. */
  const gmAction = useCallback(
    async (event: string, payload: Record<string, unknown>): Promise<GreetingMutationResult> => {
      setActionError(null);
      const res = await emitGm(event, payload);
      if (!res.ok) setActionError(res.error ?? "Action failed.");
      return res;
    },
    [emitGm],
  );

  // Socket lifecycle: connect, join as GM, feed every event into the store.
  useEffect(() => {
    const socket = createGameSocket({ role: "gm", gameCode: game.code });
    socketRef.current = socket;
    const unsubscribers: Array<() => void> = [];

    socket.on("connect", () => {
      void emitAck<AckResult>(socket, "join", joinPayload({ role: "gm", joinToken: game.code }))
        .then((ack) => {
          if (!ack.ok) setActionError(friendlyJoinError(ack.error));
          else setConnected(true);
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
      // Live greeting updates (edits, regens, background generation).
      onEvent<{ teamId: string; text: string; status: string; round?: number }>(
        socket,
        "greeting:updated",
        (p) => dispatch({ type: "greetingUpdated", teamId: p.teamId, text: p.text, status: p.status, round: p.round }),
      ),
      // Build-phase events (GM joins every team room, so team-room broadcasts
      // land here; owner-only item:rejected / item:failed never reach the GM
      // but the dispatch is harmless). NO mySubmitted — the GM never submits.
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
      for ( const off of unsubscribers) off();
      socket.close();
      socketRef.current = null;
    };
  }, [dispatch, game.code]);

  const phase = snapshot?.phase ?? null;
  const round = snapshot?.round ?? null;

  // Greetings ready = every team has a non-empty greeting row.
  const teams = game.teams.map((t) => {
    const live = snapshot?.teams.find((s) => s.id === t.id);
    return {
      ...t,
      greetingText: live?.greeting.text ?? "",
      members: live?.members ?? [],
    };
  });
  const pendingTeams = teams.filter((t) => t.greetingText.trim().length === 0);
  const building = phase !== null && phase !== "GREETINGS" && phase !== "LOBBY";

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

      {/* Teams: flippable greeting/QR cards. */}
      <section aria-label="teams" className="cc-team-grid">
        {teams.map((team) => {
          const joinUrl = `${window.location.origin}/join/${team.joinToken}`;
          return (
            <TeamFlipCard
              key={team.id}
              team={team}
              joinUrl={joinUrl}
              greetingText={team.greetingText}
              members={team.members}
              onKick={(playerId) => void gmAction("gm:kick", { playerId })}
              // Greeting mutations surface their ack errors INLINE on the card
              // (the card's own error slot), not in the global banner.
              onEditGreeting={(teamId, text) => emitGm("gm:updateGreeting", { teamId, text })}
              onRegenGreeting={(teamId) => emitGm("gm:regenGreeting", { teamId })}
            />
          );
        })}
      </section>

      {/* Live previews: one read-only mini canvas per team. GREETINGS: the
          greeting + an empty canvas; BUILD: live items + layout. */}
      {snapshot && snapshot.teams.length > 0 ? (
        <section aria-label="live card previews" className="cc-mini-grid">
          {snapshot.teams.map((team) => (
            <TeamMiniCanvas key={team.id} team={team} />
          ))}
        </section>
      ) : null}

      {/* Single prominent Start control below all cards. Hidden once BUILD is underway. */}
      {!building ? (
        <section className="cc-start" aria-label="start building">
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-start"
            disabled={pendingTeams.length > 0}
            onClick={() => void gmAction("gm:approveGreetings", {})}
          >
            Start building
          </button>
          {pendingTeams.length > 0 ? (
            <p className="cc-hint" aria-live="polite">
              Still writing greetings for:{" "}
              <strong>{pendingTeams.map((t) => t.label).join(", ")}</strong>
            </p>
          ) : (
            <p className="cc-hint">All greetings are ready — starting hands each team its card brief.</p>
          )}
        </section>
      ) : null}
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
    const themeTrim = theme.trim();
    if (themeTrim.length === 0) {
      setError("Please enter a theme — it drives each team's card text.");
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const count = Number(teamCount);
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamCount: Number.isInteger(count) ? count : undefined, theme: themeTrim }),
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
          <Console game={game} />
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
            No. of teams (1-{MAX_TEAMS})
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
          <label htmlFor="game-theme">
            Theme
            <input
              id="game-theme"
              value={theme}
              maxLength={120}
              required
              placeholder="e.g. Happy retirement, Linda!"
              onChange={(e) => setTheme(e.target.value)}
            />
          </label>
          <button type="submit" className="cc-btn cc-btn-primary" disabled={creating}>
            {creating ? "Creating…" : "Create game"}
          </button>
          <p className="cc-hint">The theme drives each team&apos;s opening card text.</p>
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