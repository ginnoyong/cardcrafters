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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import QRCode from "qrcode";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W, MAX_TEAMS, PHASE } from "@cardcrafters/shared";

import CardBack from "@/components/CardBack";
import { PeoplesChoiceBanner, StandingsList, WinnerBanner, teamLabel } from "@/components/Standings";
import TeamJudgeCard, { JudgeScoreChip } from "@/components/TeamJudgeCard";
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
import {
  GameStoreProvider,
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
                {m.nickname}
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
// Live card mini: ONE card per team (GM console preview). Default view is the
// AI-montage poster when it is ready, otherwise the composed CardCanvas; when
// the poster exists the visual is a click-to-flip toggle (poster ⇄ sticker
// CardCanvas — same role/tabIndex/Enter/Space pattern as TeamJudgeCard).
// REVEAL/RESULTS included: every phase flips in place — there is no 3D modal
// anymore (the lightbox was scrapped; the winner gets its own big flip card
// in the banner block instead).
// ---------------------------------------------------------------------------

function TeamMiniCanvas({
  team,
  montageStatus,
  montageImageUrl,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
  preScoring,
}: {
  team: ClientTeam;
  montageStatus?: "generating" | "ready" | "fallback" | null;
  montageImageUrl?: string | null;
  /** Card aspect ratio (game config) — locks the mini poster box to the SAME
   *  ratio as the CardCanvas sticker card. */
  cardRatioW?: number;
  cardRatioH?: number;
  /** Whether the game is still pre-SCORING (LOBBY/GREETINGS/BUILD) — drives
   *  the empty-card placeholder copy on the sticker face (BUILD teaser vs
   *  finished-game note; see lib/empty-card-note.ts). The mini grid renders
   *  in every phase EXCEPT the judge-box phases (SCORING/JUDGING), so this
   *  must come from the Console's phase, not be assumed. Named preScoring —
   *  NOT `building` — because the Console already has a `building` const
   *  with a DIFFERENT meaning ("the BUILD phase has started"). */
  preScoring: boolean;
}) {
  // Flip state: false = default view (AI poster when ready, else the composed
  // CardCanvas), true = the other face. Only meaningful when the poster is
  // ready.
  const [flipped, setFlipped] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  // The poster face is the real AI montage only when it actually landed.
  const posterReady = montageStatus === "ready" && !!montageImageUrl;
  // ALWAYS flippable now (all phases — BUILD, REVEAL and RESULTS flip the
  // same way): with a ready poster the poster is the default face and the
  // flip target is the sticker CardCanvas; without one the sticker card is
  // the default and the flip target is the CardBack placeholder — a team
  // without a poster still gets a real two-face flip. Either way the
  // sticker CardCanvas lives in the SECOND face slot (one stable DOM
  // position — it never remounts when the poster arrives).
  const showingSticker = posterReady ? flipped : !flipped;

  const montageBox = (
    <div
      className="cc-montage"
      style={{
        aspectRatio: `${cardRatioW} / ${cardRatioH}`,
        "--card-ratio-w": cardRatioW,
        "--card-ratio-h": cardRatioH,
      } as CSSProperties}
      aria-label={`poster for ${team.name}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={montageImageUrl ?? ""}
        alt={`Finished poster for ${team.name}`}
        className="cc-montage-img"
      />
    </div>
  );
  const stickerBox = (
    <CardCanvas
      items={team.items}
      layout={team.layout}
      greeting={team.greeting.text}
      cardRatioW={cardRatioW}
      cardRatioH={cardRatioH}
      resizeSignal={flipped}
      building={preScoring}
      ariaLabel={`${team.name} card — ${readyCount} stickers placed`}
    />
  );

  return (
    <div className="cc-mini" aria-label={`live preview of ${team.name}'s card`}>
      <h3>
        {team.name} <span className="cc-muted">({team.label})</span>
      </h3>
      {/* Button-like flip control (TeamJudgeCard pattern): one toggle whose
          label announces what the NEXT click shows. Default face first (the
          ready poster, or the CardBack placeholder without one), sticker
          CardCanvas second. */}
      <div
        className="cc-mini-flip"
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={
          flipped
            ? posterReady
              ? `show AI montage version for ${team.name}`
              : `show sticker version for ${team.name}`
            : posterReady
              ? `show sticker version for ${team.name}`
              : `show card back for ${team.name}`
        }
        data-testid={`gm-mini-flip-${team.id}`}
        onClick={() => setFlipped((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((v) => !v);
          }
        }}
      >
        {/* BOTH faces stay mounted; the flip toggles CSS `display` instead
            of conditionally remounting CardCanvas (a remount on every flip
            sized the fresh Konva stage into a zero-dimension container →
            blank canvas). The canvas also re-measures on every flip via its
            resizeSignal. */}
        <div style={{ display: showingSticker ? "none" : undefined }}>
          {posterReady ? (
            montageBox
          ) : (
            <CardBack
              greeting={team.greeting.text}
              montageStatus={montageStatus ?? null}
              cardRatioW={cardRatioW}
              cardRatioH={cardRatioH}
            />
          )}
        </div>
        <div style={{ display: showingSticker ? undefined : "none" }}>{stickerBox}</div>
      </div>
      {/* Montage (poster) accumulator status: while the poster pass is in
          flight show a small indicator line under the flip card (same
          contract as the judge boxes). */}
      {montageStatus === "generating" ? (
        <p className="cc-montage-status" aria-live="polite">
          Generating poster…
        </p>
      ) : null}
      <p className="cc-hint" aria-live="polite">
        {readyCount} sticker{readyCount === 1 ? "" : "s"} on the card
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winner reveal card: the WINNING team's AI-montage poster inside the results
// banner block — centered at 2× the standard hero width (~960px wrapper; the
// poster box itself locks to the game's card ratio and shares the CardCanvas
// 70vh height cap so both faces render identically sized). Poster face first
// with a warm ochre sparkle overlay (.cc-winner-sparkle, pure CSS — no JS
// particles; multiply-blended deep-gold glints that read on the light theme); click/Enter/Space flips to the sticker CardCanvas (the winning
// team's items/layout/greeting — TeamJudgeCard pattern, aria-pressed, NO 3D
// modal). Without a ready poster the composed CardCanvas renders statically
// (no flip, no sparkle — nothing to twinkle on).
// ---------------------------------------------------------------------------

function WinnerRevealCard({
  team,
  cardRatioW = DEFAULT_CARD_RATIO_W,
  cardRatioH = DEFAULT_CARD_RATIO_H,
}: {
  team: ClientTeam;
  cardRatioW?: number;
  cardRatioH?: number;
}) {
  // Flip state: false = the AI-montage poster (with sparkle), true = the
  // composed sticker CardCanvas.
  const [flipped, setFlipped] = useState(false);

  const readyCount = team.items.filter((i) => i.status === "ready").length;
  const posterReady = team.montageStatus === "ready" && !!team.montageImageUrl;

  if (!posterReady) {
    return (
      <div className="cc-winner-card" aria-label={`the winning card by ${team.name}`}>
        <CardCanvas
          items={team.items}
          layout={team.layout}
          greeting={team.greeting.text}
          cardRatioW={cardRatioW}
          cardRatioH={cardRatioH}
          building={false}
          ariaLabel={`${team.name}'s winning card — ${readyCount} stickers placed`}
        />
      </div>
    );
  }

  return (
    <div className="cc-winner-card">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={
          flipped
            ? "show AI montage version of the winning card"
            : "show sticker version of the winning card"
        }
        data-testid="gm-winner-flip"
        onClick={() => setFlipped((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((v) => !v);
          }
        }}
      >
        {/* BOTH faces stay mounted; CSS-`display` toggle (same fix as
            TeamMiniCanvas — conditional remount of CardCanvas per flip
            rendered a blank 0-sized Konva stage). */}
        <div style={{ display: flipped ? "none" : undefined }}>
          <div
            className="cc-montage cc-winner-sparkle"
            style={{
              aspectRatio: `${cardRatioW} / ${cardRatioH}`,
              "--card-ratio-w": cardRatioW,
              "--card-ratio-h": cardRatioH,
            } as CSSProperties}
            aria-label={`winning poster for ${team.name}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={team.montageImageUrl ?? ""}
              alt={`Winning poster by ${team.name}`}
              className="cc-montage-img"
            />
          </div>
        </div>
        <div style={{ display: flipped ? undefined : "none" }}>
          <CardCanvas
            items={team.items}
            layout={team.layout}
            greeting={team.greeting.text}
            cardRatioW={cardRatioW}
            cardRatioH={cardRatioH}
            resizeSignal={flipped}
            building={false}
            ariaLabel={`${team.name}'s winning sticker card — ${readyCount} stickers placed`}
          />
        </div>
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
  // Team→live-tally map for the JUDGING boxes (the score chip on each judge
  // card): scoring.cards carry teamId on GM snapshots only; snapshot.scores
  // is keyed by cardId, so resolve cardId→teamId through the cards list.
  const tallyByTeamId = new Map(
    scoringCards
      .filter((c) => typeof c.teamId === "string")
      .map((c) => [c.teamId!, snapshot?.scores[c.cardId] ?? null]),
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
  // The winning team's live snapshot row (REVEAL/RESULTS only) — drives the
  // big winner card in the banner block (AI poster ⇄ sticker flip).
  const winnerTeam =
    resultsStage && snapshot?.winnerTeamId
      ? snapshot.teams.find((t) => t.id === snapshot.winnerTeamId) ?? null
      : null;
  // JUDGING/SCORING: the team grid renders judge boxes (poster-first flip
  // card + actions) INSTEAD of the greeting/QR cards, and the mini-preview
  // grid is hidden — the boxes carry the poster/sticker view in both phases.
  const judging = phase === PHASE.JUDGING;
  // SCORING shows the SAME boxes PLUS the live score chip (averages land in
  // the boxes as votes come in) MINUS the Pick winner button (judging-only),
  // in the ORIGINAL teams order (no judgingRows sorting while numbers are in
  // flux). The "Rate the cards — live scores" heading renders as a plain
  // subtitle ABOVE the grid; the "Go to judging" transition renders as a
  // standalone full-width control BELOW it (the old cc-scoring-console box
  // is retired).
  const judgeBoxes = judging || phase === PHASE.SCORING;
  // Judge boxes render in judgingRows order (avg desc → count desc → label,
  // same ordering as the old table); teams without a scoring row keep their
  // original order AFTER the scored ones. JUDGING only — SCORING never sorts.
  const judgingOrderedTeams: typeof teams = judging
    ? [
        ...judgingRows
          .map((row) => teams.find((t) => t.id === row.teamId))
          .filter((t): t is (typeof teams)[number] => t !== undefined),
        ...teams.filter((t) => !scoringLabelByTeam.has(t.id)),
      ]
    : teams;

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

      {/* SCORING: "Rate the cards — live scores" subtitle + live readiness
          line — a plain header block ABOVE the team boxes (NOT a cc-card
          box). Per-team averages now live INSIDE the judge boxes below
          (JudgeScoreChip). data-testid="gm-scoring" kept so tests still find
          the scoring-progress section. */}
      {phase === PHASE.SCORING ? (
        <section aria-label="scoring progress" data-testid="gm-scoring" className="cc-scoring-subtitle">
          <h3>Rate the cards — live scores</h3>
          <p className="cc-hint" aria-live="polite" data-testid="gm-scoring-progress">
            {ratedY !== null ? `${ratedX} of ${ratedY} ratings in` : `${ratedX} ratings in`}
          </p>
        </section>
      ) : null}

      {/* Teams: vertical greeting/QR cards with the single-QR accordion —
          except in JUDGING/SCORING, where the grid renders judge boxes
          (poster-first flip card + score chip + View link) instead. JUDGING
          adds Pick winner and sorts by judgingRows; SCORING keeps the
          original teams order (scores in flux). Same cc-team/cc-card
          wrappers. REVEAL/RESULTS render NO team boxes at all (the stage is
          the screen — same as the presenter): the winner banner block below
          carries the winning card and the mini grid carries every team's. */}
      {!resultsStage ? (
      <section aria-label="teams" className="cc-team-grid">
        {judgingOrderedTeams.map((team) => {
          if (judgeBoxes) {
            return (
              <div key={team.id} className="cc-team" aria-label={`team ${team.label} ${judging ? "judging" : "scoring"} card`}>
                <div className="cc-card">
                  <TeamJudgeCard
                    team={snapshot?.teams.find((t) => t.id === team.id) ?? (() => {
                      // Review L1: this fires only when the store's sync
                      // dropped a team the REST summary still has — a real
                      // desync. Warn once per render cycle so it can't hide.
                      console.warn(`[gm] snapshot missing team ${team.id} — rendering placeholder judge card`);
                      return {
                        id: team.id,
                      name: team.name,
                      label: team.label,
                      memberCount: team.members.length,
                      members: team.members,
                      itemCount: 0,
                      greeting: { text: team.greetingText, status: null },
                      items: [],
                      layout: null,
                      activity: [],
                      // layout:critique events no longer exist (scheduler
                      // unwired) — the field stays a constant null default.
                      critique: null,
                      montageStatus: team.montageStatus ?? null,
                      montageImageUrl: team.montageImageUrl ?? null,
                      montagePromptText: team.montagePromptText ?? null,
                      };
                    })()}
                    cardLabel={scoringLabelByTeam.get(team.id) ?? null}
                    tally={tallyByTeamId.get(team.id) ?? null}
                    cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                    cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                    testId={`gm-judge-${team.id}`}
                    cardKind={judging ? "judging" : "scoring"}
                    actions={
                      <>
                        {/* SCORING: score chip + View — the live avg · votes
                            readout lives IN the box now (the old chips
                            console is gone). JUDGING adds Pick winner. */}
                        <JudgeScoreChip tally={tallyByTeamId.get(team.id) ?? null} />
                        <a
                          className="cc-btn cc-btn-small"
                          href={`/present/${game.code}?team=${team.id}`}
                          data-testid={`gm-judge-view-${team.id}`}
                        >
                          View
                        </a>
                        {judging ? (
                          <button
                            type="button"
                            className="cc-btn cc-btn-small cc-btn-primary"
                            data-testid={`gm-judge-pick-${team.id}`}
                            aria-label={`pick ${team.name} as the winner`}
                            onClick={() => void gmAction("judging:winner", { teamId: team.id })}
                          >
                            Pick winner
                          </button>
                        ) : null}
                      </>
                    }
                  />
                </div>
              </div>
            );
          }
          const joinUrl = `${window.location.origin}/join/${team.joinToken}`;
          const qrActive = qrTeamId === team.id;
          return (
            <TeamCard
              key={team.id}
              team={team}
              joinUrl={joinUrl}
              greetingText={team.greetingText}
              members={team.members}
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
      ) : null}

      {/* Single prominent Start control: below the roster/team cards, above
          the live card previews. Hidden once BUILD is underway. */}
      {!building ? (
        <section className="cc-start" aria-label="start building">
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-start cc-btn-build"
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
            className="cc-btn cc-btn-primary cc-btn-start cc-btn-score"
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

      {/* SCORING: standalone "Go to judging" phase transition (gm:stopScoring
          locks the scores) — full-width cc-btn-primary in its own section,
          mirroring the "Start scoring" pattern. The live averages moved into
          the judge boxes above; the old cc-scoring-console box is retired. */}
      {phase === PHASE.SCORING ? (
        <section className="cc-start" aria-label="go to judging" data-testid="gm-go-judging">
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-start cc-btn-judging"
            onClick={() => void gmAction("gm:stopScoring", {})}
          >
            Go to judging
          </button>
          <p className="cc-hint">Going to judging locks the scores — nobody can rate after that.</p>
        </section>
      ) : null}

      {/* JUDGING: the old cc-judging table is GONE — the judge boxes in the
          team grid above carry the score chip, the presenter View link and
          the Pick winner button (judging:winner), sorted the same way
          (avg desc → count desc → label). */}

      {/* REVEAL/RESULTS: the winner banner + the winning team's big card +
          People's Choice. At REVEAL the banner itself is a button-like
          control that keeps the reveal on the big screen for another 30 s
          (reveal:extend); at RESULTS the same banner renders inert (the
          reveal is over). No team boxes above — the stage is the screen. */}
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
          {/* The winning team's AI-montage card — centered, 2× the standard
              hero width, with a light golden sparkle on the poster face;
              click/Enter/Space flips poster ⇄ sticker IN PLACE (no 3D modal
              — the lightbox is gone). In REVEAL this card sits below the
              extend button so the two clicks never nest. */}
          {winnerTeam ? (
            <WinnerRevealCard
              team={winnerTeam}
              cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
              cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
            />
          ) : null}
          {peoplesChoiceLabel ? (
            <PeoplesChoiceBanner label={peoplesChoiceLabel} testId="gm-peoples-choice" />
          ) : null}
        </>
      ) : null}

      {/* Live previews: ONE card per team. GREETINGS: the greeting + an empty
          canvas; BUILD: live items + layout — the AI-montage poster once it's
          ready (click flips poster ⇄ sticker view; before that, the composed
          canvas with a "Generating poster…" line). REVEAL/RESULTS: the same
          flip cards (the 3D lightbox is gone — the winner gets its own big
          flip card in the banner block above). HIDDEN in JUDGING and SCORING
          (the judge boxes' flip visual carries the poster/sticker now). */}
      {!judgeBoxes && snapshot && snapshot.teams.length > 0 ? (
        <section aria-label="live card previews" className="cc-mini-grid">
          {snapshot.teams.map((team) => {
            // Montage state rides the live snapshot; the Console's merged
            // teams map is the refresh fallback (REST summary fields).
            const merged = teams.find((t) => t.id === team.id);
            return (
              <TeamMiniCanvas
                key={team.id}
                team={team}
                montageStatus={merged?.montageStatus ?? team.montageStatus ?? null}
                montageImageUrl={merged?.montageImageUrl ?? team.montageImageUrl ?? null}
                cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                preScoring={!resultsStage}
              />
            );
          })}
        </section>
      ) : null}

      {/* Standings LAST in REVEAL/RESULTS: winner banner (with the winning
          card) → every team's mini card → the ranked table. Gated the same
          way as the banner block. */}
      {resultsStage && snapshot?.winnerTeamId ? (
        <StandingsList
          standings={snapshot.standings}
          winnerTeamId={snapshot.winnerTeamId}
          peoplesChoiceTeamId={snapshot.peoplesChoiceTeamId}
          testId="gm-standings"
        />
      ) : null}

      {/* RESULTS-only all-cards zip export (code-as-capability GET endpoint;
          the route's RESULTS-only phase guard protects non-exportable
          phases). */}
      {phase === PHASE.RESULTS && snapshot?.winnerTeamId ? (
        <section className="cc-start" data-testid="gm-export-cards">
          <a className="cc-btn cc-btn-primary cc-btn-start" href={`/api/games/${game.code}/export/cards`}>
            ⬇ Export all cards
          </a>
          <p className="cc-hint">Zip with every team's poster + sticker card.</p>
        </section>
      ) : null}

      {/* Presenter view link — lives INSIDE Console (the phase lives in the
          store here) so it can hide during BUILD: the judging/scoring boxes
          already carry per-team presenter View buttons and the big link is
          noise while teams are crafting. LOBBY/GREETINGS keep it so teams
          can watch the big screen from the start. */}
      {phase !== PHASE.BUILD ? (
        <p className="cc-hint">
          Presenter view:{" "}
          <a className="cc-link" href={`/present/${game.code}`}>
            /present/{game.code}
          </a>
        </p>
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
  // Resume-from-URL in flight (?code= present): the setup form must NOT
  // flash while the game summary loads — show a reconnecting placeholder
  // instead until the console mounts (or an error surfaces).
  const [resuming, setResuming] = useState(false);

  // Resume an existing game from ?code= (reload/share of the console URL).
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) return;
    setResuming(true);
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
      } finally {
        setResuming(false);
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
          {/* The presenter-view link renders inside <Console/> (gated on the
              phase — hidden during BUILD); see Console's return JSX. */}
          <Console game={game} />
        </GameStoreProvider>
      ) : resuming ? (
        /* Deep-link/resume in flight: hold this placeholder instead of the
           setup form so the presenter's Return button lands straight on the
           live console (no setup-screen flash). */
        <p className="cc-hint" role="status">
          Reconnecting to the game…
        </p>
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