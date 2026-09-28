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