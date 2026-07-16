/**
 * outbox.test.ts — W5: optimistic outbox (v0.6.0).
 *
 * Verifies:
 *   - sendOptimistic emits pending -> succeeded on happy path
 *   - flushOutbox retries queued messages after page reload (idb persists)
 *   - fails after MAX_RETRIES on persistent network errors (onFailed called once)
 *   - non-network errors fail immediately without retry (onFailed once, outbox cleared)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import { enqueue, pending, dequeue } from '../outbox.js';
import type { PendingMessage } from '../outbox.js';
import type { CryptoProvider, SealContext } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 't';

/** Identity crypto provider (e2ee wiring only — no message frames are unsealed in these tests). */
const trivialProvider: CryptoProvider = {
  seal: async (p: ArrayBuffer, _ctx: SealContext) => p,
  unseal: async (c: ArrayBuffer, _ctx: SealContext) => c,
};

beforeEach(async () => {
  const { clear } = await import('idb-keyval');
  await clear();
  vi.restoreAllMocks();
});

describe('outbox', () => {
  it('emits pending -> succeeded on happy path', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 1, sender_uid: 'u', sealed: 'AA==', msg_id: 'm1', created_at: 0 }),
        { status: 200 },
      ),
    );
    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    const handle = c.sendOptimistic('room', {
      senderUid: 'u',
      sealed: new ArrayBuffer(0),
      msgId: 'm1',
    });
    handle.onPending(() => calls.push('pending'));
    handle.onSucceeded(() => calls.push('succeeded'));
    handle.onFailed(() => calls.push('failed'));
    await handle.done;
    expect(calls).toEqual(['pending', 'succeeded']);
  });

  it('enqueue/dequeue idb helpers maintain correct state', async () => {
    // Test outbox helpers directly — enqueue adds, dequeue removes, pending lists
    await enqueue('room1', {
      msgId: 'msg-a',
      roomId: 'room1',
      senderUid: 'u1',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    await enqueue('room1', {
      msgId: 'msg-b',
      roomId: 'room1',
      senderUid: 'u1',
      sealedB64: 'BB==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    const before = await pending('room1');
    expect(before).toHaveLength(2);
    expect(before.map((m) => m.msgId)).toContain('msg-a');
    expect(before.map((m) => m.msgId)).toContain('msg-b');

    await dequeue('room1', 'msg-a');

    const after = await pending('room1');
    expect(after).toHaveLength(1);
    expect(after[0]!.msgId).toBe('msg-b');
  });

  // Council finding (HIGH, merge-gating): enqueue/dequeue each do a separate
  // get() -> modify -> set() over two independent idb-keyval transactions, with no
  // serialization. Two un-awaited sendTextOptimistic calls for the same room (Enter
  // hit twice fast) both read the same stale array, then the second set() clobbers
  // the first — one message is silently dropped from the outbox forever.
  it('two concurrent enqueues for the same room do not lose a message (lost-update race)', async () => {
    const msgA: PendingMessage = {
      msgId: 'race-a',
      roomId: 'room-race',
      senderUid: 'u1',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    };
    const msgB: PendingMessage = {
      msgId: 'race-b',
      roomId: 'room-race',
      senderUid: 'u1',
      sealedB64: 'BB==',
      attempts: 0,
      enqueuedAt: Date.now(),
    };

    // Fire both without awaiting either individually first — the un-awaited
    // double-Enter interleave the council flagged.
    await Promise.all([enqueue('room-race', msgA), enqueue('room-race', msgB)]);

    const queued = await pending('room-race');
    expect(queued.map((m) => m.msgId).sort()).toEqual(['race-a', 'race-b']);
  });

  it('concurrent enqueue + dequeue of different messages does not drop the surviving message', async () => {
    await enqueue('room-race2', {
      msgId: 'existing',
      roomId: 'room-race2',
      senderUid: 'u1',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    // Concurrently remove 'existing' and add 'new-msg' — neither op should clobber
    // the other's write.
    await Promise.all([
      dequeue('room-race2', 'existing'),
      enqueue('room-race2', {
        msgId: 'new-msg',
        roomId: 'room-race2',
        senderUid: 'u1',
        sealedB64: 'BB==',
        attempts: 0,
        enqueuedAt: Date.now(),
      }),
    ]);

    const queued = await pending('room-race2');
    expect(queued.map((m) => m.msgId)).toEqual(['new-msg']);
  });

  it('fails after MAX_RETRIES on persistent network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network'));

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    const failedErrors: SDKChatError[] = [];
    const handle = c.sendOptimistic('room', {
      senderUid: 'u',
      sealed: new ArrayBuffer(0),
      msgId: 'm2',
    });
    handle.onFailed((err) => failedErrors.push(err));

    await expect(handle.done).rejects.toThrow();

    expect(failedErrors).toHaveLength(1);
    expect(failedErrors[0]!.code).toBe('network');
  });

  it('non-network errors fail immediately without retry', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      return Promise.resolve(new Response('bad request', { status: 422 }));
    });

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    const failedErrors: SDKChatError[] = [];

    const handle = c.sendOptimistic('room', {
      senderUid: 'u',
      sealed: new ArrayBuffer(0),
      msgId: 'm3',
    });
    handle.onFailed((err) => failedErrors.push(err));

    await expect(handle.done).rejects.toThrow();

    // Only one fetch attempt — no retry for non-network errors
    expect(fetchCallCount).toBe(1);
    expect(failedErrors).toHaveLength(1);
    expect(failedErrors[0]!.code).toBe('invalid_args');

    // Outbox cleared after non-network failure
    const { get } = await import('idb-keyval');
    const remaining = (await get('outbox:room')) as { msgId: string }[] | undefined;
    expect(!remaining || remaining.every((m) => m.msgId !== 'm3')).toBe(true);
  });

  it('flushOutbox sends queued messages and clears them on success', async () => {
    // Pre-populate outbox directly (simulates page reload scenario)
    await enqueue('room2', {
      msgId: 'flush-msg-1',
      roomId: 'room2',
      senderUid: 'u1',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 5, sender_uid: 'u1', msg_id: 'flush-msg-1', created_at: 0 }),
        { status: 200 },
      ),
    );

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    await c.flushOutbox('room2');

    // After successful flush the message should be dequeued
    const remaining = await pending('room2');
    expect(remaining.every((m) => m.msgId !== 'flush-msg-1')).toBe(true);
  });

  // CR17 Item C: flushOutbox's catch swallowed ALL errors and left the entry queued,
  // so a poisoned-room outbox entry (send throws crypto_mode_poisoned, a non-network
  // error) would be retried forever. Mirror sendOptimistic: a non-network error is
  // permanent → dequeue.
  it('flushOutbox dequeues a poisoned-room entry instead of retrying forever', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/sdk/messages?')) {
        // list() → downgrade mismatch → poison the room.
        return new Response(
          JSON.stringify({ items: [], has_more: false, next_cursor: null, crypto_mode: 'plaintext' }),
          { status: 200 },
        );
      }
      // A POST send would land here, but #assertRoomNotPoisoned throws before any fetch.
      return new Response(JSON.stringify({ seq: 1, msg_id: 'x', created_at: 0 }), { status: 200 });
    });

    const c = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'sframe-static',
      _testNoSleep: true,
    });

    // Poison the room.
    await expect(c.list('poison-room', {})).rejects.toMatchObject({ code: 'crypto_mode_mismatch' });

    // A queued outbox entry for the now-poisoned room.
    await enqueue('poison-room', {
      msgId: 'stuck-1',
      roomId: 'poison-room',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    await c.flushOutbox('poison-room');

    // Scrubbed: send threw crypto_mode_poisoned (permanent) → dequeued, not retried.
    const remaining = await pending('poison-room');
    expect(remaining.every((m) => m.msgId !== 'stuck-1')).toBe(true);
  });

  // CR17-C-01 (crypto-review HIGH): a TRANSIENT failure (5xx / 429 / network / 401) must
  // NOT be dropped — flushOutbox is a background durability path with no caller callback, so
  // dropping a retriable ciphertext message is silent E2EE message loss. Only permanent
  // failures are scrubbed.
  it('flushOutbox keeps a transient-failure (5xx / 429) entry queued for the next flush', async () => {
    await enqueue('room-transient', {
      msgId: 't-1',
      roomId: 'room-transient',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    await enqueue('room-transient', {
      msgId: 't-2',
      roomId: 'room-transient',
      senderUid: 'u',
      sealedB64: 'BB==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    // send() POSTs fail transiently: 503 (server_error) then 429 (rate_limited).
    const statuses = [503, 429];
    let i = 0;
    globalThis.fetch = vi.fn(async () => new Response('busy', { status: statuses[i++] ?? 503 }));

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    await c.flushOutbox('room-transient');

    // Both entries survive — transient failures stay queued.
    const remaining = await pending('room-transient');
    expect(remaining.map((m) => m.msgId).sort()).toEqual(['t-1', 't-2']);
  });

  // CR17-C-01 (unify doctrine across ALL THREE outbox-writing paths): the foreground
  // optimistic-send catches must obey the same permanence rule flushOutbox uses — keep a
  // transient failure queued, dequeue only a permanent code.
  it('sendOptimistic keeps a transient (401) entry queued instead of dropping it', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 }));
    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    const failed: SDKChatError[] = [];
    const handle = c.sendOptimistic('room-401', {
      senderUid: 'u',
      sealed: new ArrayBuffer(0),
      msgId: 'k-401',
    });
    handle.onFailed((e) => failed.push(e));
    await expect(handle.done).rejects.toThrow();

    // 401 is transient (a token refresh may fix it) → retried, then LEFT queued for flushOutbox.
    const remaining = await pending('room-401');
    expect(remaining.some((m) => m.msgId === 'k-401')).toBe(true);
    expect(failed).toHaveLength(1);
  });

  it('sendOptimistic dequeues a permanent (403 forbidden) entry immediately', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('no', { status: 403 });
    });
    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    const handle = c.sendOptimistic('room-403', {
      senderUid: 'u',
      sealed: new ArrayBuffer(0),
      msgId: 'k-403',
    });
    await expect(handle.done).rejects.toMatchObject({ code: 'forbidden' });

    expect(calls).toBe(1); // permanent → no retry
    const remaining = await pending('room-403');
    expect(remaining.every((m) => m.msgId !== 'k-403')).toBe(true);
  });

  it('sendTextOptimistic keeps a transient (401) entry queued', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 }));
    const c = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      _testNoSleep: true,
      e2ee: { provider: trivialProvider },
    });
    const failed: SDKChatError[] = [];
    const handle = c.sendTextOptimistic('room-t401', { senderUid: 'u', text: 'hi', msgId: 'kt-401' });
    handle.onFailed((e) => failed.push(e));
    await expect(handle.done).rejects.toThrow();

    const remaining = await pending('room-t401');
    expect(remaining.some((m) => m.msgId === 'kt-401')).toBe(true);
    expect(failed).toHaveLength(1);
  });
});
