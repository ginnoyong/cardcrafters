/**
 * @cardcrafters/shared — DTO types shared by the server and all clients.
 *
 * These describe wire shapes (WebSocket payloads, REST-ish snapshots). The
 * zod schemas in schemas.ts are the source of truth for validation; these
 * interfaces mirror them for typing convenience. Keep them in sync.
 */

import type { ItemStatus, Phase } from "./constants";

// ---------------------------------------------------------------------------
// Game config
// ---------------------------------------------------------------------------

/** GM-configurable runtime limits (defaults live in LIMITS in constants.ts). */
export interface CardLimitsConfig {
  cooldownMs: number;
  maxInflightPerPlayer: number;
  maxItemsPerCard: number;
}

export interface CardConfig {
  cardRatioW: number;
  cardRatioH: number;
  /** BUILD timer in seconds; 0 or absent = untimed (GM advances manually). */
  buildTimerSeconds?: number;
  /** SCORING timer in seconds; 0 or absent = untimed. */
  scoringTimerSeconds?: number;
  limits: CardLimitsConfig;
  /** Whether team scores are visible on the presenter view during scoring. */
  scoringVisibleOnPresenter: boolean;
  /** AI spend budget for the whole game, in USD (default DEFAULT_AI_BUDGET_USD = 50). */
  aiBudgetUsd: number;
}

/** Sensible defaults a new game starts with. */
export const DEFAULT_CARD_CONFIG: CardConfig = {
  cardRatioW: 5,
  cardRatioH: 7,
  buildTimerSeconds: 600,
  scoringTimerSeconds: 300,
  limits: {
    cooldownMs: 5000,
    maxInflightPerPlayer: 3,
    maxItemsPerCard: 25,
  },
  scoringVisibleOnPresenter: false,
  aiBudgetUsd: 50,
};

/** Compact game config sent to clients on join / phase change. */
export interface GameConfigSummary {
  gameCode: string;
  phase: Phase;
  cardRatioW: number;
  cardRatioH: number;
  buildTimerSeconds?: number;
  scoringTimerSeconds?: number;
  limits: CardLimitsConfig;
  scoringVisibleOnPresenter: boolean;
  aiBudgetUsd: number;
}

// ---------------------------------------------------------------------------
// Items (AI-generated card ingredients)
// ---------------------------------------------------------------------------

export type { ItemStatus, Phase };

/**
 * Axis-aligned bounding box of the VISIBLE artwork inside a sticker's frame,
 * in FRAME pixel coordinates (same space as Item.width/height; top-left
 * origin). Stickers are die-cut PNGs: the artwork floats inside a larger
 * transparent canvas, so the frame's box overestimates the visual footprint.
 * Extracted at generation time (image/content-box.ts) and consumed by the
 * layout solver for tighter collision. Clients render the frame and don't
 * need it.
 */
export interface ContentBox {
  /** Left edge of the visible content, in frame px. */
  x: number;
  /** Top edge of the visible content, in frame px. */
  y: number;
  /** Visible-content width in frame px. */
  w: number;
  /** Visible-content height in frame px. */
  h: number;
}

/**
 * A single card item. `promptRaw` is exactly what the player typed; `subject`
 * is the normalized subject extracted by the AI validation step.
 */
export interface Item {
  id: string;
  promptRaw: string;
  subject?: string;
  status: ItemStatus;
  imageUrl?: string;
  /** Rendered image width in px (for aspect-correct placement). */
  width?: number;
  /** Rendered image height in px. */
  height?: number;
  /** Bounding box of the visible artwork within the frame (server-side layout
   *  metadata; may be absent for items generated before this field existed). */
  contentBox?: ContentBox;
  /** Display nickname of the player who submitted the prompt. */
  nickname: string;
  /** Epoch ms. */
  createdAt: number;
  /** Why the item failed or was rejected (set for FAILED/REJECTED). */
  failReason?: string;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Placement of one item in the normalized 0–1000 card coordinate space. */
export interface Placement {
  itemId: string;
  x: number;
  y: number;
  scale: number;
  /** Rotation in degrees. */
  rotation: number;
  zIndex: number;
}

export type GreetingTextAlign = "left" | "center" | "right";

/** Styling of the greeting text overlay on the card. */
export interface GreetingStyle {
  font?: string;
  color?: string;
  align?: GreetingTextAlign;
  /** Y position of the text zone in the 0–1000 space. */
  y?: number;
}

/** Who produced the current layout. */
export type LayoutSource = "ai" | "manual" | "gm";

export interface LayoutState {
  /** Monotonic version, bumped on every committed change (last-write-wins). */
  version: number;
  placements: Placement[];
  greetingStyle?: GreetingStyle;
  source: LayoutSource;
}

// ---------------------------------------------------------------------------
// Greetings, scoring, teams
// ---------------------------------------------------------------------------

export type GreetingStatus = "proposed" | "approved" | "edited";

/** The team's greeting text overlay (AI-generated variations, GM/player pick). */
export interface Greeting {
  teamId: string;
  text: string;
  status: GreetingStatus;
}

/** Score value 1..10 enforced by scoreSubmitSchema. */
export type ScoreValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** One score row in the results table. */
export interface ScoreRow {
  label: string;
  value: ScoreValue;
}

/**
 * One card in the scoring order. `cardId` is the opaque scoring id
 * ("card-a"…) and `label` the public display string ("Card A"…).
 *
 * Anonymity status (Dispatch 2, user decision 2a):
 *  - `teamName` IS sent to players — the player scoring UI shows real team
 *    names while rating; the presenter copy stays ANONYMOUS (cardId+label
 *    only, never teamName/teamId);
 *  - `teamId` remains the server/GM-side mapping and is STILL STRIPPED from
 *    every player-facing payload (see buildSyncFull + flows/scoring.ts).
 */
export interface ScoringCard {
  /** Opaque anonymous id ("card-a", "card-b", …) — never the team id. */
  cardId: string;
  /** Public display label ("Card A", "Card B", …). */
  label: string;
  /** The card's real team name — SENT TO PLAYERS (anonymity dropped for the
   *  scoring UI per user decision 2a). */
  teamName: string;
  /** The card's team — GM/presenter/server ONLY, never sent to players. */
  teamId: string;
}

/** Persisted on Game.scoringOrder when a round enters SCORING. */
export interface ScoringOrder {
  /** Round the order belongs to (stale orders from previous rounds are ignored). */
  round: number;
  /** One entry per team, shuffled deterministically per game+round. */
  cards: ScoringCard[];
}

/** Team summary used in lobby, scoring and results views. */
export interface TeamSummary {
  id: string;
  name: string;
  /** Short display label (e.g. "Team A"). */
  label: string;
  playerCount: number;
  itemCount: number;
  /** Average score once scoring has happened. */
  avgScore?: number;
}