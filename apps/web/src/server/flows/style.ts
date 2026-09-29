/**
 * Style flow (build-phase step): derive ONE cohesive visual style for all
 * sticker images from the opening theme, via the `style_derivation` AI task.
 * Runs once per game at BUILD start (gm:approveGreetings); the pack is
 * persisted on the Game row and injected into every item's image prompt.
 */

import type { AiRouter } from "../ai/router";
import { styleDerivationSchema, type StyleDerivation } from "@cardcrafters/shared";
import type { GameHub } from "../game/hub";
import type { Repository } from "../repo/repository";

export interface StyleResult {
  ok: boolean;
  style?: StyleDerivation;
  error?: string;
}

/**
 * Derive + persist the game's visual style pack. Non-fatal on failure: the
 * caller logs a warning and item prompts simply omit the style suffix.
 */
export async function deriveGameStyle(
  hub: GameHub,
  repo: Repository,
  ai: AiRouter,
  gameId: string,
): Promise<StyleResult> {
  const state = await hub.runtimeState(gameId);
  const theme = state.theme ?? "";
  if (!theme) {
    return { ok: false, error: "game has no theme — cannot derive style" };
  }
  try {
    const res = await ai.run("style_derivation", { theme }, { gameId });
    const parsed = styleDerivationSchema.safeParse(res.data);
    if (!parsed.success) {
      return { ok: false, error: `style derivation returned invalid shape: ${parsed.error.message}` };
    }
    await repo.updateGame(gameId, { style: parsed.data });
    return { ok: true, style: parsed.data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "style derivation failed",
    };
  }
}
