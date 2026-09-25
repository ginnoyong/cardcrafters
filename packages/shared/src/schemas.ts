/**
 * @cardcrafters/shared — zod schemas.
 *
 * Two groups:
 * (a) AI output schemas — every LLM call's JSON output is parsed with these
 *     before the result is used (exported for the router in Step 4).
 * (b) WebSocket payload schemas — the server validates ALL client→server
 *     payloads with these; clients import the same schemas for typing.
 *     Server→client event schemas are `.passthrough()` where the payload is
 *     still evolving, so extra fields survive instead of being stripped.
 *
 * Uses the zod v3 API (matches zod ^3 installed by Step 0).
 */

import { z } from "zod";

import { CARD_COORD_SPACE, PHASE_VALUES } from "./constants";

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

export const greetingAlignSchema = z.enum(["left", "center", "right"]);
export type GreetingAlign = z.infer<typeof greetingAlignSchema>;

export const greetingStyleSchema = z
  .object({
    font: z.string().min(1).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
    align: greetingAlignSchema.optional(),
    /** Y position in the normalized 0–1000 card space. */
    y: z.number().finite().min(0).max(CARD_COORD_SPACE).optional(),
  })
  .strict();
// NOTE: the matching DTO type lives in types.ts (GreetingStyle); schemas.ts
// deliberately does not re-export a same-named inferred type to avoid barrel
// export ambiguity.

/** Coordinates in the normalized 0–1000 card space. */
const coord = z.number().finite().min(0).max(CARD_COORD_SPACE);

// ---------------------------------------------------------------------------
// (a) AI output schemas
// ---------------------------------------------------------------------------

/** Step: prompt validation. Extracts a normalized subject from the raw prompt. */
export const promptValidationSchema = z
  .object({
    valid: z.boolean(),
    /** Why the prompt was rejected ("" or explanatory text when valid). */
    reason: z.string(),
    normalized_subject: z.string().min(1),
    example_fix: z.string().optional(),
  })
  .strict();
export type PromptValidation = z.infer<typeof promptValidationSchema>;

/**
 * Step: moderation.
 * NOTE: prompts about real people / celebrities are ALLOWED; only contentious
 * figures (criminals, politicians) are blocked, via category
 * "contentious_figure". Generic policy violations use "other".
 */
export const moderationCategorySchema = z.enum([
  "none",
  "hate",
  "sexual",
  "violence",
  "dangerous",
  "contentious_figure",
  "other",
]);
export type ModerationCategory = z.infer<typeof moderationCategorySchema>;

export const moderationSchema = z
  .object({
    safe: z.boolean(),
    category: moderationCategorySchema,
    reason: z.string(),
  })
  .strict();
export type Moderation = z.infer<typeof moderationSchema>;

/** Step: greeting generation — several variations for the team to pick from. */
export const greetingVariationsSchema = z
  .object({
    variations: z.array(z.string().min(1)).min(1).max(10),
  })
  .strict();
export type GreetingVariations = z.infer<typeof greetingVariationsSchema>;

/** Step: style derivation — derives a card art style from the prompt batch. */
export const lineWeightSchema = z.enum(["thin", "medium", "bold"]);
export type LineWeight = z.infer<typeof lineWeightSchema>;

export const styleDerivationSchema = z
  .object({
    styleName: z.string().min(1),
    /** Hex colors, e.g. ["#ff0000", "#fff"]. */
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)).min(1),
    lineWeight: lineWeightSchema,
    mood: z.string().min(1),
    /** Appended to every image generation prompt for style consistency. */
    imagePromptSuffix: z.string().min(1),
  })
  .strict();
export type StyleDerivation = z.infer<typeof styleDerivationSchema>;

/** Step: layout composition — suggests where to group items on the card. */
export const layoutCompositionSchema = z
  .object({
    focalPoint: z.object({ x: coord, y: coord }).strict(),
    groups: z
      .array(
        z
          .object({
            itemIds: z.array(z.string().min(1)).min(1),
            cx: coord,
            cy: coord,
            spread: z.number().finite().min(0),
          })
          .strict(),
      )
      .min(1),
    textZone: z
      .object({ x: coord, y: coord, w: coord, h: coord })
      .strict(),
    suggestedGreetingStyle: greetingStyleSchema,
  })
  .strict();
export type LayoutComposition = z.infer<typeof layoutCompositionSchema>;

// ---------------------------------------------------------------------------
// (b) WebSocket payloads — client → server (strict: reject unknown fields)
// ---------------------------------------------------------------------------

export const roleSchema = z.enum(["player", "gm", "presenter"]);
export type Role = z.infer<typeof roleSchema>;

export const joinSchema = z
  .object({
    role: roleSchema,
    joinToken: z.string().min(1).optional(),
    nickname: z.string().min(1).max(24).optional(),
  })
  .strict();
export type JoinPayload = z.infer<typeof joinSchema>;

export const promptSubmitSchema = z
  .object({
    text: z.string().min(1).max(200),
  })
  .strict();
export type PromptSubmitPayload = z.infer<typeof promptSubmitSchema>;

export const scoreSubmitSchema = z
  .object({
    label: z.string().min(1),
    value: z.number().int().min(1).max(10),
  })
  .strict();
export type ScoreSubmitPayload = z.infer<typeof scoreSubmitSchema>;

export const gmRemoveItemSchema = z.object({ itemId: z.string().min(1) }).strict();
export const gmKickSchema = z.object({ playerId: z.string().min(1) }).strict();
/** GM proposes/changes the round theme (LOBBY → GREETINGS, or re-propose). */
export const gmSetThemeSchema = z.object({ theme: z.string().min(1).max(100) }).strict();
export type GmSetThemePayload = z.infer<typeof gmSetThemeSchema>;
/** GM approves the greetings step → BUILD. */
export const gmApproveGreetingsSchema = z.object({}).strict();
export type GmApproveGreetingsPayload = z.infer<typeof gmApproveGreetingsSchema>;
export const gmRegenGreetingSchema = z.object({ teamId: z.string().min(1) }).strict();
export type GmRegenGreetingPayload = z.infer<typeof gmRegenGreetingSchema>;
/** GM hand-edits a team's greeting text (persists status "edited"). */
export const gmUpdateGreetingSchema = z
  .object({ teamId: z.string().min(1), text: z.string().trim().min(1).max(60) })
  .strict();
export type GmUpdateGreetingPayload = z.infer<typeof gmUpdateGreetingSchema>;
export const judgePickSchema = z.object({ teamId: z.string().min(1) }).strict();
export const revealAckSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// (b) WebSocket payloads — server → client events (passthrough where the
// payload is still evolving, so additive fields survive on old clients)
// ---------------------------------------------------------------------------

/** Epoch-milliseconds timestamp. */
const epochMs = z.number().finite().int().nonnegative();

export const phaseChangedSchema = z
  .object({
    phase: z.enum(PHASE_VALUES),
    /** Absolute epoch ms when the phase timer expires (absent = untimed). */
    phaseEndsAt: epochMs.optional(),
    /** For SCORING: latest moment a score may still be changed. */
    cutoffAt: epochMs.optional(),
    serverNow: epochMs,
  })
  .passthrough();
export type PhaseChangedEvent = z.infer<typeof phaseChangedSchema>;

export const placementSchema = z.object({
  itemId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().finite().positive(),
  /** Degrees. */
  rotation: z.number().finite(),
  zIndex: z.number().finite().int(),
});
// NOTE: the matching DTO type lives in types.ts (Placement).

export const itemPendingSchema = z
  .object({
    itemId: z.string().min(1),
    promptRaw: z.string(),
    nickname: z.string().min(1),
    createdAt: epochMs,
  })
  .passthrough();

export const itemReadySchema = z
  .object({
    itemId: z.string().min(1),
    imageUrl: z.string().min(1),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  })
  .passthrough();

export const itemRejectedSchema = z
  .object({ itemId: z.string().min(1), reason: z.string() })
  .passthrough();

export const itemFailedSchema = z
  .object({ itemId: z.string().min(1), reason: z.string() })
  .passthrough();

export const itemRemovedSchema = z.object({ itemId: z.string().min(1) }).passthrough();

export const layoutUpdatedSchema = z
  .object({
    version: z.number().int().nonnegative(),
    placements: z.array(placementSchema),
    greetingStyle: greetingStyleSchema.optional(),
    source: z.string().min(1),
  })
  .passthrough();
export type LayoutUpdatedEvent = z.infer<typeof layoutUpdatedSchema>;

export const winnerAnnouncedSchema = z
  .object({
    winnerTeamId: z.string().min(1),
    label: z.string().min(1),
    peoplesChoiceTeamId: z.string().min(1).optional(),
  })
  .passthrough();
export type WinnerAnnouncedEvent = z.infer<typeof winnerAnnouncedSchema>;

export const errorSchema = z
  .object({ code: z.string().min(1), message: z.string() })
  .passthrough();
export type ErrorEvent = z.infer<typeof errorSchema>;