"use client";

/**
 * my-items — pure helpers merging the owner ledger (`myItems`) with the team's
 * item rows into "my submissions" (used by the player build screen + tests).
 */

import type { ClientItem, GameSnapshot, MyItemEvent } from "@/lib/store";

/**
 * All of THIS player's items: the team's rows filtered STRICTLY to items I own
 * (row.playerId === myPlayerId) UNION the owner ledger (myItems — entries
 * whose rows haven't arrived / whose owner-only detail the snapshot rows
 * lack). Merge precedence: a PENDING ledger entry never downgrades a
 * non-pending row (a lost item:ready echo must not re-stick the chip at
 * "drawing…" forever), while a terminal ledger entry (rejected/failed) always
 * wins — its owner-only reason/exampleFix is intel the snapshot row can
 * never carry.
 *
 * Ledger presence is reliable ownership evidence because the reducer only
 * ever registers MY items there (item:pending/item:ready echoes are gated by
 * ownsItem — teammates' submissions never enter myItems, so "Your stickers"
 * shows ONLY this player's own prompts).
 */
export function selectMyItems(snapshot: GameSnapshot, myTeamId: string, myPlayerId: string | null): ClientItem[] {
  const team = snapshot.teams.find((t) => t.id === myTeamId);
  // Round scoping: ledger entries from a PREVIOUS round are stale (the card
  // is rebuilt fresh every round) — drop anything not tagged with the
  // snapshot's current round.
  const ledgerEntries = Object.entries(snapshot.myItems).filter(
    ([, entry]) => entry.round === snapshot.round,
  );
  const ledger = Object.fromEntries(ledgerEntries) as typeof snapshot.myItems;
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
    // Status precedence: a PENDING ledger entry never downgrades a non-pending
    // row (stale pending echo vs READY row → the row wins, the chip unsticks);
    // a terminal ledger entry (rejected/failed) beats ANY row status — its
    // owner-only reason/exampleFix must survive; both pending → either.
    const ledgerWins = entry.status !== "pending" || existing.status === "pending";
    if (ledgerWins && entry.status !== existing.status) patch.status = entry.status;
    if (entry.reason != null && entry.reason !== existing.reason) patch.reason = entry.reason;
    if (entry.exampleFix != null && entry.exampleFix !== existing.exampleFix) patch.exampleFix = entry.exampleFix;
    merged.set(itemId, { ...existing, ...patch });
  }
  // Newer submissions first (submission order = reverse insertion).
  return [...merged.values()].reverse();
}
