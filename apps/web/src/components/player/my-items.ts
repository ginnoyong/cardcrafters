"use client";

/**
 * my-items — pure helpers merging the owner ledger (`myItems`) with the team's
 * item rows into "my submissions" (used by the player build screen + tests).
 */

import type { ClientItem, GameSnapshot, MyItemEvent } from "@/lib/store";

/**
 * All of THIS player's items: the team's rows filtered to items I own
 * (playerId from sync:full rows) UNION the owner ledger (myItems — entries
 * whose rows haven't arrived / whose owner-only detail the snapshot rows
 * lack). Ledger fields (status, reason, exampleFix) WIN over row fields —
 * owner-only events are always the freshest authority.
 */
export function selectMyItems(snapshot: GameSnapshot, myTeamId: string, myPlayerId: string | null): ClientItem[] {
  const team = snapshot.teams.find((t) => t.id === myTeamId);
  const ledger = snapshot.myItems;
  const rows = (team?.items ?? []).filter(
    (item) => (myPlayerId != null && item.playerId === myPlayerId) || ledger[item.id] != null,
  );
  const merged = new Map<string, ClientItem>();
  for (const item of rows) merged.set(item.id, item);
  // Ledger-first pass — entries may have no row at all (ack arrived, team
  // event still in flight) → synthesize a minimal row.
  for (const [itemId, entry] of Object.entries(ledger)) {
    const existing = merged.get(itemId);
    if (!existing) {
      merged.set(itemId, {
        id: itemId,
        promptRaw: entry.promptRaw,
        nickname: "You",
        status: entry.status,
        ...(entry.reason != null ? { reason: entry.reason } : {}),
        ...(entry.exampleFix != null ? { exampleFix: entry.exampleFix } : {}),
      });
      continue;
    }
    const patch: Partial<ClientItem> = {};
    if (entry.status !== existing.status) patch.status = entry.status;
    if (entry.reason != null && entry.reason !== existing.reason) patch.reason = entry.reason;
    if (entry.exampleFix != null && entry.exampleFix !== existing.exampleFix) patch.exampleFix = entry.exampleFix;
    merged.set(itemId, { ...existing, ...patch });
  }
  // Newer submissions first (submission order = reverse insertion).
  return [...merged.values()].reverse();
}
