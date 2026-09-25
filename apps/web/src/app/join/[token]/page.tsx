import JoinClient from "./join-client";

/**
 * Player join entry — a QR code / link points here with the TEAM join token.
 * The server component only unwraps the route param; everything else happens
 * client-side (socket join, session cookie, waiting screen).
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <JoinClient token={token} />;
}