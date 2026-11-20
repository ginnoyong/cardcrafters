"use client";

/**
 * Player join + waiting screen.
 *
 * Flow:
 *   1. Nickname form (≤20 chars) → socket connect → `join` { joinToken, nickname }.
 *   2. On ack ok: persist the sessionToken (cc_session cookie, 24 h, SameSite
 *      Lax + localStorage) and switch to the waiting screen.
 *   3. Rejoin: on mount the stored cc_session token AND the URL's joinToken
 *      are sent together — the server rejoins the saved player only when the
 *      session's team carries the SAME joinToken (the URL link is
 *      authoritative). Otherwise the nickname form is shown (no error) and
 *      the form submit performs a fresh join on the link's team.
 *   4. Waiting screen: team roster (live), theme, phase badge, connection dot.
 *   5. BUILD: ONE flip card — the live sticker CardCanvas by default
 *      (my team, live layout), the AI-montage poster on flip — over a panel
 *      that follows the flip state (team activity with per-entry
 *      "Find on card" highlight buttons ⇄ the montage prompt), plus the
 *      full-width prompt bar, all wired to the store's build-phase events
 *      (item:pending / item:ready / layout:updated team-wide;
 *      item:rejected / item:failed owner-only).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

import { DEFAULT_CARD_RATIO_H, DEFAULT_CARD_RATIO_W, PHASE } from "@cardcrafters/shared";

// Client-only: react-konva throws at module load under Next's bundled React
// (version check) — never evaluate it during SSR/prerender.
const CardCanvas = dynamic(() => import("@/components/player/CardCanvas"), {
  ssr: false,
  loading: () => <div className="cc-canvas-wrap">Loading canvas…</div>,
});
import ActivityFeed from "@/components/player/ActivityFeed";
import NoUndoNotice from "@/components/player/NoUndoNotice";
import PromptBar, { createPromptBarHandle, type PromptBarHandle } from "@/components/player/PromptBar";
import RatingPanel, { type ScoreSubmitOutcome } from "@/components/player/RatingPanel";
import TeamJudgeCard from "@/components/TeamJudgeCard";
import { PeoplesChoiceBanner, StandingsList, WinnerBanner, teamLabel } from "@/components/Standings";
import {
  createGameSocket,
  emitAck,
  friendlyJoinError,
  friendlyScoreError,
  joinPayload,
  onEvent,
  submitScoreAck,
  type AckResult,
} from "@/lib/socket";
import {
  GameStoreProvider,
  phaseLabel,
  useGameStore,
  type SyncFullEvent,
} from "@/lib/store";

const SESSION_COOKIE = "cc_session";
/** localStorage key for the last used nickname (prefill on a fresh join). */
const NICKNAME_KEY = "cc_nickname";

/** Inline style for poster/sticker boxes: lock the box to the game's card
 *  ratio (aspect-ratio) and publish the ratio as custom props so the CSS
 *  max-width calc can shrink the box when the 70vh cap clamps its height —
 *  keeping it exactly as tall as the CardCanvas beside it. */
function cardRatioStyle(w: number, h: number): CSSProperties {
  return {
    aspectRatio: `${w} / ${h}`,
    "--card-ratio-w": w,
    "--card-ratio-h": h,
  } as CSSProperties;
}

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

function readStoredNickname(): string {
  try {
    return (window.localStorage.getItem(NICKNAME_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function persistNickname(nickname: string): void {
  try {
    window.localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    // private mode etc. — prefill is a nicety, never fatal
  }
}

/** Subset of the server's join ack identity we keep client-side. */
interface JoinIdentity {
  playerId: string;
  code: string;
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
  // BUILD flip state: false = the sticker CardCanvas (the default face),
  // true = the AI-montage poster. Flipping is only offered while the poster
  // is actually on screen (see posterReady below).
  const [showPoster, setShowPoster] = useState(false);
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
        // Pass the RAW payload (it already is the normalized snapshot) plus
        // the player id so rows attributed to me rebuild myItems on reconnect.
        dispatch({
          type: "sync:full",
          snapshot: payload,
          myPlayerId: identity.playerId,
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
      // item:withdrawn (team broadcast on a REJECTED/FAILED item) removes the
      // pending placeholder for teammates; the store's reducer keeps the
      // owner's own terminal row/ledger.
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
      // Montage (poster) accumulator — the player's card surfaces the same
      // status as the GM/presenter (generating indicator / finished poster).
      onEvent<Record<string, unknown>>(socket, "montage:generating", (payload) =>
        dispatch({ type: "montageGenerating", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "montage:updated", (payload) =>
        dispatch({ type: "montageUpdated", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "item:withdrawn", (payload) =>
        dispatch({ type: "itemWithdrawn", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "item:rejected", (payload) =>
        dispatch({ type: "itemRejected", payload }),
      ),
      onEvent<Record<string, unknown>>(socket, "item:failed", (payload) =>
        dispatch({ type: "itemFailed", payload }),
      ),
      // -------------------------------------------------------------------
      // Scoring-phase events. scoring:started carries THIS round's card order
      // (labeled with real team names; teamId stays server-side) + our own
      // team's cardId (own-card guard); scores:update carries the live
      // anonymous running averages; winnerAnnounced carries the GM's pick +
      // public standings (REVEAL/RESULTS).
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
  // Post-build phases still show the FINISHED card (user report: the card
  // vanished when the build timer expired — the game auto-advanced to
  // SCORING and the placeholder replaced the whole canvas).
  const locked =
    !!snapshot &&
    [PHASE.SCORING, PHASE.JUDGING, PHASE.REVEAL, PHASE.RESULTS].includes(
      snapshot.phase as (typeof PHASE)[keyof typeof PHASE],
    );
  // Scoring-phase surfaces: RatingPanel needs the team-named card order (it
  // rides on scoring:started AND sync:full, so it is present even after a
  // refresh; the cardId↔teamId mapping itself stays server-side); JUDGING
  // keeps the rated summary + a "waiting" notice; REVEAL
  // /RESULTS show the winner + standings. The SCORING guard is inlined at
  // the JSX use site (see below) so TypeScript narrows snapshot.scoring.
  const judging = snapshot?.phase === PHASE.JUDGING;
  const revealing = snapshot?.phase === PHASE.REVEAL;
  const results = snapshot?.phase === PHASE.RESULTS;
  const winnerLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.winnerTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.winnerTeamId)?.label ||
    "";
  const peoplesChoiceLabel =
    teamLabel(snapshot?.teams ?? [], snapshot?.peoplesChoiceTeamId) ||
    snapshot?.standings.find((s) => s.teamId === snapshot.peoplesChoiceTeamId)?.label ||
    "";
  // Rated summary for JUDGING ("Your ratings: Card B: 7 · Card C: 5").
  const ratedSummary =
    snapshot && Object.keys(snapshot.myScores).length > 0
      ? Object.entries(snapshot.myScores)
          .map(([cardId, value]) => {
            const card = snapshot.scoring?.cards.find((c) => c.cardId === cardId);
            return `${card?.teamName ?? card?.label ?? "a card"}: ${value}`;
          })
          .join(" · ")
      : null;
  // NO-UNDO notice: only before the player's FIRST accepted submission
  // (ledger empty) — NoUndoNotice itself also checks the localStorage ack.
  const noUndoNeeded = build && Object.keys(snapshot?.myItems ?? {}).length === 0;
  // BUILD flip availability: the montage flip face exists only when the AI
  // poster is actually on screen (ready status + image URL) — while
  // generating or after a fallback the card stays the sticker CardCanvas and
  // any stale showPoster=true state falls back to the sticker view.
  const posterReady =
    build && team?.montageStatus === "ready" && Boolean(team?.montageImageUrl);

  // Locked-phase single-card surface: SCORING (with a scoring order) shows
  // the RatingPanel carousel first; EVERY locked phase renders ONE
  // TeamJudgeCard below the header (poster-first flip: AI montage ↔ sticker
  // card, prompt accordion switching with the flip — same as the GM/presenter
  // judge boxes).

  // The countdown ticks during BUILD and SCORING (the two timed phases that
  // matter to players; REVEAL's 30s auto-expiry is presenter/GM business).
  const timed = build || snapshot?.phase === PHASE.SCORING;

  // Build/scoring countdown (mm:ss) — a 1s tick while a timer is running.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!snapshot?.phaseEndsAt || !timed) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [snapshot?.phaseEndsAt, timed]);
  const remainingMs =
    now !== null && snapshot?.phaseEndsAt
      ? Math.max(0, snapshot.phaseEndsAt - now)
      : null;
  const remainingLabel = remainingMs
    ? `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0")}`
    : null;

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

  // FINAL score submit (RatingPanel): emit score:submit over the live socket,
  // register the rating client-side on ok (myScoreSubmitted — the RatingPanel
  // then auto-advances), and surface a plain-language rejection message on
  // fail. Ratings are FINAL — no undo, no re-rating (the server refuses
  // duplicates with already_rated).
  const handleSubmitScore = useCallback(
    async (cardId: string, value: number): Promise<ScoreSubmitOutcome> => {
      const socket = activeSocketRef.current;
      if (!socket) return { ok: false, error: "Not connected yet — please wait a moment." };
      try {
        const ack = await submitScoreAck(socket, cardId, value);
        if (ack.ok) {
          dispatch({ type: "myScoreSubmitted", cardId: ack.cardId, value: ack.score });
          return { ok: true };
        }
        const reason = ack.reason ?? ack.code;
        return { ok: false, reason, error: friendlyScoreError(reason) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Something went wrong — please try again.",
        };
      }
    },
    [dispatch],
  );

  return (
    <main className="cc-main">
      <header className="cc-header">
        <h1>
          {build
            ? "Build the card!"
            : locked && snapshot
              ? phaseLabel(snapshot.phase)
              : "Waiting to craft…"}
        </h1>
        <ConnectionDot connected={connected} />
      </header>
      {error ? (
        <p role="alert" className="cc-error">
          {error}
        </p>
      ) : null}

      {(build || locked) && snapshot && team ? (
        <>
          {/* BUILD-only 2-col header box — team name + theme subtitle on
              the left, the phase/timer badge on the right (see
              .cc-build-head). Locked phases (SCORING+) drop this box: the h1
              already carries the phase label, the RatingPanel/own-card
              section carries the timer, and the theme was shown at build. */}
          {build ? (
            <section className="cc-card cc-build-head" aria-label="your team">
              <h2>{team.name}</h2>
              <p className="cc-badge">
                {phaseLabel(snapshot.phase)} · round {snapshot.round}
                {remainingLabel ? ` · ⏱ ${remainingLabel}` : snapshot.phaseEndsAt ? " · timed" : ""}
              </p>
              {snapshot.theme ? (
                <p>
                  Theme: <strong>{snapshot.theme}</strong>
                </p>
              ) : null}
            </section>
          ) : null}

          {/* Single-card pattern (EVERY locked phase): ONE TeamJudgeCard —
              click flips the AI-montage poster ↔ sticker card, and the
              prompt-transparency accordion under it switches with the flip
              (montage prompt ↔ sticker prompts with real nicknames) — the
              exact GM/presenter judge-box pattern. The prompt is readable
              after a refresh because players' JUDGING+ snapshots now carry
              montagePromptText. BUILD has its own single-card stage below
              (sticker-first flip + activity/prompt panel). */}
          {build ? (
            // BUILD single-card stage: ONE flip card — the live sticker
            // CardCanvas by default (with highlight wiring), the AI-montage
            // poster when flipped (flipping is only offered while the poster
            // is actually ready, so a mid-generate fallback falls back to the
            // sticker view). Under it the toggling panel follows the flip
            // state: sticker view → the team activity feed with per-entry
            // "Find on card" buttons; poster view → the exact montage
            // prompt. Above the stage the prompt bar runs full-width (the
            // old 2-col inputrow is gone — activity now lives in the panel).
            <>
              <PromptBar
                disabled={!connected}
                onSubmitted={() => {
                  /* owner-ledger registration already happened on the ack path */
                }}
                onSubmitStart={handleSubmitStart}
                wiring={promptWiring}
              />

              {noUndoNeeded ? <NoUndoNotice /> : null}

              <section className="cc-build-stage" aria-label="your team's card">
                <div className={`cc-build-visual${posterReady ? " is-flippable" : ""}`}>
                  {posterReady ? (
                    /* Button-like flip control (TeamJudgeCard's exact
                       role/button/Enter/Space pattern): the label announces
                       what the NEXT click shows. */
                    <div
                      role="button"
                      tabIndex={0}
                      aria-pressed={showPoster}
                      aria-label={
                        showPoster
                          ? `show sticker version for ${team.name}`
                          : `show AI montage version for ${team.name}`
                      }
                      data-testid="build-card-flip"
                      onClick={() => setShowPoster((v) => !v)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setShowPoster((v) => !v);
                        }
                      }}
                    >
                      {/* BOTH faces stay mounted; the flip toggles CSS
                          `display` instead of conditionally remounting
                          CardCanvas (per-flip remount sized the fresh Konva
                          stage into a zero-dimension container → blank
                          canvas; persistent mount keeps the ResizeObserver
                          size). */}
                      <div style={{ display: showPoster ? undefined : "none" }}>
                        <div
                          className="cc-montage"
                          style={cardRatioStyle(
                            snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W,
                            snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H,
                          )}
                          aria-label={`poster for ${team.name}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={team.montageImageUrl ?? ""}
                            alt={`Finished poster for ${team.name}`}
                            className="cc-montage-img"
                          />
                        </div>
                      </div>
                      <div style={{ display: showPoster ? "none" : undefined }}>
                        <CardCanvas
                          items={team.items}
                          layout={team.layout}
                          greeting={team.greeting.text}
                          cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                          cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                          myPlayerId={identity.playerId}
                          highlightItemId={highlightItemId}
                          onItemTap={handleHighlight}
                          ariaLabel={`your team's card — ${team.items.filter((i) => i.status === "ready").length} stickers placed`}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <CardCanvas
                        items={team.items}
                        layout={team.layout}
                        greeting={team.greeting.text}
                        cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                        cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                        myPlayerId={identity.playerId}
                        highlightItemId={highlightItemId}
                        onItemTap={handleHighlight}
                        ariaLabel={`your team's card — ${team.items.filter((i) => i.status === "ready").length} stickers placed`}
                      />
                      {team.montageStatus === "generating" ? (
                        <p className="cc-montage-status" aria-live="polite">
                          Generating poster…
                        </p>
                      ) : (
                        <p className="cc-hint">Poster coming soon…</p>
                      )}
                    </>
                  )}
                </div>

                {/* Toggling panel: content FOLLOWS the flip state. Guarded
                    on posterReady too so a mid-view fallback (poster lost)
                    drops straight back to the activity view. */}
                {showPoster && posterReady ? (
                  team.montagePromptText ? (
                    <pre
                      className="cc-prompt-view"
                      aria-label={`AI montage prompt for ${team.name}`}
                      data-testid="build-montage-prompt"
                    >
                      {team.montagePromptText}
                    </pre>
                  ) : (
                    <p className="cc-hint" data-testid="build-montage-prompt-missing">
                      Montage prompt appears when the poster is generated.
                    </p>
                  )
                ) : (
                  <ActivityFeed entries={team.activity} onHighlight={handleHighlight} />
                )}
              </section>
            </>
          ) : (
            // LOCKED phases (SCORING/JUDGING/REVEAL/RESULTS): the rating
            // carousel FIRST in SCORING (browse cards, skip our own, 1–10
            // FINAL ratings, live averages), then ONE TeamJudgeCard — the
            // single flip card + switching prompt accordion for every locked
            // phase — followed by the phase status sections (rated summary /
            // winner + standings / scoring wait). Team activity runs as its
            // own section below the card (single feed, all locked phases).
            <>
              {snapshot.phase === PHASE.SCORING && snapshot.scoring ? (
                <RatingPanel
                  scoring={snapshot.scoring}
                  scores={snapshot.scores}
                  myScores={snapshot.myScores}
                  onSubmit={handleSubmitScore}
                  gameCode={identity.code}
                  sessionToken={identity.sessionToken}
                  cardVersion={snapshot.cardVersion}
                  remainingLabel={remainingLabel}
                  cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                  cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                  testId="player-rating-panel"
                />
              ) : null}

              {/* Own-card section: titled "Your team's card" (visible in
                  SCORING and beyond). The timer chip rides the header row in
                  SCORING — the pre-scoring gap keeps the countdown visible
                  even though the RatingPanel (with its own timer) isn't
                  rendered yet; JUDGING+ has no running timer, so nothing
                  renders when remainingLabel is null. cardLabel stays null:
                  the scoring card's teamName equals the team name (a
                  duplicate) — TeamJudgeCard falls back to team.label so its
                  h3 reads "Name (label)". */}
              <section className="cc-card" aria-label="your team's card" data-testid="your-teams-card">
                <div className="cc-own-card-head">
                  <h3>Your team's card</h3>
                  {snapshot.phase === PHASE.SCORING && remainingLabel ? (
                    <span className="cc-badge">⏱ {remainingLabel}</span>
                  ) : null}
                </div>
                <TeamJudgeCard
                  team={team}
                  cardLabel={null}
                  tally={null}
                  actions={null}
                  cardKind={snapshot.phase === PHASE.SCORING ? "scoring" : "judging"}
                  cardRatioW={snapshot?.cardRatioW ?? DEFAULT_CARD_RATIO_W}
                  cardRatioH={snapshot?.cardRatioH ?? DEFAULT_CARD_RATIO_H}
                  testId="player-our-card"
                />
              </section>

              {judging ? (
                // JUDGING: ratings are locked — keep the rated summary + the
                // waiting notice; the single card view above persists.
                <section className="cc-card" aria-label="judging wait" role="status" data-testid="judging-wait">
                  <h3>Waiting for the game master</h3>
                  <p className="cc-hint">Ratings are locked — the host is picking the winner.</p>
                  {ratedSummary ? <p className="cc-hint">Your ratings: {ratedSummary}</p> : null}
                </section>
              ) : revealing || results ? (
                // REVEAL/RESULTS: the winner ("The winner is…") + the public
                // standings when the server has broadcast them.
                <>
                  <WinnerBanner label={winnerLabel || "…"} testId="player-winner-banner" />
                  {results && peoplesChoiceLabel ? (
                    <PeoplesChoiceBanner label={peoplesChoiceLabel} testId="player-peoples-choice" />
                  ) : null}
                  {snapshot.standings.length > 0 ? (
                    <StandingsList
                      standings={snapshot.standings}
                      winnerTeamId={snapshot.winnerTeamId}
                      peoplesChoiceTeamId={snapshot.peoplesChoiceTeamId}
                      testId="player-standings"
                    />
                  ) : null}
                </>
              ) : snapshot.phase === PHASE.SCORING ? (
                // SCORING without a scoring order (the pre-scoring gap):
                // nothing extra — the "Your team's card" section above plus
                // the activity feed below already cover the screen (the
                // TeamJudgeCard hero replaces the old "Getting the rating
                // cards ready…" wait box).
                null
              ) : (
                <section className="cc-card" aria-label="build ended" role="status">
                  <h3>Time's up — the host locked the cards</h3>
                  <p className="cc-hint">Your team's finished card is shown above.</p>
                </section>
              )}
            </>
          )}

          {/* ONE team activity feed per locked phase, below the card —
              suppressed during BUILD (the feed lives in the build stage's
              toggling panel). */}
          {!build ? <ActivityFeed entries={team.activity} /> : null}
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
    async (
      payload: { role: "player"; joinToken?: string; nickname?: string; sessionToken?: string },
      sessionToken?: string,
    ) => {
      setError(null);
      setBusy(true);
      const socket = createGameSocket({ role: "player", ...(sessionToken ? { sessionToken } : {}) });
      try {
        socket.connect(); // autoConnect is false — connecting is required before any ack
        await onceConnected(socket);
        const ack = await emitAck<AckResult>(socket, "join", joinPayload(payload));
        if (!ack.ok || !ack.identity) {
          const message = ack.ok ? "join failed" : ack.error;
          // The URL link is authoritative: with a valid joinToken a stale-
          // session refusal just means "show the nickname form" — never an
          // "expired link" style error.
          if (!(payload.joinToken && /stale session/i.test(message))) {
            setError(friendlyJoinError(message));
          }
          return false;
        }
        const ident = ack.identity as JoinIdentity;
        if (ident.sessionToken) {
          persistSessionToken(ident.sessionToken);
          persistNickname(ident.nickname);
        }
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

  // Rejoin on mount. The URL's joinToken is AUTHORITATIVE: we send BOTH the
  // stored session token and the link's token — the server rejoins the saved
  // player only when the session's team carries the SAME joinToken. Any other
  // outcome (session from a different team, stale session) is a FRESH JOIN:
  // the server refuses the nickname-less attempt, we clear the error and
  // show the nickname form (prefilled from the last used nickname). The old
  // player is left untouched (they may still be active in another tab).
  useEffect(() => {
    const stored = readSessionToken();
    if (!stored) {
      setNickname(readStoredNickname());
      return;
    }
    void attemptJoinWithSession(stored);
    async function attemptJoinWithSession(sessionToken: string): Promise<void> {
      const ok = await attemptJoin(
        { role: "player", joinToken: token, sessionToken },
        sessionToken,
      );
      if (!ok) {
        // Stale/mismatched session + a valid link → silently fall back to
        // the nickname form (never an "expired link" style error).
        setError(null);
        setNickname(readStoredNickname());
      }
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
          if (busy) return;
          const stored = readSessionToken();
          // Send the stored session alongside the link token: the server
          // treats the LINK as authoritative (mismatched session → fresh
          // join on this team; the old player is never deleted).
          void attemptJoin(
            {
              role: "player",
              joinToken: token,
              nickname: nickname.trim(),
              ...(stored ? { sessionToken: stored } : {}),
            },
            stored ?? undefined,
          );
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
