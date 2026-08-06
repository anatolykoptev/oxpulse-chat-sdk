/**
 * outbox.ts — W5: idb-keyval-backed optimistic outbox.
 *
 * Provides enqueue / dequeue / pending helpers for PendingMessage entries.
 * Key format: 'outbox:<roomId>' — one array per room.
 *
 * All operations are best-effort: if IndexedDB is unavailable (private browsing,
 * disabled storage, jsdom without fake-indexeddb), they no-op. The send still
 * proceeds — the outbox is a durability mechanism, not a hard gate. A message
 * that cannot be persisted simply loses retry-on-reload protection.
 *
 * #261: that no-op used to be SILENT, which made two very different states
 * indistinguishable — "your message was persisted and will be retried" and
 * "durability was never available in this browser". The widget ships on partner
 * sites, so it meets Safari private browsing, storage-pressure eviction and
 * blocked site data routinely. Proceeding without durability is fine; doing it
 * invisibly is not. The first failure now flips a module-level flag and notifies
 * any registered listener exactly once.
 */

import { get, update } from 'idb-keyval';

/** Which operation first hit unavailable storage. */
export type OutboxOp = 'enqueue' | 'dequeue' | 'pending' | 'updateEntry';

export interface OutboxDegradation {
  op: OutboxOp;
  error: unknown;
}

let degradation: OutboxDegradation | null = null;
const listeners = new Set<(d: OutboxDegradation) => void>();

/**
 * True until the first storage failure. Once false it stays false for the page's
 * lifetime: a store that failed once cannot be assumed to have persisted anything
 * earlier either, so re-arming would report a durability we cannot vouch for.
 */
export function isOutboxDurable(): boolean {
  return degradation === null;
}

/**
 * Register a listener for the loss of durability. Returns a disposer.
 *
 * A listener registered AFTER the first failure is called immediately with the
 * recorded degradation — otherwise the signal would be lost in exactly the case
 * that matters, where storage is unavailable from the very first send and the
 * widget subscribes a moment later.
 */
export function onOutboxDegraded(fn: (d: OutboxDegradation) => void): () => void {
  listeners.add(fn);
  if (degradation !== null) fn(degradation);
  return () => listeners.delete(fn);
}

/** Test seam — module state is global and would leak between test files. */
export function __resetOutboxDurability(): void {
  degradation = null;
  listeners.clear();
}

function markDegraded(op: OutboxOp, error: unknown): void {
  if (degradation !== null) return; // first transition only
  degradation = { op, error };
  for (const fn of listeners) {
    // A throwing listener must not take down the send path it is reporting on.
    try {
      fn(degradation);
    } catch {
      /* ignore */
    }
  }
}

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
   *  and are marked permanently failed by `flushOutbox` (see `sendFailed`). */
  pendingAttachments?: {
    /** The caption / body text for the attachment message. */
    body: string;
  };
  /** Set by `flushOutbox` when a `pendingAttachments` entry is orphaned by a
   *  page reload — the upload blob is gone and the send can never complete.
   *  The entry is NOT dequeued: it stays in the outbox so the widget can
   *  surface it as a permanently failed message bubble (caption preserved,
   *  dismiss-only — no retry because the blob is unrecoverable). */
  sendFailed?: {
    /** Human-readable reason for the failure. */
    reason: string;
    /** Timestamp of the failure (Date.now()). */
    failedAt: number;
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
  } catch (err) {
    // idb unavailable — send proceeds without durability, but not silently.
    markDegraded('enqueue', err);
  }
}

/** Remove a specific message from the outbox by msgId. Atomic — see enqueue(). */
export async function dequeue(roomId: string, msgId: string): Promise<void> {
  const key = `outbox:${roomId}`;
  try {
    await update<PendingMessage[]>(key, (cur) => (cur ?? []).filter((m) => m.msgId !== msgId));
  } catch (err) {
    // idb unavailable — nothing to dequeue.
    markDegraded('dequeue', err);
  }
}

/** Return all pending messages for roomId. */
export async function pending(roomId: string): Promise<PendingMessage[]> {
  try {
    return (await get<PendingMessage[]>(`outbox:${roomId}`)) ?? [];
  } catch (err) {
    markDegraded('pending', err);
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
  } catch (err) {
    // idb unavailable — nothing to update.
    markDegraded('updateEntry', err);
  }
}

/**
 * R3/F2: Per-room cap on permanently failed outbox entries. A queue of
 * sendFailed / pendingAttachments entries that only grows is a slow leak with
 * a UI attached — the user meets it as a chat that gets slower and dirtier
 * every week. This cap bounds it.
 *
 * Policy: per-room cap with OLDEST-FIRST eviction (by `sendFailed.failedAt`
 * ?? `enqueuedAt`). Chosen over an age-based sweep because a cap is
 * deterministic and bounded even during a burst of failures in one session
 * (all recent, none age-swept), and matches the user's mental model: keep the
 * most recent failures visible, drop ancient ones they gave up on. Enforced
 * at the write site (flushOutbox after marking) so the stored set is always
 * within cap.
 */
export const MAX_FAILED_OUTBOX_ENTRIES = 50;

/**
 * Prune permanently failed entries (sendFailed || pendingAttachments) for
 * roomId down to `cap`, evicting the oldest first. Atomic — single idb
 * transaction. No-op when at or below cap. Called by `flushOutbox` after it
 * marks new failures so the failed set never exceeds the cap.
 */
export async function pruneFailedEntries(
  roomId: string,
  cap: number = MAX_FAILED_OUTBOX_ENTRIES,
): Promise<void> {
  const key = `outbox:${roomId}`;
  try {
    await update<PendingMessage[]>(key, (cur) => {
      const all = cur ?? [];
      const failed = all.filter((m) => m.sendFailed || m.pendingAttachments);
      if (failed.length <= cap) return all;
      // Oldest-first eviction: sort by failedAt ?? enqueuedAt ascending, drop
      // the (failed.length - cap) oldest. Non-failed entries are always kept.
      const sorted = [...failed].sort(
        (a, b) =>
          (a.sendFailed?.failedAt ?? a.enqueuedAt) -
          (b.sendFailed?.failedAt ?? b.enqueuedAt),
      );
      const evictIds = new Set(
        sorted.slice(0, failed.length - cap).map((m) => m.msgId),
      );
      return all.filter((m) => !evictIds.has(m.msgId));
    });
  } catch {
    // idb unavailable — nothing to prune.
  }
}
