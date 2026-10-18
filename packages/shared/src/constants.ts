/**
 * @cardcrafters/shared — canonical game constants.
 *
 * Every client and the server import these values from here so limits,
 * timers and layout geometry can never drift between sides.
 */

// ---------------------------------------------------------------------------
// Team / prompt limits (hard caps, not GM-configurable)
// ---------------------------------------------------------------------------

/** Maximum number of teams per game. */
export const MAX_TEAMS = 10;
/** Maximum players per team. */
export const MAX_TEAM_MEMBERS = 12;
/** Minimum players per team (solo play allowed). */
export const MIN_TEAM_MEMBERS = 1;
/** Maximum words per item prompt (see words.ts countWords for the counter). */
export const MAX_PROMPT_WORDS = 6;

// ---------------------------------------------------------------------------
// GM-configurable runtime limits — these are the DEFAULTS the GM can override
// in the game config (mirrored in CardConfig.limits in types.ts).
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Minimum delay between a player's prompt submissions. */
  COOLDOWN_MS: 5000,
  /** Max prompts a player may have validating/generating at once. */
  MAX_INFLIGHT_PER_PLAYER: 3,
  /** Max items allowed on a single card. */
  MAX_ITEMS_PER_CARD: 25,
} as const;

// ---------------------------------------------------------------------------
// Timers (seconds). Timers are OPTIONAL: 0 or absent means untimed — the phase
// advances only when the GM manually advances it.
// ---------------------------------------------------------------------------

/** Default BUILD phase length in seconds (10 minutes). */
export const BUILD_TIMER_SECONDS = 600;
/** Default SCORING phase length in seconds (5 minutes). */
export const SCORING_TIMER_SECONDS = 300;
/** REVEAL auto-advances to RESULTS after this many seconds (hub-armed timer). */
export const REVEAL_AUTO_EXPIRE_SECONDS = 30;
/** Hard cap on ANY phase timer (24 h) — guards setTimeout overflow (2^31−1 ms). */
export const MAX_TIMER_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Card canvas & layout geometry
// ---------------------------------------------------------------------------

/** Default card aspect ratio width (5:7 portrait card). */
export const DEFAULT_CARD_RATIO_W = 5;
/** Default card aspect ratio height. */
export const DEFAULT_CARD_RATIO_H = 7;
/**
 * Layout coordinate space: placements are expressed in a normalized 0–1000
 * space regardless of the card's pixel size, then scaled for rendering.
 */
export const CARD_COORD_SPACE = 1000;
/** Safe margin (%) from card edges where item centers should stay. */
export const SAFE_MARGIN_PCT = 4;
/** Minimum item size as % of card width. */
export const MIN_ITEM_SIZE_PCT = 6;
/**
 * Maximum item size as % of card width. Safety ceiling only — the real size
 * driver is the coverage-proportional target (see SOLO_ITEM_COVERAGE /
 * TOTAL_COVERAGE_TARGET in the solver). Raised from 45 so a solo item can
 * grow toward "occupying the card" (65% card-area ≈ 80%+ width for a square
 * sticker on the default 5:7 card).
 */
export const MAX_ITEM_SIZE_PCT = 85;
/**
 * Target fraction of the CARD AREA a single (solo) item should occupy —
 * "as big as possible" while still leaving visible card margins.
 */
export const SOLO_ITEM_COVERAGE = 0.65;
/**
 * Target fraction of the card area shared by ALL items once several exist.
 * The solver splits this across items proportionally to visualWeight, so the
 * displayed total area stays roughly constant as items arrive and each item
 * rescales down when a new one lands.
 */
export const TOTAL_COVERAGE_TARGET = 0.5;
/**
 * Max allowed pairwise overlap ratio between two items (0–1).
 *
 * USER DECISION (sizing-accuracy pass): the tolerance is 10% — "slight
 * overlap ≤ 10% is allowable" — and it is the SINGLE cap for EVERY item
 * count. The old scheme (general 0.25 plus a relaxed SMALL_N_OVERLAP_CAP =
 * 0.35 for n ≤ 3) is gone: few-item layouts now fill the card through the
 * coverage-proportional size targets and the TRUE rotated-rect overlap
 * measure (see rotatedRectOverlapArea in server/layout/constraints.ts), not
 * through a looser cap. The overlap ratio is measured on the actual rotated
 * rectangles — a pair whose bounding boxes brush but whose visible overlap
 * is within tolerance is legal.
 */
export const MAX_PAIRWISE_OVERLAP = 0.10;

/** Debounce before a client persists layout edits (ms). */
export const LAYOUT_DEBOUNCE_MS = 1500;

/**
 * Vision layout-critique pacing (build phase):
 *  - BUFFER: trailing buffer after a layout commit before the critique runs;
 *    a sticker arriving within the buffer re-arms the SAME single timer
 *    (trailing edge, same semantics as LAYOUT_DEBOUNCE_MS) instead of
 *    stacking critiques.
 *  - MIN_INTERVAL: safety net — two critiques for the same team are never
 *    closer than this, even if layouts keep landing.
 *  - LOW_SCORE: a verdict below this score (or a failed focal check) flags
 *    the layout to the GM (see the critique scheduler).
 */
export const LAYOUT_CRITIQUE_BUFFER_MS = 5000;
export const LAYOUT_CRITIQUE_MIN_INTERVAL_MS = 45000;
export const LAYOUT_CRITIQUE_LOW_SCORE = 55;

// ---------------------------------------------------------------------------
// Final montage pass — phase-3 "movie poster" compositor (server/layout/montage)
// ---------------------------------------------------------------------------

/**
 * Soft-fade (feather) fraction of a sticker's DRAWN width — the band where
 * the sticker alpha ramps 0→1 so overlapping stickers blend like a collage
 * instead of hard-edge pasting. Documented band is 3–6% of drawn width; the
 * default sits in the middle. Applied only on the final-card render
 * (finalPass: true) — never on build-phase renders (byte-identical).
 */
export const MONTAGE_FEATHER_FRACTION = 0.045;
/**
 * Multiplier applied to MAX_PAIRWISE_OVERLAP during the FINAL montage pass —
 * ALWAYS (the pass no longer waits for the AI to opt in via relaxOverlap).
 * The 0.10 pair cap relaxes to 0.18 (0.10 × 1.8), letting supporting stickers
 * lean into the hero sticker for a blended-poster look. Never applied outside
 * the final pass, so in-build layouts keep the strict cap.
 */
export const MONTAGE_OVERLAP_RELAX_FACTOR = 1.8;
/**
 * Spacing-term comfort scale for the montage solver pass. Values BELOW 1 let
 * the solver pack stickers tighter than the in-build layout (which targets
 * comfortable spacing) — 0.7 trades some breathing room for a denser,
 * more poster-like final card. ALWAYS passed by the final montage pass;
 * default build-phase solves never set it, so their spacing term is
 * unchanged.
 */
export const MONTAGE_SPACE_COMFORT_SCALE = 0.7;
/**
 * Union-coverage target for the montage solver pass (fraction of the card
 * area covered by drawn sticker bounds, 0–1). The in-build solver targets
 * ~0.8 (COVERAGE_TARGET); the final montage aims slightly higher (0.9) so
 * the poster card reads full rather than sparse. The solver escalates its
 * packing up to this target before giving up with its best effort.
 */
export const MONTAGE_COVERAGE_TARGET = 0.9;
/**
 * Per-team cap on the whole montage pass (AI calls + solve + render), in ms.
 * SCORING is a short phase; the montage must never block scoring entry for a
 * team whose AI call hangs — past this the pass aborts and the card ships
 * with its build-phase layout.
 */
export const MONTAGE_PASS_TIMEOUT_MS = 30_000;

/**
 * Strategies the layout_montage AI task may pick. Each maps to a distinct
 * compositor arrangement:
 *  - character_montage: dominant hero sticker center, supporting cast around
 *    it at varying scales (the default movie-poster arrangement).
 *  - narrative_composite: items composed as a left→right / layered scene that
 *    reads as one story at a glance.
 *  - floating_heads: items shrunk toward the top/bottom bands in a grid-like
 *    credits arrangement, leaving a clear title zone in the middle.
 */
export const MONTAGE_STRATEGIES = [
  "character_montage",
  "narrative_composite",
  "floating_heads",
] as const;
/** Tween duration when applying remote layout updates (ms). */
export const LAYOUT_TWEEN_MS = 600;

/** Default AI spend budget per game, in USD (GM-configurable). */
export const DEFAULT_AI_BUDGET_USD = 50;

// ---------------------------------------------------------------------------
// Enums — const-object style so zod enums and TS unions share one source.
// ---------------------------------------------------------------------------

export const PHASE_VALUES = [
  "LOBBY",
  "GREETINGS",
  "BUILD",
  "SCORING",
  "JUDGING",
  "REVEAL",
  "RESULTS",
] as const;

/** Game lifecycle phase. */
export type Phase = (typeof PHASE_VALUES)[number];

/** Lookup object form (e.g. `PHASE.BUILD`). */
export const PHASE = Object.fromEntries(
  PHASE_VALUES.map((p) => [p, p]),
) as Readonly<Record<Phase, Phase>>;

export const ITEM_STATUS_VALUES = [
  "PENDING",
  "VALIDATING",
  "GENERATING",
  "READY",
  "FAILED",
  "REJECTED",
  "REMOVED",
] as const;

/** Lifecycle of a single card item (prompt → image → placed/removed). */
export type ItemStatus = (typeof ITEM_STATUS_VALUES)[number];

/** Lookup object form (e.g. `ITEM_STATUS.READY`). */
export const ITEM_STATUS = Object.fromEntries(
  ITEM_STATUS_VALUES.map((s) => [s, s]),
) as Readonly<Record<ItemStatus, ItemStatus>>;