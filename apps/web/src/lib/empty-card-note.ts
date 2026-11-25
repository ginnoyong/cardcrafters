/**
 * empty-card-note — the phase-aware copy for an EMPTY card (0 placed
 * stickers), shared by every CardCanvas face.
 *
 * Two distinct situations share one visual slot (the empty card's centre
 * note under the greeting):
 *
 *  - BUILD (and the pre-build LOBBY/GREETINGS phases): the card is still
 *    being made — the classic teaser is correct there: "Stickers will
 *    appear here as your team creates them…".
 *
 *  - SCORING / JUDGING / REVEAL / RESULTS: the game is OVER — the teaser
 *    reads as a mistake ("your team creates them" implies building is still
 *    possible). The finished treatment is a quiet line in the same paper +
 *    serif voice: "This card stayed blank this round." The greeting (already
 *    drawn above the note on every face) carries the card's identity.
 *
 * Pure copy helper — no React, no Konva, trivially unit-testable (the
 * CardCanvas itself can never render under SSR/node: react-konva).
 */

/** BUILD-phase teaser (unchanged legacy copy — keep it verbatim). */
export const EMPTY_CARD_TEASER = "Stickers will appear here as your team creates them…";

/** Post-BUILD finished treatment (SCORING → RESULTS). */
export const EMPTY_CARD_FINISHED = "This card stayed blank this round.";

/** The empty-card note for the given phase context. */
export function emptyCardNote(building: boolean): string {
  return building ? EMPTY_CARD_TEASER : EMPTY_CARD_FINISHED;
}
