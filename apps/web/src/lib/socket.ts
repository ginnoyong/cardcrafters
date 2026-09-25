/**
 * Client-side Socket.IO helper — thin, typed wrappers around socket.io-client
 * shared by the GM console, player join and presenter views.
 *
 * Wire contract (see src/server/ws/server.ts):
 *  - every client→server event is validated with a shared zod schema;
 *  - `join` acks `{ ok: true, identity, rooms }` (or `{ ok: false, error, ... }`)
 *    and is followed by a `sync:full` snapshot for THIS socket only;
 *  - `sync:resync` re-emits the full snapshot;
 *  - all server→client events carry the `{ gameId, round, ts, seq }` envelope.
 */

import { io, type Socket } from "socket.io-client";

import { joinSchema, type Role } from "@cardcrafters/shared";

/** Standard server ack for every client→server call. */
export type AckResult =
  | { ok: true; identity?: unknown; rooms?: string[]; phase?: string }
  | { ok: false; error: string; code?: string; reason?: string };

export interface SocketAuthOptions {
  role?: Role;
  /** Game code for gm/presenter handshakes (auth IS knowing the code). */
  gameCode?: string;
  /** Player session token for reconnects (also read from cc_session cookie). */
  sessionToken?: string;
  /** Override the server URL (tests / cross-origin); defaults to same origin. */
  url?: string;
}

/**
 * Create (but do not connect) a socket. Call `socket.connect()` when the UI
 * is ready so the connection indicator reflects real state.
 */
export function createGameSocket(opts: SocketAuthOptions = {}): Socket {
  const auth: Record<string, unknown> = {};
  if (opts.role) auth.role = opts.role;
  if (opts.gameCode) auth.gameCode = opts.gameCode;
  if (opts.sessionToken) auth.sessionToken = opts.sessionToken;
  return io(opts.url ?? window.location.origin, {
    path: "/socket.io",
    transports: ["websocket"],
    autoConnect: false,
    auth,
  });
}

/** Build a validated `join` payload (throws if it would violate the schema). */
export function joinPayload(input: {
  role: Role;
  joinToken?: string;
  nickname?: string;
}): Record<string, unknown> {
  return joinSchema.parse(input) as unknown as Record<string, unknown>;
}

/** Promisified emit with ack. Resolves with whatever the server acked. */
export function emitAck<T = AckResult>(
  socket: Socket,
  event: string,
  payload?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeoutMs);
    socket.emit(event, payload ?? {}, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/** Typed `on` that returns an unsubscriber (for useEffect cleanup). */
export function onEvent<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  handler: (payload: T) => void,
): () => void {
  const wrapped = (payload: T): void => handler(payload);
  socket.on(event, wrapped);
  return () => socket.off(event, wrapped);
}

/** Friendly messages for the common join failure reasons. */
export function friendlyJoinError(error: string | undefined): string {
  const e = error ?? "";
  if (/joinToken required|invalid joinToken/i.test(e)) return "This join link is not valid — ask your host for a fresh QR code.";
  if (/is full/i.test(e)) return "That team is full (12 players max) — pick another team's QR code.";
  if (/LOBBY/i.test(e)) return "The round already started — ask your host to start a new round.";
  if (/stale session/i.test(e)) return "Your saved session expired. Join again with your team's QR code.";
  return e || "Join failed — please try again.";
}