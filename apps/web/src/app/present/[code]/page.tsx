import PresenterClient from "./presenter-client";

/** Presenter (big-screen) view — the full canvas grid lands in later steps. */
export default async function PresentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  /** Next 15: searchParams is a Promise — `?team=<id>` focuses the stage. */
  searchParams: Promise<{ team?: string | string[] }>;
}) {
  const { code } = await params;
  const { team } = await searchParams;
  return (
    <PresenterClient
      code={code.toUpperCase()}
      focusTeamId={typeof team === "string" ? team : undefined}
    />
  );
}
