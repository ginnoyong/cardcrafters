import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_CONFIG, PHASE } from "@cardcrafters/shared";

import { canTransition, isTimedPhase, PHASE_ORDER, transition } from "./state-machine";
import { createInitialRuntimeState, type Effect, type GameRuntimeState } from "./types";

const NOW = 1_700_000_000_000;
const GAME = "game-1";

function mkState(overrides: Partial<GameRuntimeState> = {}): GameRuntimeState {
  return { ...createInitialRuntimeState(GAME, DEFAULT_CARD_CONFIG), ...overrides };
}

function effectTypes(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

/** Narrow to the emit effect (asserts exactly one is present). */
function emitOf(effects: Effect[]): Extract<Effect, { type: "emit" }> {
  const found = effects.filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit");
  expect(found.length).toBe(1);
  return found[0]!;
}

describe("happy path: full round LOBBY → RESULTS → GREETINGS (round 2)", () => {
  const config = DEFAULT_CARD_CONFIG; // build 600s, scoring 300s
  let state = createInitialRuntimeState(GAME, config);

  it("LOBBY + gm:setTheme → GREETINGS", () => {
    const r = transition(state, { type: "gm:setTheme", theme: "Dog birthday", now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.GREETINGS);
    expect(state.theme).toBe("Dog birthday");
    expect(effectTypes(r.effects)).toEqual(["emit"]);
    const emit = emitOf(r.effects);
    expect(emit).toMatchObject({
      event: "phaseChanged",
      rooms: [`game:${GAME}`],
    });
    expect(emit.payload).toMatchObject({
      phase: PHASE.GREETINGS,
      round: 1,
      theme: "Dog birthday",
      serverNow: NOW,
    });
    // No timer starts for GREETINGS.
    expect(state.phaseEndsAt).toBeUndefined();
  });

  it("GREETINGS + gm:approveGreetings → BUILD with timer", () => {
    const r = transition(state, { type: "gm:approveGreetings", now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.BUILD);
    expect(state.phaseEndsAt).toBe(NOW + config.buildTimerSeconds! * 1000);
    expect(effectTypes(r.effects)).toEqual(["emit", "startTimer"]);
    expect(emitOf(r.effects).payload).toMatchObject({
      phase: PHASE.BUILD,
      phaseEndsAt: NOW + config.buildTimerSeconds! * 1000,
      serverNow: NOW,
    });
    expect(r.effects[1]).toEqual({
      type: "startTimer",
      phase: PHASE.BUILD,
      endsAt: NOW + config.buildTimerSeconds! * 1000,
    });
  });

  it("BUILD + gm:stopBuild → SCORING with cutoff + scoring timer", () => {
    const stopAt = NOW + 10_000;
    const r = transition(state, { type: "gm:stopBuild", now: stopAt });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.SCORING);
    expect(state.cutoffAt).toBe(stopAt);
    expect(state.phaseEndsAt).toBe(stopAt + config.scoringTimerSeconds! * 1000);
    expect(effectTypes(r.effects)).toEqual(["setCutoff", "emit", "beginScoring", "startTimer"]);
    expect(r.effects[0]).toEqual({ type: "setCutoff", at: stopAt });
    expect(emitOf(r.effects).payload).toMatchObject({
      phase: PHASE.SCORING,
      cutoffAt: stopAt,
      serverNow: stopAt,
    });
    // beginScoring tells the hub to build the anonymous scoring order and
    // emit scoring:started (per player + GM copy).
    expect(r.effects[2]).toEqual({ type: "beginScoring" });
    expect(r.effects[3]).toEqual({
      type: "startTimer",
      phase: PHASE.SCORING,
      endsAt: stopAt + config.scoringTimerSeconds! * 1000,
    });
  });

  it("SCORING + timer:expired → JUDGING (scores locked, timer cleared)", () => {
    const expiry = state.phaseEndsAt!;
    const r = transition(state, { type: "timer:expired", phase: PHASE.SCORING, now: expiry });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.JUDGING);
    expect(state.scoresLocked).toBe(true);
    expect(state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["lockScores", "emit", "clearTimer"]);
    expect(emitOf(r.effects).payload).toMatchObject({ phase: PHASE.JUDGING, serverNow: expiry });
  });

  it("JUDGING + gm:pickWinner → REVEAL", () => {
    const r = transition(state, {
      type: "gm:pickWinner",
      teamId: "team-a",
      peoplesChoiceTeamId: "team-b",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.REVEAL);
    expect(state.winnerTeamId).toBe("team-a");
    expect(state.peoplesChoiceTeamId).toBe("team-b");
    expect(effectTypes(r.effects)).toEqual(["announceWinner", "emit", "startTimer"]);
    // REVEAL auto-expires: phaseEndsAt is NOW + REVEAL_AUTO_EXPIRE_SECONDS,
    // persisted on the state AND included in the phaseChanged payload so the
    // hub can arm the timer and clients can show the countdown.
    expect(state.phaseEndsAt).toBe(NOW + 30_000);
    expect(emitOf(r.effects).payload).toMatchObject({
      phase: PHASE.REVEAL,
      phaseEndsAt: NOW + 30_000,
      serverNow: NOW,
    });
    expect(r.effects[2]).toEqual({ type: "startTimer", phase: PHASE.REVEAL, endsAt: NOW + 30_000 });
    // The announceWinner effect carries the picks for the hub to persist/broadcast.
    const winner = r.effects.find((e) => e.type === "announceWinner");
    expect(winner).toMatchObject({ type: "announceWinner", teamId: "team-a", peoplesChoiceTeamId: "team-b" });
  });

  it("REVEAL + reveal:ack → RESULTS", () => {
    const r = transition(state, { type: "reveal:ack", now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.RESULTS);
    expect(state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["emit", "clearTimer"]);
  });

  it("RESULTS + gm:newRound → GREETINGS round=2, round-scoped state cleared", () => {
    const r = transition(state, { type: "gm:newRound", now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    state = r.state;
    expect(state.phase).toBe(PHASE.GREETINGS);
    expect(state.round).toBe(2);
    expect(state.theme).toBeUndefined();
    expect(state.phaseEndsAt).toBeUndefined();
    expect(state.cutoffAt).toBeUndefined();
    expect(state.scoresLocked).toBe(false);
    expect(state.winnerTeamId).toBeUndefined();
    expect(state.peoplesChoiceTeamId).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["incrementRound", "emit", "clearTimer"]);
    expect(emitOf(r.effects).payload).toMatchObject({ phase: PHASE.GREETINGS, round: 2, serverNow: NOW });
  });

  it("round 2: theme can be re-proposed in GREETINGS", () => {
    const r = transition(state, { type: "gm:setTheme", theme: "Cat graduation", now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toBe(PHASE.GREETINGS);
    expect(r.state.theme).toBe("Cat graduation");
    expect(r.state.round).toBe(2);
  });
});

describe("natural timer expiry paths", () => {
  it("BUILD + timer:expired → SCORING (no setCutoff — no early stop)", () => {
    const state = mkState({ phase: PHASE.BUILD, phaseEndsAt: NOW });
    const r = transition(state, { type: "timer:expired", phase: PHASE.BUILD, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toBe(PHASE.SCORING);
    expect(r.state.cutoffAt).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["emit", "beginScoring", "startTimer"]);
  });

  it("SCORING + timer:expired → JUDGING", () => {
    const state = mkState({ phase: PHASE.SCORING, phaseEndsAt: NOW });
    const r = transition(state, { type: "timer:expired", phase: PHASE.SCORING, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toBe(PHASE.JUDGING);
    expect(r.state.scoresLocked).toBe(true);
    expect(effectTypes(r.effects)).toEqual(["lockScores", "emit", "clearTimer"]);
  });

  it("timer:expired with mismatched event phase is rejected", () => {
    const state = mkState({ phase: PHASE.BUILD });
    const r = transition(state, { type: "timer:expired", phase: PHASE.SCORING, now: NOW });
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe("untimed config: no startTimer effects", () => {
  it("BUILD and SCORING advance without timers when seconds are 0", () => {
    const untimed = { ...DEFAULT_CARD_CONFIG, buildTimerSeconds: 0, scoringTimerSeconds: 0 };
    const lobby = createInitialRuntimeState(GAME, untimed);
    const greetings = transition(lobby, { type: "gm:setTheme", theme: "t", now: NOW });
    expect(greetings.ok).toBe(true);
    if (!greetings.ok) return;
    const build = transition(greetings.state, { type: "gm:approveGreetings", now: NOW });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(build.effects)).toEqual(["emit"]);
    const scoring = transition(build.state, { type: "gm:stopBuild", now: NOW });
    expect(scoring.ok).toBe(true);
    if (!scoring.ok) return;
    expect(scoring.state.phaseEndsAt).toBeUndefined();
    expect(scoring.state.cutoffAt).toBe(NOW);
    expect(effectTypes(scoring.effects)).toEqual(["setCutoff", "emit", "beginScoring"]);
  });

  it("mixed config: untimed BUILD but timed SCORING — stopBuild arms only the scoring timer", () => {
    const mixed = { ...DEFAULT_CARD_CONFIG, buildTimerSeconds: 0, scoringTimerSeconds: 120 };
    const lobby = createInitialRuntimeState(GAME, mixed);
    const greetings = transition(lobby, { type: "gm:setTheme", theme: "t", now: NOW });
    expect(greetings.ok).toBe(true);
    if (!greetings.ok) return;
    const build = transition(greetings.state, { type: "gm:approveGreetings", now: NOW });
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(build.effects)).toEqual(["emit"]);
    const scoring = transition(build.state, { type: "gm:stopBuild", now: NOW });
    expect(scoring.ok).toBe(true);
    if (!scoring.ok) return;
    expect(scoring.state.phaseEndsAt).toBe(NOW + 120 * 1000);
    expect(effectTypes(scoring.effects)).toEqual(["setCutoff", "emit", "beginScoring", "startTimer"]);
  });
});

describe("reveal:auto-expired + reveal timer expiry (30s driver in the hub)", () => {
  it("REVEAL + reveal:auto-expired → RESULTS with the timer cleared", () => {
    const state = mkState({ phase: PHASE.REVEAL, winnerTeamId: "team-a" });
    const r = transition(state, { type: "reveal:auto-expired", now: NOW + 30_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toBe(PHASE.RESULTS);
    expect(r.state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["emit", "clearTimer"]);
  });

  it("REVEAL + timer:expired → RESULTS with the timer cleared (recovered timer after restart)", () => {
    const state = mkState({ phase: PHASE.REVEAL, winnerTeamId: "team-a", phaseEndsAt: NOW + 30_000 });
    const r = transition(state, { type: "timer:expired", phase: PHASE.REVEAL, now: NOW + 30_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toBe(PHASE.RESULTS);
    expect(r.state.phaseEndsAt).toBeUndefined();
    expect(effectTypes(r.effects)).toEqual(["emit", "clearTimer"]);
    expect(emitOf(r.effects).payload).toMatchObject({
      phase: PHASE.RESULTS,
      round: 1,
      serverNow: NOW + 30_000,
    });
  });

  it("timer:expired with a mismatched phase during REVEAL is rejected", () => {
    const state = mkState({ phase: PHASE.REVEAL, winnerTeamId: "team-a" });
    const r = transition(state, { type: "timer:expired", phase: PHASE.SCORING, now: NOW });
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe("reveal:extend — the clickable banner resets the 30s REVEAL timer", () => {
  it("REVEAL + reveal:extend resets phaseEndsAt and re-arms the timer", () => {
    const pickedAt = NOW;
    const extendAt = NOW + 10_000;
    const state = mkState({
      phase: PHASE.REVEAL,
      winnerTeamId: "team-a",
      phaseEndsAt: pickedAt + 30_000,
    });
    const r = transition(state, { type: "reveal:extend", now: extendAt });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Phase label stays REVEAL; the auto-expiry restarts from the extend time.
    expect(r.state.phase).toBe(PHASE.REVEAL);
    expect(r.state.phaseEndsAt).toBe(extendAt + 30_000);
    // clearTimer THEN startTimer — the hub ends up with exactly ONE armed
    // REVEAL timer (the timer service replaces anyway, but the order makes
    // the intent explicit).
    expect(effectTypes(r.effects)).toEqual(["clearTimer", "emit", "startTimer"]);
    expect(r.effects[2]).toEqual({
      type: "startTimer",
      phase: PHASE.REVEAL,
      endsAt: extendAt + 30_000,
    });
    // The same-phase phaseChanged re-emit carries the new phaseEndsAt so the
    // clients' countdowns resync (the reducer always adopts a payload
    // phaseEndsAt — no round bump needed).
    expect(emitOf(r.effects).payload).toMatchObject({
      phase: PHASE.REVEAL,
      round: 1,
      phaseEndsAt: extendAt + 30_000,
      serverNow: extendAt,
    });
  });

  it("reveal:extend outside REVEAL is rejected", () => {
    for (const phase of [PHASE.JUDGING, PHASE.RESULTS, PHASE.BUILD, PHASE.LOBBY]) {
      const state = mkState({ phase });
      const r = transition(state, { type: "reveal:extend", now: NOW });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("REVEAL");
    }
  });
});

describe("illegal transitions", () => {
  it("BUILD → gm:pickWinner rejected", () => {
    const r = transition(mkState({ phase: PHASE.BUILD }), {
      type: "gm:pickWinner",
      teamId: "t",
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("JUDGING");
  });

  it("LOBBY → gm:stopBuild rejected", () => {
    const r = transition(mkState(), { type: "gm:stopBuild", now: NOW });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.length > 0).toBe(true);
  });

  it("player:submitPrompt in SCORING → phase_ended", () => {
    const r = transition(mkState({ phase: PHASE.SCORING }), {
      type: "player:submitPrompt",
      playerId: "p1",
      text: "dog",
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "phase_ended" });
  });

  it("player:submitPrompt in LOBBY/GREETINGS → before_theme", () => {
    for (const phase of [PHASE.LOBBY, PHASE.GREETINGS] as const) {
      const r = transition(mkState({ phase }), {
        type: "player:submitPrompt",
        playerId: "p1",
        text: "dog",
        now: NOW,
      });
      expect(r).toEqual({ ok: false, reason: "before_theme" });
    }
  });

  it("new player join in BUILD → game_in_progress (rejoin allowed)", () => {
    const state = mkState({ phase: PHASE.BUILD });
    expect(transition(state, { type: "player:join", playerId: "p9", isNewPlayer: true, now: NOW })).toEqual({
      ok: false,
      reason: "game_in_progress",
    });
    expect(transition(state, { type: "player:join", playerId: "p1", isNewPlayer: false, now: NOW }).ok).toBe(true);
  });

  it("gm:newRound from BUILD rejected (only from RESULTS)", () => {
    const r = transition(mkState({ phase: PHASE.BUILD }), { type: "gm:newRound", now: NOW });
    expect(r.ok).toBe(false);
  });

  it("gm:approveGreetings from LOBBY rejected", () => {
    expect(transition(mkState(), { type: "gm:approveGreetings", now: NOW }).ok).toBe(false);
  });

  it("gm:setTheme from BUILD rejected", () => {
    expect(
      transition(mkState({ phase: PHASE.BUILD }), { type: "gm:setTheme", theme: "x", now: NOW }).ok,
    ).toBe(false);
  });

  it("gm:stopScoring from BUILD rejected", () => {
    expect(transition(mkState({ phase: PHASE.BUILD }), { type: "gm:stopScoring", now: NOW }).ok).toBe(false);
  });

  it("gm:pickWinner from REVEAL rejected", () => {
    expect(
      transition(mkState({ phase: PHASE.REVEAL }), { type: "gm:pickWinner", teamId: "t", now: NOW }).ok,
    ).toBe(false);
  });

  it("reveal:ack from JUDGING rejected", () => {
    expect(transition(mkState({ phase: PHASE.JUDGING, scoresLocked: true }), { type: "reveal:ack", now: NOW }).ok).toBe(false);
  });

  it("timer:expired in LOBBY / JUDGING / RESULTS rejected", () => {
    for (const phase of [PHASE.LOBBY, PHASE.JUDGING, PHASE.RESULTS]) {
      const r = transition(mkState({ phase }), { type: "timer:expired", phase, now: NOW });
      expect(r.ok).toBe(false);
    }
  });

  it("new player join in GREETINGS allowed (players trickle in while GM sets theme)", () => {
    const state = mkState({ phase: PHASE.GREETINGS });
    expect(transition(state, { type: "player:join", playerId: "p9", isNewPlayer: true, now: NOW }).ok).toBe(true);
  });

  it("rejoin allowed in every phase; new joins rejected from BUILD onward", () => {
    for (const phase of PHASE_ORDER) {
      const state = mkState({ phase });
      expect(transition(state, { type: "player:join", playerId: "p1", isNewPlayer: false, now: NOW }).ok).toBe(true);
      if (phase === PHASE.LOBBY || phase === PHASE.GREETINGS) {
        expect(transition(state, { type: "player:join", playerId: "p9", isNewPlayer: true, now: NOW }).ok).toBe(true);
      } else {
        expect(transition(state, { type: "player:join", playerId: "p9", isNewPlayer: true, now: NOW }).ok).toBe(false);
      }
    }
  });
});

describe("player:submitPrompt cutoff boundary", () => {
  const CUTOFF = 1_000_000;
  const build = mkState({ phase: PHASE.BUILD, cutoffAt: CUTOFF });

  it("now == cutoffAt → rejected (phase_ended)", () => {
    const r = transition(build, {
      type: "player:submitPrompt",
      playerId: "p1",
      text: "cake",
      now: CUTOFF,
    });
    expect(r).toEqual({ ok: false, reason: "phase_ended" });
  });

  it("now == cutoffAt - 1 → accepted with accept-submission effect", () => {
    const r = transition(build, {
      type: "player:submitPrompt",
      playerId: "p1",
      text: "cake",
      now: CUTOFF - 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toBe(build); // self-transition: state unchanged
    expect(effectTypes(r.effects)).toEqual(["accept-submission"]);
    expect(r.effects[0]).toEqual({ type: "accept-submission", playerId: "p1", text: "cake" });
  });

  it("no cutoff configured → always accepted during BUILD", () => {
    const r = transition(mkState({ phase: PHASE.BUILD }), {
      type: "player:submitPrompt",
      playerId: "p1",
      text: "cake",
      now: CUTOFF + 999_999,
    });
    expect(r.ok).toBe(true);
  });
});

describe("helpers", () => {
  it("canTransition mirrors transition().ok", () => {
    const lobby = mkState();
    expect(canTransition(lobby, { type: "gm:setTheme", theme: "t", now: NOW })).toBe(true);
    expect(canTransition(lobby, { type: "gm:stopBuild", now: NOW })).toBe(false);
  });

  it("PHASE_ORDER lists all phases in lifecycle order", () => {
    expect(PHASE_ORDER).toEqual([
      "LOBBY",
      "GREETINGS",
      "BUILD",
      "SCORING",
      "JUDGING",
      "REVEAL",
      "RESULTS",
    ]);
  });

  it("isTimedPhase only BUILD/SCORING", () => {
    expect(isTimedPhase(PHASE.BUILD)).toBe(true);
    expect(isTimedPhase(PHASE.SCORING)).toBe(true);
    expect(isTimedPhase(PHASE.LOBBY)).toBe(false);
    expect(isTimedPhase(PHASE.REVEAL)).toBe(false);
  });

  it("transition never mutates the input state", () => {
    const lobby = mkState();
    transition(lobby, { type: "gm:setTheme", theme: "t", now: NOW });
    expect(lobby.phase).toBe(PHASE.LOBBY);
    expect(lobby.theme).toBeUndefined();
  });
});