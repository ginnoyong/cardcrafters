/**
 * Socket.IO auth — resolves a socket's session/role hints at handshake time.
 *
 * Resolution sources, in priority order:
 *   1. `socket.handshake.auth` payload  ({ sessionToken?, role?, gameCode? })
 *   2. the `cc_session` cookie (parsed manually — no cookie dependency)
 *
 * Trust model (documented, party-game scope — see README TODO):
 *   - player: a session token resolving to a live Player row authenticates
 *     the reconnect path; brand-new players additionally need a valid team
 *     joinToken + nickname (validated in the hub during the `join` event).
 *   - gm / presenter: trusted once they supply a valid game code. The GM page
 *     holds the code, and the code is only distributed to the game's host.
 *     A dedicated GM token on the Game row would require a schema change and
 *     is deliberately deferred.
 *
 * The heavy lifting (joinToken validation, capacity, LOBBY guard) happens in
 * the `join` event handler; this middleware only pre-resolves hints onto
 * socket.data so every later handler can trust a single normalized shape.
 */

import type { Socket } from "socket.io";

import type { Repository } from "../repo/repository";
import type { WsIdentity } from "./rooms";

export interface HandshakeAuth {
  role?: unknown;
  sessionToken?: unknown;
  gameCode?: unknown;
  [key: string]: unknown;
}

/** Data stashed on every socket by the middleware. */
export interface SocketData {
  /** Session token from auth payload or cc_session cookie (null if absent). */
  sessionToken: string | null;
  /** Client-declared role hint (validated again at join; default "player"). */
  roleHint: "player" | "gm" | "presenter";
  /** Game code supplied by GM/presenter clients at handshake. */
  gameCode: string | null;
  /** Set once the socket has successfully completed the `join` event. */
  identity?: WsIdentity;
}

/** Parse a Cookie header into a flat map (no external dependency). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Normalize a client-supplied string field to a non-empty string or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Socket.IO middleware: extracts session/role hints from the handshake auth
 * payload or the cc_session cookie onto socket.data. Never rejects — bad
 * credentials are handled (and acked) per-event, so clients get actionable
 * errors instead of a silent transport-level failure.
 */
export function socketAuthMiddleware(_repo: Repository) {
  return (socket: Socket, next: (err?: Error) => void): void => {
    const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
    const cookies = parseCookies(socket.handshake.headers.cookie as string | undefined);

    const data = socket.data as SocketData;
    data.sessionToken =
      asString(auth.sessionToken) ?? cookies["cc_session"] ?? null;
    data.gameCode = asString(auth.gameCode);
    data.roleHint =
      auth.role === "gm" || auth.role === "presenter" ? auth.role : "player";
    next();
  };
}
