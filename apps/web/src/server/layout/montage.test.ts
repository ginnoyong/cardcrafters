/**
 * Final-montage-pass tests (plan step 6) — the IO orchestration end-to-end
 * with the memory repo + injected fakes (NO redis, NO real provider):
 *
 *  - success: the montage solve is ADOPTED ALWAYS (no score comparison) —
 *    persisted as version+1 with source "montage" and broadcast with the
 *    engine's layout:updated payload shape;
 *  - AI failure / schema-invalid output / per-team timeout / stale version
 *    write: the settled build-phase layout is kept untouched (no upsert, no
 *    emit, no throw);
 *  - mock mode (mockMode flag OR no AI wired): a total short-circuit — zero
 *    ai.run calls, zero upserts, zero emits;
 *  - no sized READY items anywhere: silent return before any AI work.
 *
 * The AI/render seams are injected; the per-team timeout is injectable
 * (deps.timeoutMs) so the timeout path runs in milliseconds, not the shared
 * 30s constant. All timers used in tests are real (short waits only).
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CARD_CONFIG,
  type CardConfig,
  type Placement,
} from "@cardcrafters/shared";

import { GameHub, type RoomEmitter } from "../game/hub";
import { MemoryRepo } from "../repo/memory-repo";
import {
  cardBox,
  baseFit,
  COORD_DIMS,
} from "./constraints";
import { solveLayout, mulberry32, hashString } from "./solver";
import { runMontagePass, type MontageAi, type MontageDeps } from "./montage";
import { defaultTextZone, type LayoutEmit } from "./engine";

/** No phase timers armed (buildTimerSeconds 0) — nothing to clean up. */
const UNTIMED_CONFIG: CardConfig = {
  ...DEFAULT_CARD_CONFIG,
  buildTimerSeconds: 0,
  scoringTimerSeconds: 0,
};

interface RecordedEmit {
  event: "layout:updated";
  payload: Record<string, unknown>;
  ctx: { gameId: string; teamId: string };
}

/** A schema-valid layout_montage payload built from the REAL card geometry
 *  (so it is always within the coord bounds) and the real item ids. */
function montagePayload(itemId: string, card: { w: number; h: number }) {
  const cy = card.h * 0.62; // below the reserved greeting band
  return {
    focalPoint: { x: card.w / 2, y: cy },
    groups: [
      { itemIds: [itemId], cx: card.w / 2, cy, spread: 40, subject: "ensemble" },
    ],
    hints: [{ itemId, role: "focal" as const, importance: 1 }],
    textZone: {
      x: card.w * 0.1,
      y: card.h * 0.06,
      w: card.w * 0.8,
      h: card.h * 0.16,
    },
    suggestedGreetingStyle: { color: "#336699", align: "center" as const },
    strategy: "character_montage" as const,
    relaxOverlap: false,
  };
}

interface Setup {
  repo: MemoryRepo;
  gameId: string;
  teamId: string;
  /** The READY item created in setup (MemoryRepo ids are UUIDs). */
  itemId: string;
  /** The settled build-phase layout committed in setup. */
  settled: { version: number; placements: Placement[]; source: string };
  events: RecordedEmit[];
  emit: LayoutEmit;
  render: ReturnType<typeof vi.fn>;
  /** deps.ai for the pass (a vi.fn the test programs per case). */
  aiRun: ReturnType<typeof vi.fn>;
  card: { w: number; h: number };
}

async function setup(opts: { withItem?: boolean } = {}): Promise<Setup> {
  const withItem = opts.withItem ?? true;
  const repo = new MemoryRepo();
  const io: RoomEmitter = { to: () => ({ emit() {} }) };
  const hub = new GameHub(repo, io);
  const { game } = await hub.createGame(UNTIMED_CONFIG, { teamCount: 1 });
  const team = (await repo.listTeams(game.id))[0]!;

  const card = cardBox(COORD_DIMS, game.config.cardRatioW, game.config.cardRatioH);

  // Real card state: one READY item, a committed layout, a greeting —
  // exactly what the montage worker gathers from the repo.
  let itemId = "";
  const settledPlacements: Placement[] = [];
  if (withItem) {
    const item = await repo.createItem({
      teamId: team.id,
      playerId: "player-1",
      round: 1,
      promptRaw: "red balloon",
      subject: "red balloon",
      status: "READY",
    });
    itemId = item.id;
    await repo.updateItem(item.id, {
      width: 256,
      height: 256,
      imageUrl: "/static/items/item-1.png",
    });
    settledPlacements.push({
      itemId: item.id,
      x: 357,
      y: 550,
      scale: 1.85,
      rotation: 0,
      zIndex: 0,
    });
    await repo.upsertLayoutState(team.id, 1, {
      version: 1,
      placements: settledPlacements,
      source: "solver",
    });
    await repo.createGreeting({ teamId: team.id, round: 1, text: "Happy Birthday, Sam!" });
  }

  const events: RecordedEmit[] = [];
  const emit: LayoutEmit = (event, payload, ctx) => events.push({ event, payload, ctx });
  // A render that throws if the mock/short-circuit paths ever call it; the
  // real path needs a non-empty "PNG" so imageBase64 is non-trivial.
  const render = vi.fn(async () => Buffer.alloc(64, 0x89));
  const aiRun = vi.fn();

  return {
    repo,
    gameId: game.id,
    teamId: team.id,
    itemId,
    settled: { version: 1, placements: settledPlacements, source: "solver" },
    events,
    emit,
    render,
    aiRun,
    card,
  };
}

function makeDeps(s: Setup, extra: Partial<MontageDeps> = {}): MontageDeps {
  return {
    repo: s.repo,
    ai: { run: s.aiRun } satisfies MontageAi,
    mockMode: false,
    emit: s.emit,
    render: s.render as unknown as MontageDeps["render"],
    ...extra,
  } as MontageDeps;
}

describe("runMontagePass", () => {
  it("success: adopts the montage solve — version+1, source 'montage', engine-shaped emit", async () => {
    const s = await setup();
    s.aiRun.mockResolvedValue({ data: montagePayload(s.itemId, s.card) });

    await expect(runMontagePass(makeDeps(s), s.gameId)).resolves.toBeUndefined();

    // Exactly one vision call for the one team, with the critique-style image
    // vars + the prompt's text vars.
    expect(s.aiRun).toHaveBeenCalledTimes(1);
    const [task, input, callOpts] = s.aiRun.mock.calls[0]!;
    expect(task).toBe("layout_montage");
    expect(callOpts).toEqual({ gameId: s.gameId });
    expect(input).toMatchObject({
      imageMime: "image/png",
      cardWidth: s.card.w,
      cardHeight: s.card.h,
      textHint: "Happy Birthday, Sam!",
      items: [
        { id: s.itemId, w: 256, h: 256, visualWeight: 0, orderIndex: 0, subject: "red balloon" },
      ],
    });
    expect(typeof (input as { imageBase64: string }).imageBase64).toBe("string");
    expect((input as { imageBase64: string }).imageBase64.length).toBeGreaterThan(0);

    // The settled card is rendered for the AI — WITHOUT finalPass (the model
    // judges geometry, not polish).
    expect(s.render).toHaveBeenCalledTimes(1);
    const renderOpts = s.render.mock.calls[0]![3] as Record<string, unknown>;
    expect(renderOpts.cardRatioW).toBe(DEFAULT_CARD_CONFIG.cardRatioW);
    expect(renderOpts.cardRatioH).toBe(DEFAULT_CARD_CONFIG.cardRatioH);
    expect(renderOpts.finalPass).toBeUndefined();
    expect(renderOpts.grading).toBeUndefined();

    // Persisted: version+1, source "montage", placements = the exact solve
    // the module should have run (same opts the engine passes + montage seed).
    const row = await s.repo.getLayoutState(s.teamId, 1);
    const items = (await s.repo.listItems(s.teamId, 1, ["READY"])).map((r, orderIndex) => ({
      id: r.id,
      imgW: r.width!,
      imgH: r.height!,
      visualWeight: r.visualWeight ?? 0,
      orderIndex,
      subject: r.subject ?? undefined,
    }));
    const expected = solveLayout(items, {
      cardDims: s.card,
      k: baseFit(s.card),
      textZone: defaultTextZone(s.card),
      hints: montagePayload(s.itemId, s.card),
      rng: mulberry32(hashString(`${s.teamId}:1:montage`)),
    });
    expect(row!.version).toBe(s.settled.version + 1);
    expect(row!.source).toBe("montage");
    expect(row!.placements).toEqual(expected.placements);
    expect(row!.placements).not.toEqual(s.settled.placements);

    // Broadcast with the engine's payload shape, source "montage".
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.event).toBe("layout:updated");
    expect(s.events[0]!.ctx).toEqual({ gameId: s.gameId, teamId: s.teamId });
    expect(s.events[0]!.payload).toEqual({
      version: s.settled.version + 1,
      placements: row!.placements,
      source: "montage",
    });
  });

  it("AI failure (ai.run rejects): settled layout intact, no upsert, no emit, no throw", async () => {
    const s = await setup();
    s.aiRun.mockRejectedValue(new Error("vision model exploded"));

    await expect(runMontagePass(makeDeps(s), s.gameId)).resolves.toBeUndefined();

    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(row!.source).toBe(s.settled.source);
    expect(row!.placements).toEqual(s.settled.placements);
    expect(s.events).toHaveLength(0);
  });

  it("schema-invalid AI output: same fallback (the module's parse catches what an injected router bypasses)", async () => {
    const s = await setup();
    // Missing focalPoint/groups/textZone/suggestedGreetingStyle → invalid.
    s.aiRun.mockResolvedValue({ data: { strategy: "character_montage" } });

    await expect(runMontagePass(makeDeps(s), s.gameId)).resolves.toBeUndefined();

    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(row!.source).toBe(s.settled.source);
    expect(s.events).toHaveLength(0);
  });

  it("mock mode (mockMode: true): zero ai.run calls, zero upserts, zero emits", async () => {
    const s = await setup();
    s.aiRun.mockResolvedValue({ data: montagePayload(s.itemId, s.card) });

    await expect(
      runMontagePass(makeDeps(s, { mockMode: true }), s.gameId),
    ).resolves.toBeUndefined();

    expect(s.aiRun).not.toHaveBeenCalled();
    expect(s.render).not.toHaveBeenCalled();
    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(row!.source).toBe(s.settled.source);
    expect(s.events).toHaveLength(0);
  });

  it("mock mode (no AI wired): identical short-circuit", async () => {
    const s = await setup();
    await expect(
      runMontagePass(makeDeps(s, { ai: null, mockMode: false }), s.gameId),
    ).resolves.toBeUndefined();

    expect(s.render).not.toHaveBeenCalled();
    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(s.events).toHaveLength(0);
  });

  it("per-team timeout (injectable timeoutMs): a hung ai.run → team falls back fast, no emit, no throw", async () => {
    const s = await setup();
    // Never resolves — the pass must not wait for it.
    s.aiRun.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    await expect(
      runMontagePass(makeDeps(s, { timeoutMs: 25 }), s.gameId),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000); // cut short, not 30s+

    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(row!.source).toBe(s.settled.source);
    expect(s.events).toHaveLength(0);
  });

  it("version conflict (stale upsert rejected): settled kept, no emit, no throw", async () => {
    const s = await setup();
    s.aiRun.mockResolvedValue({ data: montagePayload(s.itemId, s.card) });
    const stale = new Error("stale layout write: version 2 < current 3");
    vi.spyOn(s.repo, "upsertLayoutState").mockRejectedValueOnce(stale);

    await expect(runMontagePass(makeDeps(s), s.gameId)).resolves.toBeUndefined();

    const row = await s.repo.getLayoutState(s.teamId, 1);
    expect(row!.version).toBe(s.settled.version);
    expect(row!.source).toBe(s.settled.source);
    expect(row!.placements).toEqual(s.settled.placements);
    expect(s.events).toHaveLength(0);
  });

  it("no sized READY items anywhere: silent return, zero AI calls, zero renders", async () => {
    const s = await setup({ withItem: false });

    await expect(runMontagePass(makeDeps(s), s.gameId)).resolves.toBeUndefined();

    expect(s.aiRun).not.toHaveBeenCalled();
    expect(s.render).not.toHaveBeenCalled();
    expect(s.events).toHaveLength(0);
  });
});