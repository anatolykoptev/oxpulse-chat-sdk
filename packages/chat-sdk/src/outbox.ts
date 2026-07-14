/**
 * outbox.ts — W5: idb-keyval-backed optimistic outbox.
 *
 * Provides enqueue / dequeue / pending helpers for PendingMessage entries.
 * Key format: 'outbox:<roomId>' — one array per room.
 */

import { get, set } from 'idb-keyval';

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

/** Append a message to the outbox for roomId. */
export async function enqueue(roomId: string, msg: PendingMessage): Promise<void> {
  const key = `outbox:${roomId}`;
  const cur = (await get<PendingMessage[]>(key)) ?? [];
  await set(key, [...cur, msg]);
}

/** Remove a specific message from the outbox by msgId. */
export async function dequeue(roomId: string, msgId: string): Promise<void> {
  const key = `outbox:${roomId}`;
  const cur = (await get<PendingMessage[]>(key)) ?? [];
  await set(key, cur.filter((m) => m.msgId !== msgId));
}

/** Return all pending messages for roomId. */
export async function pending(roomId: string): Promise<PendingMessage[]> {
  return (await get<PendingMessage[]>(`outbox:${roomId}`)) ?? [];
}
