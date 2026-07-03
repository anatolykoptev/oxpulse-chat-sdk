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
 * release()s on teardown; the shared chain entry is removed only when the last
 * subscriber releases AND the chain has drained (see release()). A previous
 * version deleted the entry on ANY teardown, so a surviving co-subscriber's next
 * frame — or a same-room resubscribe after teardown — started a FRESH chain from
 * Promise.resolve() that ran concurrently with an in-flight unseal, breaking the
 * ratchet's ordering.
 *
 * Guarantee: at most ONE unseal task per room is in flight at any time, across
 * every subscribe / teardown / resubscribe / reconnect-replay interleaving — the
 * property a ratcheting AEAD needs. The reconnect replay (missed rows fetched on
 * SSE error / graceful shutdown) appends its unseals onto this same chain rather
 * than unsealing off-chain, so it too is serialized with the live stream
 * (SEC-CR-14-01). Rooms remain independent of each other.
 */

interface ChainEntry {
  /** Tail of the room's serial decrypt chain; always resolves (tasks self-catch). */
  chain: Promise<void>;
  /** Number of live subscribers sharing this room's chain. */
  refCount: number;
  /**
   * Monotonic change counter, bumped on every acquire() and every append().
   * A deferred delete scheduled by release() captures this value and removes the
   * entry only if it still matches at drain time — so ANY subscriber or decrypt
   * added AFTER that release (which advances the chain tail) cancels the now-stale
   * delete. Without it, a delete scheduled on an EARLIER release's short tail could
   * fire while newer queued work is still draining and wrongly remove the entry.
   */
  generation: number;
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
      this.#byRoom.set(roomId, { chain: Promise.resolve(), refCount: 1, generation: 1 });
    } else {
      entry.refCount += 1;
      entry.generation += 1;
    }
  }

  /**
   * Append a decrypt task onto `roomId`'s serial chain. The task runs only after
   * every previously-appended task for the room has settled, so at most one
   * unseal is ever in flight for the room, preserving in-order decrypt across all
   * of its live subscribers.
   *
   * No-op unless the room has a LIVE subscriber (refCount > 0). During the
   * deferred-delete window a released entry lingers (refCount 0) while its chain
   * drains; a stray frame arriving then must be dropped, not queued to run a
   * decrypt for an already-released subscriber. Gating on refCount (not mere Map
   * presence) enforces the "a torn-down room delivers nothing" intent.
   *
   * `task` MUST NOT reject (it must catch internally); the chain is a plain
   * `.then` sequence and a rejected link would poison the room's queue.
   */
  append(roomId: string, task: () => Promise<void>): void {
    const entry = this.#byRoom.get(roomId);
    if (entry === undefined || entry.refCount <= 0) return;
    entry.generation += 1;
    entry.chain = entry.chain.then(task);
  }

  /**
   * Deregister a subscriber for `roomId`. Safe to call for a room with no entry,
   * or one already at refCount 0 (no-op) — release never drives the count below 0.
   *
   * When the last subscriber releases (refCount reaches 0) the shared chain entry
   * is removed ONLY after its in-flight/queued decrypts DRAIN, not synchronously.
   * A synchronous delete would orphan an in-flight unseal (the promise keeps
   * running) while a same-room resubscribe's acquire() creates a FRESH chain that
   * unseals concurrently with the orphan — the very ratchet-desync this class
   * exists to prevent. Deferring lets a resubscribe re-acquire THIS entry (its
   * acquire finds it still present) and append AFTER the orphan, staying serial.
   *
   * The drain callback deletes only if entry identity + refCount<=0 STILL hold AND
   * the generation is unchanged since this release. The generation guard is load-
   * bearing: the callback awaits the tail captured at THIS release, but append()
   * mutates entry.chain in place, so on a second release-to-zero the FIRST
   * release's (shorter) tail can resolve while the SECOND release's newer work is
   * still queued — without the guard the stale callback would delete an entry that
   * still has draining work, re-opening the concurrent-unseal hole. Any acquire()
   * or append() after a release bumps the generation and cancels its pending
   * delete; the later release schedules the delete that actually fires.
   * Relies on tasks settling (subscribe()'s 5s unseal timeout guarantees it).
   */
  release(roomId: string): void {
    const entry = this.#byRoom.get(roomId);
    if (entry === undefined || entry.refCount <= 0) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    const draining = entry.chain;
    const generationAtRelease = entry.generation;
    const removeIfStillIdle = () => {
      const current = this.#byRoom.get(roomId);
      if (
        current === entry &&
        current.refCount <= 0 &&
        current.generation === generationAtRelease
      ) {
        this.#byRoom.delete(roomId);
      }
    };
    // Run cleanup whether the tail resolves OR rejects — tasks are contracted to
    // self-catch (never reject), but a rejected tail must still trigger removal
    // rather than leak the entry + surface an unhandled rejection.
    void draining.then(removeIfStillIdle, removeIfStillIdle);
  }

  /** Current live-subscriber count for `roomId` (0 when the room has no entry). */
  refCountOf(roomId: string): number {
    return this.#byRoom.get(roomId)?.refCount ?? 0;
  }
}
