/**
 * room-decrypt-chain.ts — per-room serial decrypt queue with subscriber refcounting.
 *
 * W6 E2EE invariant: inbound frames for one room must unseal STRICTLY in order.
 * A ratcheting AEAD (SFrame replay window / ratchet state) hard-fails or silently
 * desyncs on out-of-order unseal, so every inbound decrypt for a room is appended
 * onto that room's single promise chain and runs only after the prior link
 * settles. Rooms are independent: a stuck unseal in roomA never stalls roomB.
 * The queue is a non-re-entrant serial queue, not a re-entrant mutex.
 *
 * Refcounting (E2EE concurrency fix): more than one subscribe() can share a
 * roomId on one client (widget remount, visibility re-subscribe without awaiting
 * teardown, reconnect race). Each subscriber acquire()s on subscribe and
 * release()s on teardown; the shared chain entry is removed ONLY when the last
 * subscriber releases (refCount reaches 0). A previous version deleted the entry
 * on ANY teardown, so a surviving co-subscriber's next frame started a FRESH
 * chain from Promise.resolve() that ran concurrently with an in-flight unseal —
 * breaking the in-order guarantee the ratchet depends on.
 */

interface ChainEntry {
  /** Tail of the room's serial decrypt chain; always resolves (tasks self-catch). */
  chain: Promise<void>;
  /** Number of live subscribers sharing this room's chain. */
  refCount: number;
}

export class RoomDecryptChain {
  readonly #byRoom: Map<string, ChainEntry> = new Map();

  /**
   * Register a subscriber for `roomId`. Creates the room's chain on the first
   * subscriber; increments the shared refcount for subsequent ones. Must be
   * balanced by exactly one release(roomId) at teardown.
   */
  acquire(roomId: string): void {
    const entry = this.#byRoom.get(roomId);
    if (entry === undefined) {
      this.#byRoom.set(roomId, { chain: Promise.resolve(), refCount: 1 });
    } else {
      entry.refCount += 1;
    }
  }

  /**
   * Append a decrypt task onto `roomId`'s serial chain. The task runs only after
   * every previously-appended task for the room has settled, preserving in-order
   * unseal across ALL live subscribers of the room.
   *
   * No-op when the room has no live subscriber (already released): the frame is
   * dropped rather than started off a fresh, unsynchronized chain — matching the
   * intent that a torn-down room delivers nothing.
   *
   * `task` MUST NOT reject (it must catch internally); the chain is a plain
   * `.then` sequence and a rejected link would poison the room's queue.
   */
  append(roomId: string, task: () => Promise<void>): void {
    const entry = this.#byRoom.get(roomId);
    if (entry === undefined) return;
    entry.chain = entry.chain.then(task);
  }

  /**
   * Deregister a subscriber for `roomId`. Removes the shared chain entry only
   * when the last subscriber releases (refCount reaches 0). Safe to call for a
   * room with no entry (no-op) so teardown is always idempotent.
   */
  release(roomId: string): void {
    const entry = this.#byRoom.get(roomId);
    if (entry === undefined) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.#byRoom.delete(roomId);
    }
  }

  /** Current live-subscriber count for `roomId` (0 when the room has no entry). */
  refCountOf(roomId: string): number {
    return this.#byRoom.get(roomId)?.refCount ?? 0;
  }
}
