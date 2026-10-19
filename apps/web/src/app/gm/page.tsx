"use client";

/**
 * GM console — landing (create game) + live game control.
 *
 * Flow:
 *   1. Team count (1–10) + REQUIRED theme → POST /api/games. The SERVER sets
 *      the theme and auto-generates each team's greeting (the console never
 *      emits gm:setTheme).
 *   2. Console: one vertical card per team — header (name + label badge), the
 *      generated greeting (inline edit + regenerate) and a button row
 *      [Edit] [Regenerate] [Show QR]. "Show QR" toggles a single-QR accordion
 *      (only one team's QR area is open at a time; all QR areas render in the
 *      DOM so print can reveal every one via CSS). The roster ("N joined" +
 *      green dots + kick buttons) sits BELOW the card in a hairline-bordered
 *      section.
 *   3. A single "Start building" button between the team cards and the live
 *      card previews emits gm:approveGreetings once every team's greeting is
 *      ready; after BUILD starts it disappears.
 *   4. Greeting text reaches the console via sync:full (buildSyncFull now
 *      carries teams[].greeting) and live via `greeting:updated`.
 *   5. Resume: /gm?code=CODE reloads the console for an existing game
 *      (tokens + greetings come back via /api/games/:code?full=1 AND the
 *      join-time sync:full snapshot).
 *   6. Live previews: below the team cards, one read-only CardCanvas
 *      mini per team fed by the store (GREETINGS: greeting + empty canvas;
 *      BUILD: live item:pending/ready + layout:updated updates — the GM's
 *      socket joins every team room, so team-room events land here).
 *
 * GM auth IS knowing the game code (party-game trade-off, see ws/auth.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import QRCode from "qrcode";

import { LAYOUT_CRITIQUE_LOW_SCORE, MAX_TEAMS, PHASE } from "@cardcrafters/shared";

import { PeoplesChoiceBanner, StandingsList, WinnerBanner, teamLabel } from "@/components/Standings";
import { minutesToSeconds } from "@/lib/timers";
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
// Client-only: the Three.js reveal scene (three is imported lazily INSIDE the
// component's effect) — only ever mounted inside the GM's 3D modal, so it
// never lands in the console's initial bundle or an SSR pass.
const Reveal3D = dynamic(() => import("@/components/Reveal3D").then((m) => m.Reveal3D), {
  ssr: false,
  loading: () => <div className="cc-hint">Loading 3D reveal…</div>,
});
import {
  GameStoreProvider,
  phaseLabel,
  useGameStore,
  type ClientCritique,
  type ClientTeam,
  type SyncFullEvent,
} from "@/lib/store";

interface TeamSetup {
  id: string;
  name: string;
  label: string;
  joinToken: string;
  montageStatus?: "generating" | "ready" | "fallback" | null;
  montageImageUrl?: string | null;
  /** The EXACT image-model prompt the accumulator sent (GM-only intel). */
  montagePromptText?: string | null;
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

/** Human label for a configured phase timer: 600 → "10 min", 0 → "no limit". */
function timerLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds === 0) return "no limit";
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${seconds}s`;
}

/** Configured-timer badge — 0 (or absent) renders "no limit" (manual stop). */
function TimerBadge({ label, seconds }: { label: string; seconds: number | null }) {
  const text = timerLabel(seconds);
  if (!text) return null;
  return (
    <span className="cc-badge" aria-label={`${label} timer ${text}`}>
      ⏱ {label}: {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One vertical team card: header, greeting (with inline edit + regenerate),
// a [Edit] [Regenerate] [Show QR] button row and a conditional QR area
// (single-QR accordion owned by the Console via qrActive/onToggleQr).
// The roster ("N joined" + one green dot per player + kick buttons) renders
// below the card, inside the same grid cell wrapper.
// ---------------------------------------------------------------------------

function TeamCard({
  team,
  joinUrl,
  greetingText,
  members,
  critique,
  qrActive,
  scoringLabel,
  onToggleQr,
  onKick,
  onEditGreeting,
  onRegenGreeting,
}: {
  team: TeamSetup;
  joinUrl: string;
  greetingText: string;
  members: Array<{ id: string; nickname: string; connected: boolean }>;
  critique: ClientCritique | null;
  qrActive: boolean;
  scoringLabel: string | null;
  onToggleQr: () => void;
  onKick: (playerId: string) => void;
  onEditGreeting: (teamId: string, text: string) => Promise<GreetingMutationResult>;
  onRegenGreeting: (teamId: string) => Promise<GreetingMutationResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  // Prompt transparency accordion: collapsed by default, per-card.
  const [showPrompt, setShowPrompt] = useState(false);
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

  return (
    <div className="cc-team" aria-label={`team ${team.label} card`}>
      <div className="cc-card cc-team-card">
        {/* Header — team name + label badge. */}
        <h3 className="cc-team-name">
          {team.name} <span className="cc-muted">({scoringLabel ?? team.label})</span>
        </h3>

        {/* Greeting text (or the generating placeholder). */}
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

        {/* Montage (poster) accumulator surface: while the poster pass is in
            flight show a small indicator next to the composed card; when the
            poster lands (ready) swap in the image; fallback keeps the card. */}
        {team.montageStatus === "generating" ? (
          <p className="cc-montage-status" aria-live="polite">
            Generating poster…
          </p>
        ) : team.montageStatus === "ready" && team.montageImageUrl ? (
          <div className="cc-montage" aria-label={`poster for ${team.name}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={team.montageImageUrl}
              alt={`Finished poster for ${team.name}`}
              className="cc-montage-img"
            />
          </div>
        ) : null}

        {/* Prompt transparency: the EXACT image-model prompt the accumulator
            sent for this team's poster, collapsible so it doesn't crowd the
            card. Visible whenever a prompt is known — regardless of montage
            status (including fallback, where the prompt explains what was
            attempted). */}
        {team.montagePromptText ? (
          <>
            <button
              type="button"
              className="cc-btn cc-btn-small"
              aria-expanded={showPrompt}
              aria-controls={`montage-prompt-${team.id}`}
              onClick={() => setShowPrompt((v) => !v)}
            >
              {showPrompt ? "Hide prompt" : "View prompt"}
            </button>
            {showPrompt ? (
              <pre id={`montage-prompt-${team.id}`} className="cc-prompt-view">
                {team.montagePromptText}
              </pre>
            ) : null}
          </>
        ) : null}

        {/* Vision layout critique (GM-only quality intel): score badge
            (red below LAYOUT_CRITIQUE_LOW_SCORE or a failed focal check)
            + the verdict's issues, right under the greeting. */}
        {critique ? (
          <div className="cc-critique" aria-label={`layout critique for ${team.name}`}>
            <span
              className={`cc-badge cc-critique-score${
                critique.score < LAYOUT_CRITIQUE_LOW_SCORE || !critique.focalOk
                  ? " is-low"
                  : ""
              }`}
              aria-live="polite"
            >
              Layout {critique.score}/100{critique.focalOk ? "" : " · focal unclear"}
            </span>
            {critique.issues.length > 0 ? (
              <ul className="cc-critique-issues">
                {critique.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* Inline edit flow (textarea + Save/Cancel) while editing. */}
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
        ) : null}

        {error ? (
          <p role="alert" className="cc-error">
            {error}
          </p>
        ) : null}

        {/* Button row: greeting actions + the single-QR accordion toggle. */}
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
          <button
            type="button"
            className="cc-btn cc-btn-small"
            aria-expanded={qrActive}
            aria-pressed={qrActive}
            aria-label={qrActive ? `hide QR code for ${team.name}` : `show QR code for ${team.name}`}
            onClick={onToggleQr}
          >
            {qrActive ? "Hide QR" : "Show QR"}
          </button>
        </div>

        {/* QR area — single-QR accordion. ALWAYS rendered in the DOM (data-URLs
            are cheap) so @media print can reveal every one via CSS; on screen
            only the active one (qrTeamId === team.id) is displayed, so cards
            stay short with no truncation. */}
        <div
          className={`cc-qr-area${qrActive ? " is-active" : ""}`}
          data-qr-active={qrActive ? "true" : "false"}
        >
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={`QR code to join ${team.name}`} width={190} height={190} />
          ) : (
            <div className="cc-qr-placeholder" aria-hidden="true" />
          )}
          <p className="cc-join-url">{joinUrl}</p>
          <button
            type="button"
            className="cc-btn cc-btn-copy"
            onClick={copy}
            aria-label={`copy join link for ${team.name}`}
          >
            {copied ? "Copied ✓" : "Copy join link"}
          </button>
        </div>
      </div>

      {/* Roster lives BELOW the card: "{n} joined" plus one filled green dot
          per actual player, with a compact Kick button per member. Data flow
          unchanged. */}
      <div className="cc-roster" aria-label={`team ${team.label} roster`}>
        <p className="cc-hint" aria-label={`team ${team.label} join status`}>
          {members.length} joined
        </p>
        {members.length === 0 ? (
          <p className="cc-hint">Nobody yet — share the QR!</p>
        ) : (
          <ul className="cc-player-list">
            {members.map((m) => (
              <li key={m.id}>
                <span className="cc-dot-chip is-in" aria-hidden="true" />
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live card mini: one read-only CardCanvas per team (GM console preview).
// After the winner pick (REVEAL/RESULTS + winnerTeamId), the whole thumbnail
// becomes a button-like control opening the 3D reveal modal for THAT team.
// ---------------------------------------------------------------------------

function TeamMiniCanvas({
  team,
  interactive,
  onOpen3d,
}: {
  team: ClientTeam;
  interactive: boolean;
  onOpen3d: () => void;
}) {
  const readyCount = team.items.filter((i) => i.status === "ready").length;
  return (
    <div
      className={`cc-mini${interactive ? " is-clickable" : ""}`}
      aria-label={
        interactive ? `Show ${team.name} card in 3D` : `live preview of ${team.name}'s card`
      }
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-testid={interactive ? `gm-thumb-3d-${team.id}` : undefined}
      onClick={interactive ? onOpen3d : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen3d();
              }
            }
          : undefined
      }
    >
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
// 3D reveal modal: one team's finished card as the Reveal3D scene. The winner
// gets the gloss rig (brighter lights + sheen sweep); every other team gets
// the default look. ✕ (autofocused on open), Escape and a backdrop click all
// close; the backdrop check compares e.target against e.currentTarget so a
// click anywhere inside the stage never closes the modal.
// ---------------------------------------------------------------------------

function RevealModal({
  code,
  teamId,
  teamName,
  gloss,
  onClose,
}: {
  code: string;
  teamId: string;
  teamName: string;
  gloss: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard focus lands on the ✕ button the moment the modal opens.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Escape closes the modal from anywhere (a real keydown on window, so it
  // works even if focus is on the canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="cc-modal"
      data-testid="gm-3d-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cc-modal-stage"
        role="dialog"
        aria-modal="true"
        aria-label={`${teamName} card in 3D`}
      >
        <button
          ref={closeRef}
          type="button"
          className="cc-modal-close"
          aria-label="close 3D reveal"
          onClick={onClose}
        >
          ✕
        </button>
        <Reveal3D
          code={code}
          label={teamName}
          testId="gm-3d-reveal"
          gloss={gloss}
          textureUrl={`/api/games/${encodeURIComponent(code)}/reveal-card?teamId=${encodeURIComponent(teamId)}`}
        />
      </div>
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
  // Single-QR accordion: the one team whose QR area is open (null = all closed).
  const [qrTeamId, setQrTeamId] = useState<string | null>(null);
  // 3D reveal modal: the team whose finished card is on screen (null = closed).
  const [modalTeamId, setModalTeamId] = useState<string | null>(null);
  // Final polish window: set by the GM-only `montage:started` heads-up (emitted
  // just before the preScoring hook runs) and cleared by `scoring:started`.
  const [polishing, setPolishing] = useState(false);
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
        dispatch({ type: "sync:full", snapshot: payload });
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
      // Team broadcast when an item goes REJECTED/FAILED — the console's mini
      // canvas drops the pending placeholder (the rejection reason itself is
      // owner-only intel and never reaches the GM live).
      onEvent<Record<string, unknown>>(socket, "item:withdrawn", (payload) =>
        dispatch({ type: "itemWithdrawn", payload }),
      ),
      // Vision layout critique — GM-room-only verdict from the critique
      // scheduler (build phase, ~5s after a layout lands). Stores the latest
      // per-team score/issues for the card badges.
      onEvent<Record<string, unknown>>(socket, "layout:critique", (payload) =>
        dispatch({ type: "critiqueReceived", payload }),
      ),
      // Montage (poster) accumulator — live status per team. The GM sees the
      // composed card with a small "Generating poster…" indicator while the
      // accumulator runs, then either the finished poster image (ready) or
      // the composed card again (fallback).
      onEvent<Record<string, unknown>>(socket, "montage:generating", (payload) =>
        dispatch({ type: "montageGenerating", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "montage:updated", (payload) =>
        dispatch({ type: "montageUpdated", payload }),
      ),
      // -------------------------------------------------------------------
      // Scoring-phase events. The GM's scoring:started carries the FULL
      // card→team mapping (moderation duty); scores:update carries the
      // anonymous running averages; winnerAnnounced carries the pick +
      // public standings for the results banner.
      // -------------------------------------------------------------------
      // Final polish heads-up: the montage pass runs between this and
      // scoring:started (the hub's preScoring window).
      onEvent(socket, "montage:started", () => setPolishing(true)),
      onEvent<Record<string, unknown>>(socket, "scoring:started", (payload) => {
        setPolishing(false);
        dispatch({ type: "scoringStarted", payload });
      }),
      onEvent<Record<string, unknown>>(socket, "scores:update", (payload) =>
        dispatch({ type: "scoresUpdated", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "winnerAnnounced", (payload) =>
        dispatch({ type: "winnerAnnounced", payload }),
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
      critique: live?.critique ?? null,
      // Montage (poster) state is live-only — the REST game summary never
      // carries it, so the snapshot is the sole source once connected.
      montageStatus: live?.montageStatus ?? t.montageStatus ?? null,
      montageImageUrl: live?.montageImageUrl ?? t.montageImageUrl ?? null,
      montagePromptText: live?.montagePromptText ?? t.montagePromptText ?? null,
    };
  });
  const pendingTeams = teams.filter((t) => t.greetingText.trim().length === 0);
  const building = phase !== null && phase !== "GREETINGS" && phase !== "LOBBY";

  // ---------------------------------------------------------------------
  // Scoring/judging/results derived data. The GM's scoring.cards carry the
  // card→team mapping (server-side only) — the chips/table below resolve
  // team names through the snapshot's teams list. GM never votes; the GM
  // judges.
  // ---------------------------------------------------------------------
  const scoringCards = snapshot?.scoring?.cards ?? [];
  const scoringChips = scoringCards
    .filter((c) => typeof c.teamId === "string")
    .map((c) => {
      const team = snapshot?.teams.find((t) => t.id === c.teamId);
      const tally = snapshot?.scores[c.cardId];
      return {
        cardId: c.cardId,
        cardLabel: c.label,
        teamId: c.teamId!,
        teamLabel: team?.label ?? c.teamId!,
        teamName: team?.name ?? "",
        avg: tally?.avg ?? null,
        count: tally?.count ?? 0,
      };
    });
  // Card→scoring-label map: the scoring card's label ("Card A", …) is the
  // stable display label during scoring/judging — show it on the team card
  // header instead of the (player-facing) join label once cards exist.
  const scoringLabelByTeam = new Map(
    scoringCards.filter((c) => typeof c.teamId === "string").map((c) => [c.teamId!, c.label]),
  );
  // Readiness: ratedX is live-computed from the tallies (every score:submit
  // lands as scores:update); the sync snapshot's ratedX/ratedY is the
  // refresh/resync fallback. ratedY = active players × (teams − 1).
  const ratedLive = snapshot
    ? Object.values(snapshot.scores).reduce((n, t) => n + t.count, 0)
    : 0;
  const ratedX = ratedLive || snapshot?.scoring?.ratedX || 0;
  const ratedY = snapshot?.scoring?.ratedY ?? null;
  // Judging table rows: sorted avg desc → count desc → label (unscored
  // cards last). Same ordering the server uses for the public standings.
  const judgingRows = scoringChips
    .slice()
    .sort((a, b) => {
      const aAvg = a.avg ?? -1;
      const bAvg = b.avg ?? -1;
      if (aAvg !== bAvg) return bAvg - aAvg;
      if (b.count !== a.count) return b.count - a.count;
      return a.teamLabel.localeCompare(b.teamLabel);
    });
  // RESULTS banners: winner + People's Choice labels (snapshot teams first,
  // the public standings' labels as the refresh fallback).
  const winnerLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.winnerTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.winnerTeamId)?.label ||
    "";
  const peoplesChoiceLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.peoplesChoiceTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.peoplesChoiceTeamId)?.label ||
    "";
  const resultsStage = phase === PHASE.REVEAL || phase === PHASE.RESULTS;

  return (
    <div>
      <header className="cc-header">
        <div>
          <h2>
            Game code: <span className="cc-code">{game.code}</span>
          </h2>
          <PhaseBadge phase={phase} round={round} />
          <TimerBadge label="Build" seconds={snapshot?.buildTimerSeconds ?? null} />
          <TimerBadge label="Scoring" seconds={snapshot?.scoringTimerSeconds ?? null} />
          {snapshot?.theme ? <span className="cc-badge">Theme: {snapshot.theme}</span> : null}
        </div>
        <ConnectionDot connected={connected} />
      </header>

      {actionError ? (
        <p role="alert" className="cc-error">
          {actionError}
        </p>
      ) : null}

      {/* Teams: vertical greeting/QR cards with the single-QR accordion. */}
      <section aria-label="teams" className="cc-team-grid">
        {teams.map((team) => {
          const joinUrl = `${window.location.origin}/join/${team.joinToken}`;
          const qrActive = qrTeamId === team.id;
          return (
            <TeamCard
              key={team.id}
              team={team}
              joinUrl={joinUrl}
              greetingText={team.greetingText}
              members={team.members}
              critique={team.critique}
              qrActive={qrActive}
              scoringLabel={scoringLabelByTeam.get(team.id) ?? null}
              onToggleQr={() => setQrTeamId(qrActive ? null : team.id)}
              onKick={(playerId) => void gmAction("gm:kick", { playerId })}
              // Greeting mutations surface their ack errors INLINE on the card
              // (the card's own error slot), not in the global banner.
              onEditGreeting={(teamId, text) => emitGm("gm:updateGreeting", { teamId, text })}
              onRegenGreeting={(teamId) => emitGm("gm:regenGreeting", { teamId })}
            />
          );
        })}
      </section>

      {/* Single prominent Start control: below the roster/team cards, above
          the live card previews. Hidden once BUILD is underway. */}
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

      {/* BUILD: "Start scoring" next to the phase-timer badges — ends the
          build early (gm:stopBuild) and opens anonymous player ratings. */}
      {phase === PHASE.BUILD ? (
        <section className="cc-start" aria-label="start scoring" data-testid="gm-start-scoring">
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-start"
            onClick={() => void gmAction("gm:stopBuild", {})}
          >
            Start scoring
          </button>
          <p className="cc-hint">
            Ends building now — each player rates the other teams' cards from 1 to 10.
          </p>
        </section>
      ) : null}

      {/* Final polish window: montage:started → scoring:started. Not gated on
          phase — the phase is already SCORING client-side when this fires. */}
      {polishing ? (
        <section className="cc-card" data-testid="gm-polishing" aria-live="polite">
          <p className="cc-hint">Polishing cards…</p>
        </section>
      ) : null}

      {/* SCORING: per-team live chips {team, avg, votes} + readiness + the
          "Go to judging" control (gm:stopScoring locks the scores). */}
      {phase === PHASE.SCORING && scoringChips.length > 0 ? (
        <section className="cc-card cc-scoring-console" aria-label="scoring progress" data-testid="gm-scoring">
          <h3>Rate the cards — live scores</h3>
          <p className="cc-hint" aria-live="polite" data-testid="gm-scoring-progress">
            {ratedY !== null ? `${ratedX} of ${ratedY} ratings in` : `${ratedX} ratings in`}
          </p>
          <ul className="cc-score-chips">
            {scoringChips.map((chip) => (
              <li key={chip.cardId} className="cc-score-chip" data-testid={`gm-score-chip-${chip.teamId}`}>
                <span className="cc-score-chip-team">
                  {chip.teamName || chip.teamLabel} <span className="cc-muted">({chip.cardLabel})</span>
                </span>
                <span className="cc-score-chip-score" aria-live="polite">
                  {chip.avg !== null ? `${chip.avg} avg` : "no votes yet"} · {chip.count} vote
                  {chip.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
          <div className="cc-btn-row">
            <button
              type="button"
              className="cc-btn cc-btn-primary"
              onClick={() => void gmAction("gm:stopScoring", {})}
            >
              Go to judging
            </button>
          </div>
          <p className="cc-hint">Going to judging locks the scores — nobody can rate after that.</p>
        </section>
      ) : null}

      {/* JUDGING: the judging table below the vertical team cards — sorted
          avg desc → count desc → label, with a Pick winner button per row
          (judging:winner; the server bridges SCORING→JUDGING if needed). */}
      {phase === PHASE.JUDGING && judgingRows.length > 0 ? (
        <section className="cc-card cc-judging" aria-label="judging table" data-testid="gm-judging">
          <h3>Pick the winner</h3>
          <p className="cc-hint">
            Sorted by the players' scores. Your pick wins the round; the crowd's favourite is announced too.
          </p>
          <table className="cc-judging-table">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Team</th>
                <th scope="col">Score</th>
                <th scope="col">Votes</th>
                <th scope="col">Winner</th>
              </tr>
            </thead>
            <tbody>
              {judgingRows.map((row) => (
                <tr key={row.cardId} data-testid={`gm-judging-row-${row.teamId}`}>
                  <td>{row.cardLabel}</td>
                  <td>{row.teamName || row.teamLabel}</td>
                  <td>{row.avg !== null ? row.avg : "—"}</td>
                  <td>{row.count}</td>
                  <td>
                    <button
                      type="button"
                      className="cc-btn cc-btn-primary cc-btn-small"
                      aria-label={`pick ${row.teamName || row.teamLabel} as the winner`}
                      onClick={() => void gmAction("judging:winner", { teamId: row.teamId })}
                    >
                      Pick winner
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* REVEAL/RESULTS: the winner banner + People's Choice + standings.
          At REVEAL the banner itself is a button-like control that keeps the
          reveal on the big screen for another 30 s (reveal:extend); at
          RESULTS the same banner renders inert (the reveal is over). */}
      {resultsStage && snapshot?.winnerTeamId ? (
        <>
          {phase === PHASE.REVEAL ? (
            <div className="cc-reveal-extend-wrap">
              <div
                role="button"
                tabIndex={0}
                className="cc-reveal-extend"
                aria-label="Keep the reveal on screen for another 30 seconds"
                data-testid="gm-reveal-extend"
                onClick={() => void gmAction("reveal:extend", {})}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void gmAction("reveal:extend", {});
                  }
                }}
              >
                <WinnerBanner label={winnerLabel || "…"} testId="gm-winner-banner" />
              </div>
              <p className="cc-hint">
                Click the banner to keep the reveal on the big screen for another 30 seconds.
              </p>
            </div>
          ) : (
            <WinnerBanner label={winnerLabel || "…"} testId="gm-winner-banner" />
          )}
          {peoplesChoiceLabel ? (
            <PeoplesChoiceBanner label={peoplesChoiceLabel} testId="gm-peoples-choice" />
          ) : null}
          <StandingsList
            standings={snapshot.standings}
            winnerTeamId={snapshot.winnerTeamId}
            peoplesChoiceTeamId={snapshot.peoplesChoiceTeamId}
            testId="gm-standings"
          />
        </>
      ) : null}

      {/* Live previews: one read-only mini canvas per team. GREETINGS: the
          greeting + an empty canvas; BUILD: live items + layout. After the
          winner pick (REVEAL/RESULTS + winnerTeamId) each thumbnail opens the
          3D reveal modal for that team (winner = gloss rig). */}
      {snapshot && snapshot.teams.length > 0 ? (
        <section aria-label="live card previews" className="cc-mini-grid">
          {snapshot.teams.map((team) => (
            <TeamMiniCanvas
              key={team.id}
              team={team}
              interactive={resultsStage && snapshot.winnerTeamId !== null}
              onOpen3d={() => setModalTeamId(team.id)}
            />
          ))}
        </section>
      ) : null}

      {/* 3D reveal modal (REVEAL/RESULTS): flip through every team's finished
          card; the winner's card gets the gloss treatment. */}
      {modalTeamId && snapshot ? (
        <RevealModal
          code={game.code}
          teamId={modalTeamId}
          teamName={
            snapshot.teams.find((t) => t.id === modalTeamId)?.name ?? "Team"
          }
          gloss={modalTeamId === snapshot.winnerTeamId}
          onClose={() => setModalTeamId(null)}
        />
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
  // Phase timers in MINUTES (0 = untimed — the GM ends the phase manually).
  const [buildMinutes, setBuildMinutes] = useState("10");
  const [scoringMinutes, setScoringMinutes] = useState("5");
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
      // Minutes → seconds; an empty/garbled field falls back to the server
      // default by simply omitting the value (0 stays 0 = untimed).
      const buildSeconds = minutesToSeconds(buildMinutes);
      const scoringSeconds = minutesToSeconds(scoringMinutes);
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamCount: Number.isInteger(count) ? count : undefined,
          theme: themeTrim,
          ...(buildSeconds !== undefined || scoringSeconds !== undefined
            ? {
                config: {
                  ...(buildSeconds !== undefined ? { buildTimerSeconds: buildSeconds } : {}),
                  ...(scoringSeconds !== undefined ? { scoringTimerSeconds: scoringSeconds } : {}),
                },
              }
            : {}),
        }),
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
          <div className="cc-timer-row">
            <label htmlFor="build-minutes">
              Build timer (min)
              <input
                id="build-minutes"
                type="number"
                min={0}
                step={1}
                value={buildMinutes}
                onChange={(e) => setBuildMinutes(e.target.value)}
              />
            </label>
            <label htmlFor="scoring-minutes">
              Scoring timer (min)
              <input
                id="scoring-minutes"
                type="number"
                min={0}
                step={1}
                value={scoringMinutes}
                onChange={(e) => setScoringMinutes(e.target.value)}
              />
            </label>
          </div>
          <p className="cc-hint">0 = no time limit — you end the phase manually. Max 1440 (24 h).</p>
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