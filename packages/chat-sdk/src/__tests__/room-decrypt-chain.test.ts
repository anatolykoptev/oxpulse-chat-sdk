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
