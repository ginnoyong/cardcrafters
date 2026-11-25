import PresenterClient from "./presenter-client";

/** Presenter (big-screen) view — the full canvas grid lands in later steps. */
export default async function PresentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  /** Next 15: searchParams is a Promise — `?card=<cardId>` focuses the stage
 *  on that card (deep link from the GM judge boxes; the scoring order is
 *  shuffled so only the exact cardId is reliable). `?team=<id>` is still
 *  honored as a direct team focus for pre-card phases. */
  searchParams: Promise<{ card?: string | string[]; team?: string | string[] }>;
}) {
  const { code } = await params;
  const { card, team } = await searchParams;
  return (
    <PresenterClient
      code={code.toUpperCase()}
      focusCardId={typeof card === "string" ? card : undefined}
      focusTeamId={typeof team === "string" ? team : undefined}
    />
  );
}
