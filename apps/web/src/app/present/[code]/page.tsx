import PresenterClient from "./presenter-client";

/** Presenter (big-screen) view — the full canvas grid lands in later steps. */
export default async function PresentPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <PresenterClient code={code.toUpperCase()} />;
}