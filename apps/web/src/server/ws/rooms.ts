/**
 * Socket.IO room naming + join helpers.
 *
 * All rooms are namespaced under `game:<gameId>` so a single Socket.IO server
 * can host many games without cross-talk:
 *   game:{id}                — everyone in the game (players, GM, presenter)
 *   game:{id}:team:{teamId}  — one team
 *   game:{id}:gm             — the GM client(s)
 *   game:{id}:presenter      — the presenter (big-screen) client(s)
 *   game:{id}:player:{pid}   — direct messages to a single player
 */

export const gameRoom = (gameId: string): string => `game:${gameId}`;
export const teamRoom = (gameId: string, teamId: string): string =>
  `game:${gameId}:team:${teamId}`;
export const gmRoom = (gameId: string): string => `game:${gameId}:gm`;
export const presenterRoom = (gameId: string): string => `game:${gameId}:presenter`;
export const playerRoom = (gameId: string, playerId: string): string =>
  `game:${gameId}:player:${playerId}`;

/** A socket's resolved identity (set during the `join` handshake). */
export type WsIdentity =
  | {
      role: "player";
      gameId: string;
      code: string;
      playerId: string;
      teamId: string;
      nickname: string;
      sessionToken: string;
    }
  | { role: "gm"; gameId: string; code: string }
  | { role: "presenter"; gameId: string; code: string };

/**
 * Rooms a socket with the given identity should be a member of.
 *
 * `teamIds` (optional): for GM/presenter identities the caller passes the
 * game's team ids so the GM console / presenter board also receive the
 * per-team room events (item:pending, item:ready, …) for their live card
 * previews. Players never pass it — they only ever belong to ONE team.
 */
export function roomsForIdentity(identity: WsIdentity, teamIds?: string[]): string[] {
  const rooms = [gameRoom(identity.gameId)];
  if (identity.role === "player") {
    rooms.push(teamRoom(identity.gameId, identity.teamId));
    // Direct room so hub `notify` effects (and other player-targeted emits)
    // are deliverable to this socket.
    rooms.push(playerRoom(identity.gameId, identity.playerId));
  } else if (identity.role === "gm") {
    rooms.push(gmRoom(identity.gameId));
    for (const teamId of teamIds ?? []) rooms.push(teamRoom(identity.gameId, teamId));
  } else {
    rooms.push(presenterRoom(identity.gameId));
    for (const teamId of teamIds ?? []) rooms.push(teamRoom(identity.gameId, teamId));
  }
  return rooms;
}
