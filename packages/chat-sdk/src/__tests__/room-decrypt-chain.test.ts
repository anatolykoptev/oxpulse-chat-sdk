/**
 * room-decrypt-chain.test.ts — unit tests for the extracted RoomDecryptChain.
 *
 * Locks the two properties the subscribe() refcount fix depends on:
 *   1. serial-append: a task runs only after the prior task for the room settles.
 *   2. refcount teardown: the shared chain entry is removed ONLY at refCount 0,
 *      so tearing down one of two subscribers keeps the chain (and its ordering)
 *      alive for the survivor.
 */

import { describe, it, expect } from 'vitest';
import { RoomDecryptChain } from '../room-decrypt-chain.js';

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const ROOM = 'r1';

describe('RoomDecryptChain', () => {
  it('acquire/release refcounting: entry removed only at zero', () => {
    const c = new RoomDecryptChain();
    expect(c.refCountOf(ROOM)).toBe(0);

    c.acquire(ROOM);
    expect(c.refCountOf(ROOM)).toBe(1);

    c.acquire(ROOM); // second subscriber shares the chain
    expect(c.refCountOf(ROOM)).toBe(2);

    c.release(ROOM); // first teardown must NOT remove the shared entry
    expect(c.refCountOf(ROOM)).toBe(1);

    c.release(ROOM); // last teardown removes it
    expect(c.refCountOf(ROOM)).toBe(0);
  });

  it('release below zero and on an unknown room are safe no-ops', () => {
    const c = new RoomDecryptChain();
    expect(() => c.release('never-acquired')).not.toThrow();
    expect(c.refCountOf('never-acquired')).toBe(0);

    c.acquire(ROOM);
    c.release(ROOM);
    expect(() => c.release(ROOM)).not.toThrow(); // extra release
    expect(c.refCountOf(ROOM)).toBe(0);
  });

  it('append serializes tasks: a task starts only after the prior one settles', async () => {
    const c = new RoomDecryptChain();
    c.acquire(ROOM);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => { releaseFirst = res; });

    c.append(ROOM, async () => {
      order.push('1-start');
      await firstGate; // hold the head of the chain open
      order.push('1-end');
    });
    c.append(ROOM, async () => {
      order.push('2-start');
      order.push('2-end');
    });

    await flush();
    // Task 2 must not have started while task 1 is still in flight.
    expect(order).toEqual(['1-start']);

    releaseFirst();
    await flush();
    // Strict order: task 1 fully settles before task 2 starts.
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);

    c.release(ROOM);
  });

  it('append is a no-op when the room has no live subscriber', async () => {
    const c = new RoomDecryptChain();
    let ran = false;
    // No acquire() → no entry → the task is dropped, not started on a fresh chain.
    c.append(ROOM, async () => { ran = true; });
    await flush();
    expect(ran).toBe(false);
    expect(c.refCountOf(ROOM)).toBe(0);
  });

  it('re-acquire while a task is in flight reuses the chain (deferred delete)', async () => {
    const c = new RoomDecryptChain();
    c.acquire(ROOM);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => { releaseFirst = res; });

    // First subscriber appends a task that hangs, then fully tears down (rc → 0).
    c.append(ROOM, async () => {
      order.push('1-start');
      await firstGate;
      order.push('1-end');
    });
    c.release(ROOM);
    expect(c.refCountOf(ROOM)).toBe(0);
    await flush();
    // Deferred delete has NOT fired (the in-flight task is still hanging).

    // Resubscribe the same room: must reuse the still-present entry, not fork a
    // fresh Promise.resolve() chain.
    c.acquire(ROOM);
    expect(c.refCountOf(ROOM)).toBe(1);
    c.append(ROOM, async () => { order.push('2-run'); });
    await flush();

    // If the entry had been deleted, task 2 would start immediately. Because the
    // chain was reused, task 2 is queued behind the hanging task 1.
    expect(order).toEqual(['1-start']);

    releaseFirst();
    await flush();
    expect(order).toEqual(['1-start', '1-end', '2-run']);

    c.release(ROOM);
  });

  // CRITICAL regression (pr-review-council): a deferred delete must not fire on a
  // tail captured at an EARLIER release once newer work has been appended since.
  // Two zero-crossings with the second release's work chained before the first
  // release's captured tail resolves.
  it('two zero-crossings: a stale-tail drain must not delete a chain with newer queued work', async () => {
    const c = new RoomDecryptChain();
    const active = new Set<string>();
    let maxActive = 0;
    const gates = new Map<string, () => void>();
    const mkTask = (id: string) => async () => {
      active.add(id);
      maxActive = Math.max(maxActive, active.size);
      await new Promise<void>((res) => { gates.set(id, () => { active.delete(id); res(); }); });
    };

    // Zero-crossing #1: acquire → append(t1, hangs) → release (refCount → 0),
    // which schedules a drain on the SHORT tail (…t1).
    c.acquire(ROOM);
    c.append(ROOM, mkTask('t1'));
    c.release(ROOM);

    // Re-acquire the still-present entry, queue t2 behind t1, release again
    // (zero-crossing #2). The chain tail is now LONGER (…t1.then(t2)) than the
    // tail the first release captured.
    c.acquire(ROOM);
    c.append(ROOM, mkTask('t2'));
    c.release(ROOM);

    await flush();
    expect([...active]).toEqual(['t1']); // t1 running, t2 queued behind it

    // t1 settles → the first release's drain fires on its stale (short) tail.
    // BUG: identity + refCount<=0 both hold → it DELETES the entry while t2 is
    // only now dequeuing.
    gates.get('t1')!();
    await flush();

    // Resubscribe the instant t1 settled and push t3.
    c.acquire(ROOM);
    c.append(ROOM, mkTask('t3'));
    await flush();

    // Serial invariant: with the entry intact, t3 queues behind the running t2.
    // If the stale drain deleted the entry, t3 forks a fresh chain and runs
    // concurrently with t2 → maxActive 2 (the ratchet-desync this PR closes).
    expect(maxActive).toBeLessThanOrEqual(1);

    gates.get('t2')?.();
    await flush();
    gates.get('t3')?.();
    await flush();
    c.release(ROOM);
  });

  // MEDIUM (pr-review-council): during the deferred-delete window (refCount 0,
  // entry still present) a stray append must NOT run a decrypt for a released
  // subscriber — append must gate on a LIVE subscriber, not Map presence.
  it('append after release-to-zero (no re-acquire) is a no-op', async () => {
    const c = new RoomDecryptChain();
    c.acquire(ROOM);

    let firstRan = false;
    let strayRan = false;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => { releaseFirst = res; });

    c.append(ROOM, async () => { firstRan = true; await gate; });
    c.release(ROOM); // refCount → 0, entry lingers while its chain drains
    await flush();

    // Stray frame during the drain window (refCount already 0).
    c.append(ROOM, async () => { strayRan = true; });
    await flush();

    expect(firstRan).toBe(true);
    expect(strayRan).toBe(false); // not yet — either dropped, or queued behind first

    // Complete the first (drained) task. If the stray had been chained (append
    // gating only on Map presence), it would now RUN against a released
    // subscriber. Gating on a live subscriber drops it → it never runs.
    releaseFirst();
    await flush();
    expect(strayRan).toBe(false);
  });

  it('rooms are independent: a stalled chain in one room does not block another', async () => {
    const c = new RoomDecryptChain();
    c.acquire('roomA');
    c.acquire('roomB');

    const events: string[] = [];
    c.append('roomA', async () => {
      events.push('A-start');
      await new Promise<void>(() => {}); // roomA hangs forever
      events.push('A-end'); // unreachable
    });
    c.append('roomB', async () => { events.push('B-done'); });

    await flush();
    // roomB completes despite roomA being stuck.
    expect(events).toContain('A-start');
    expect(events).toContain('B-done');
    expect(events).not.toContain('A-end');
  });
});
