/**
 * outbox.ts — W5: idb-keyval-backed optimistic outbox.
 *
 * Provides enqueue / dequeue / pending helpers for PendingMessage entries.
 * Key format: 'outbox:<roomId>' — one array per room.
 *
 * All operations are best-effort: if IndexedDB is unavailable (private browsing,
 * disabled storage, jsdom without fake-indexeddb), they silently no-op. The send
 * still proceeds — the outbox is a durability mechanism, not a hard gate. A
 * message that cannot be persisted simply loses retry-on-reload protection.
 */

import { get, update } from 'idb-keyval';

export interface PendingMessage {
  msgId: string;
  roomId: string;
  senderUid: string;
  /** Standard base64 encoding of the sealed ArrayBuffer.
   *  Empty string when `pendingAttachments` is set — the sealed bytes are
   *  not yet available because attachment uploads are still in flight. */
  sealedB64: string;
  threadRootMsgId?: string;
  /** W9: marketplace product reference persisted with the outbox entry. */
  productRef?: string;
  /** W9: marketplace product metadata persisted with the outbox entry. */
  productMeta?: unknown;
  attempts: number;
  enqueuedAt: number;
  /** Present when this message is waiting for attachment uploads to complete
   *  before it can be sealed and sent. While set, `sealedB64` is empty and
   *  the serial send processor defers the send until the uploads resolve
   *  and `updateEntry` replaces the placeholder with real sealed bytes.
   *  On page reload these entries are orphaned (uploads are in-memory only)
   *  and are scrubbed by `flushOutbox`. */
  pendingAttachments?: {
    /** The caption / body text for the attachment message. */
    body: string;
  };
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
  try {
    await update<PendingMessage[]>(key, (cur) => [...(cur ?? []), msg]);
  } catch {
    // idb unavailable — send proceeds without durability.
  }
}

/** Remove a specific message from the outbox by msgId. Atomic — see enqueue(). */
export async function dequeue(roomId: string, msgId: string): Promise<void> {
  const key = `outbox:${roomId}`;
  try {
    await update<PendingMessage[]>(key, (cur) => (cur ?? []).filter((m) => m.msgId !== msgId));
  } catch {
    // idb unavailable — nothing to dequeue.
  }
}

/** Return all pending messages for roomId. */
export async function pending(roomId: string): Promise<PendingMessage[]> {
  try {
    return (await get<PendingMessage[]>(`outbox:${roomId}`)) ?? [];
  } catch {
    return [];
  }
}

/**
 * Patch a specific outbox entry by msgId — used to replace a pending-attachment
 * placeholder with real sealed bytes once uploads complete. Atomic — see enqueue().
 */
export async function updateEntry(
  roomId: string,
  msgId: string,
  patch: Partial<Omit<PendingMessage, 'msgId' | 'roomId'>>,
): Promise<void> {
  const key = `outbox:${roomId}`;
  try {
    await update<PendingMessage[]>(key, (cur) =>
      (cur ?? []).map((m) => (m.msgId === msgId ? { ...m, ...patch } : m)),
    );
  } catch {
    // idb unavailable — nothing to update.
  }
}
