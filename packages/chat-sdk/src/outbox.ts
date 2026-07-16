/**
 * outbox.ts — W5: idb-keyval-backed optimistic outbox.
 *
 * Provides enqueue / dequeue / pending helpers for PendingMessage entries.
 * Key format: 'outbox:<roomId>' — one array per room.
 */

import { get, update } from 'idb-keyval';

export interface PendingMessage {
  msgId: string;
  roomId: string;
  senderUid: string;
  /** Standard base64 encoding of the sealed ArrayBuffer. */
  sealedB64: string;
  threadRootMsgId?: string;
  /** W9: marketplace product reference persisted with the outbox entry. */
  productRef?: string;
  /** W9: marketplace product metadata persisted with the outbox entry. */
  productMeta?: unknown;
  attempts: number;
  enqueuedAt: number;
}

/**
 * Append a message to the outbox for roomId.
 *
 * Uses idb-keyval's `update()` (single readwrite IndexedDB transaction wrapping
 * get+put with a synchronous updater) instead of separate get()/set() calls —
 * two un-awaited enqueue()s for the same room previously lost a message: both
 * read the same stale array before either wrote back (lost-update race, HIGH
 * council finding). A single transaction serializes overlapping readwrite
 * transactions on the same store, closing the window.
 */
export async function enqueue(roomId: string, msg: PendingMessage): Promise<void> {
  const key = `outbox:${roomId}`;
  await update<PendingMessage[]>(key, (cur) => [...(cur ?? []), msg]);
}

/** Remove a specific message from the outbox by msgId. Atomic — see enqueue(). */
export async function dequeue(roomId: string, msgId: string): Promise<void> {
  const key = `outbox:${roomId}`;
  await update<PendingMessage[]>(key, (cur) => (cur ?? []).filter((m) => m.msgId !== msgId));
}

/** Return all pending messages for roomId. */
export async function pending(roomId: string): Promise<PendingMessage[]> {
  return (await get<PendingMessage[]>(`outbox:${roomId}`)) ?? [];
}
