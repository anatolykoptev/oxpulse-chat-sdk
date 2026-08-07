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

  // ── #263: in-flight guard on flushOutbox ──────────────────────────────────
  //
  // flushOutbox is driven on mount and on every reconnect. Two concurrent calls
  // (mount racing a reconnect, or two reconnects) both read the same pending
  // list and both send the same entries — wasted work, not corruption (the
  // server deduplicates on msgId). The guard ensures a second concurrent call
  // for the same room is a no-op while the first is still running.
  //
  // F1 — the gate: two concurrent calls send each entry ONCE.
  //   Mutation: remove the `if (this.#flushInFlight.has(roomId)) return;` guard
  //   in flushOutbox → RED (sendCalls becomes 2).
  it('F1_two_concurrent_flushOutbox_calls_send_each_entry_once', async () => {
    await enqueue('room-guard-f1', {
      msgId: 'guard-1',
      roomId: 'room-guard-f1',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    // Delay the fetch response so both flush calls read the same pending list
    // before either dequeues. Without the guard both calls send the entry.
    let sendCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      sendCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ seq: sendCalls, sender_uid: 'u', msg_id: 'guard-1', created_at: 0 }),
        { status: 200 },
      );
    });

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    // Two concurrent flushes — both read the same pending list.
    await Promise.all([c.flushOutbox('room-guard-f1'), c.flushOutbox('room-guard-f1')]);

    // The entry is sent ONCE — the second concurrent call is a no-op.
    expect(sendCalls).toBe(1);

    // The entry is dequeued.
    const after = await pending('room-guard-f1');
    expect(after.every((m) => m.msgId !== 'guard-1')).toBe(true);
  });

  // F2 — the release control: after a flush completes, a later flush still runs.
  //   Without this, F1 passes against a guard that latches forever and silently
  //   disables the outbox.
  //   Mutation: remove the `finally { this.#flushInFlight.delete(roomId); }`
  //   block → RED (the second flush is skipped, the second entry is never sent).
  it('F2_after_flush_completes_a_later_flush_still_runs', async () => {
    await enqueue('room-guard-f2', {
      msgId: 'f2-a',
      roomId: 'room-guard-f2',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'f2-a', created_at: 0 }), { status: 200 }),
    );

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    await c.flushOutbox('room-guard-f2');

    // First flush sent + dequeued the entry.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pending('room-guard-f2')).every((m) => m.msgId !== 'f2-a')).toBe(true);

    // Enqueue a new entry and flush again — the guard must have released.
    await enqueue('room-guard-f2', {
      msgId: 'f2-b',
      roomId: 'room-guard-f2',
      senderUid: 'u',
      sealedB64: 'BB==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ seq: 2, sender_uid: 'u', msg_id: 'f2-b', created_at: 0 }), { status: 200 }),
    );
    await c.flushOutbox('room-guard-f2');

    // Second flush ran (guard released after first).
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pending('room-guard-f2')).every((m) => m.msgId !== 'f2-b')).toBe(true);
  });

  // F3 — the throw control: a flush whose send rejects still releases the guard.
  //   This is the failure mode that turns a network blip into a permanently dead
  //   outbox — a latching guard on a send rejection means the outbox never flushes
  //   again, even after the network recovers.
  //   Mutation: remove the `finally { this.#flushInFlight.delete(roomId); }`
  //   block → RED (the second flush is skipped, the entry is never retried).
  it('F3_flush_whose_send_rejects_releases_guard_for_next_flush', async () => {
    await enqueue('room-guard-f3', {
      msgId: 'f3-1',
      roomId: 'room-guard-f3',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: Date.now(),
    });

    // First flush: send rejects (network error — transient, stays queued).
    globalThis.fetch = vi.fn(async () => { throw new TypeError('network'); });

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    await c.flushOutbox('room-guard-f3');

    // The send failed (transient) — entry stays queued.
    expect((await pending('room-guard-f3')).some((m) => m.msgId === 'f3-1')).toBe(true);

    // Second flush: send succeeds. The guard must have released after the
    // first flush's send rejection.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'f3-1', created_at: 0 }), { status: 200 }),
    );
    await c.flushOutbox('room-guard-f3');

    // The entry was sent + dequeued on the second flush.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pending('room-guard-f3')).every((m) => m.msgId !== 'f3-1')).toBe(true);
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

  // ── D3/F2: ordering against the real SDK serial chain ───────────────────
  //
  // A message with a slow attachment enqueued BEFORE a text-only message must
  // reach the room first. This exercises the REAL client path (sendAttachmentMessageOptimistic
  // + sendTextOptimistic through #serializeSend), not a stub.
  //
  // Mutation: remove the #serializeSend wrapper from sendOptimistic in client.ts
  // (the text send would fire immediately and reach the server before the
  // attachment send, violating ordering) → RED.
  it('F2_attachment_message_enqueued_before_text_reaches_room_first', async () => {
    const sendOrder: string[] = [];
    let attResolve!: (v: ArrayBuffer) => void;
    const slowUpload = new Promise<ArrayBuffer>((resolve) => { attResolve = resolve; });

    // Track which message's send() call happens first by spying on the
    // client's send method. The send() method receives the msgId in args.
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'ok', created_at: 0 }),
        { status: 200 },
      );
    });

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    // Spy on send() to track which msgId reaches the server first.
    const originalSend = c.send.bind(c);
    c.send = vi.fn(async (roomId: string, args: { senderUid: string; sealed: ArrayBuffer; msgId?: string }) => {
      sendOrder.push(args.msgId ?? 'unknown');
      return originalSend(roomId, args);
    }) as typeof c.send;

    // 1. Enqueue an attachment message with a slow upload (never resolves during the test).
    const attHandle = c.sendAttachmentMessageOptimistic('room-f2', {
      senderUid: 'u',
      body: 'photo caption',
      uploadPromise: slowUpload,
      msgId: 'att-msg-1',
    });

    // 2. Immediately enqueue a text-only message.
    const textHandle = c.sendTextOptimistic('room-f2', {
      senderUid: 'u',
      text: 'follow-up text',
      msgId: 'text-msg-1',
    });

    // 3. Resolve the slow upload — both sends should now proceed in order.
    attResolve(new ArrayBuffer(8));
    await Promise.allSettled([attHandle.done, textHandle.done]);

    // F2 core invariant: the attachment message's send happened BEFORE the
    // text message's send. The #serializeSend wrapper ensures the text send
    // waits behind the attachment send (which is itself waiting for the upload).
    // If #serializeSend were removed from sendOptimistic, the text send would
    // fire immediately (before the upload resolves) and reach the server first.
    expect(sendOrder).toEqual(['att-msg-1', 'text-msg-1']);
  });

  // ── D1/F1: failed-bubble on reload, caption preserved, NOT silently removed ──
  //
  // A message whose attachments were mid-upload at reload appears as a failed
  // outbox entry with its caption intact, and is NOT silently removed.
  // Mutation: restore the silent scrub in flushOutbox (dequeue instead of
  // updateEntry with sendFailed) → RED (the entry is gone, getFailedOutboxEntries returns []).
  it('F1_pendingAttachments_on_reload_marked_failed_not_silently_dropped', async () => {
    // Pre-populate the outbox with a pendingAttachments entry (simulates reload
    // mid-upload — the entry was persisted but the uploadPromise is gone).
    await enqueue('room-f1', {
      msgId: 'pending-att-1',
      roomId: 'room-f1',
      senderUid: 'u',
      sealedB64: '',
      attempts: 0,
      enqueuedAt: Date.now(),
      pendingAttachments: { body: 'my photo caption' },
    });

    // flushOutbox is called on reconnect/reload — it must mark the entry as
    // sendFailed, NOT dequeue it.
    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    await c.flushOutbox('room-f1');

    // The entry is still in the outbox (NOT silently dropped).
    const remaining = await pending('room-f1');
    expect(remaining.some((m) => m.msgId === 'pending-att-1')).toBe(true);

    // The entry is marked as sendFailed.
    const failed = remaining.find((m) => m.msgId === 'pending-att-1');
    expect(failed?.sendFailed).toBeDefined();
    expect(failed?.sendFailed?.reason).toContain('Upload interrupted');

    // The caption is preserved (pendingAttachments.body is still set).
    expect(failed?.pendingAttachments?.body).toBe('my photo caption');

    // getFailedOutboxEntries returns the entry.
    const failedEntries = await c.getFailedOutboxEntries('room-f1');
    expect(failedEntries.some((m) => m.msgId === 'pending-att-1')).toBe(true);
  });

  // ── F4: E2EE room's text send is unchanged ──────────────────────────────
  //
  // A plaintext-mode refactor on a shared send path (sendTextOptimistic now
  // delegates to sendOptimistic with UTF-8 bytes in plaintext mode) is exactly
  // where an E2EE downgrade hides. This test verifies an sframe room's text
  // send goes through the crypto provider (seal is called), NOT the plaintext
  // path.
  //
  // Mutation: remove the `effectiveMode === 'plaintext'` gate in
  // sendTextOptimistic (client.ts:2559-2560) so an sframe room falls through
  // to the plaintext path → RED (seal is never called, the outbox stores
  // raw UTF-8 instead of ciphertext).
  it('F4_sframe_room_text_send_uses_crypto_provider_not_plaintext_path', async () => {
    let sealCalls = 0;
    const trackingProvider: CryptoProvider = {
      seal: async (p: ArrayBuffer, _ctx: SealContext) => { sealCalls++; return p; },
      unseal: async (c: ArrayBuffer, _ctx: SealContext) => c,
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'e2ee-1', created_at: 0 }),
        { status: 200 },
      ),
    );

    const c = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      _testNoSleep: true,
      e2ee: { provider: trackingProvider },
      cryptoMode: 'sframe-static',
    });

    const handle = c.sendTextOptimistic('room-e2ee', {
      senderUid: 'u',
      text: 'secret message',
      msgId: 'e2ee-1',
    });
    await handle.done;

    // The crypto provider's seal was called — the text was sealed, not
    // UTF-8 encoded directly. If the plaintext path were taken, sealCalls
    // would be 0.
    expect(sealCalls).toBe(1);

    // The outbox entry stores the sealed bytes (from the provider), not
    // raw UTF-8. Since the provider is identity, sealedB64 is the base64
    // of the UTF-8 bytes — but the key invariant is that seal() was called.
    const remaining = await pending('room-e2ee');
    expect(remaining.every((m) => m.msgId !== 'e2ee-1')).toBe(true); // dequeued on success
  });

  // ── R3/F2: failed entries grow without bound — per-room cap with oldest-first eviction ──
  //
  // A queue of sendFailed entries that only grows is a slow leak with a UI
  // attached. flushOutbox now prunes failed entries (sendFailed ||
  // pendingAttachments) to a per-room cap, evicting the OLDEST first (by
  // failedAt ?? enqueuedAt) so the user keeps their most recent failures
  // visible and ancient ones they gave up on are dropped.
  //
  // Mutation: remove the pruneFailedEntries call from flushOutbox → RED
  // (all cap+1 entries survive, the oldest is NOT evicted).
  it('F2_flushOutbox_evicts_oldest_failed_entries_beyond_per_room_cap', async () => {
    const { MAX_FAILED_OUTBOX_ENTRIES } = await import('../outbox.js');
    const cap = MAX_FAILED_OUTBOX_ENTRIES;
    // Pre-populate cap+1 already-failed entries with distinct failedAt
    // timestamps so eviction order is deterministic (oldest = smallest failedAt).
    const base = 1_000_000;
    for (let i = 0; i <= cap; i++) {
      await enqueue('room-f2-evict', {
        msgId: `fail-${i}`,
        roomId: 'room-f2-evict',
        senderUid: 'u',
        sealedB64: '',
        attempts: 0,
        enqueuedAt: base + i,
        sendFailed: { reason: 'Upload interrupted', failedAt: base + i },
      });
    }

    // flushOutbox skips already-failed entries (no retry) but MUST prune the
    // set down to the cap, evicting the oldest.
    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });
    await c.flushOutbox('room-f2-evict');

    const remaining = await pending('room-f2-evict');
    const failedRemaining = remaining.filter((m) => m.sendFailed);

    // Exactly cap entries survive (the +1 oldest was evicted).
    expect(failedRemaining).toHaveLength(cap);

    // The OLDEST (fail-0, failedAt=base+0) was evicted; the newest (fail-cap)
    // survives.
    expect(failedRemaining.some((m) => m.msgId === 'fail-0')).toBe(false);
    expect(failedRemaining.some((m) => m.msgId === `fail-${cap}`)).toBe(true);
  });

  // ── H1/F1: a text message queued behind a slow upload IS in the outbox ──
  //
  // A text message sent while an attachment upload holds the serial chain must
  // be persisted to the outbox BEFORE the upload resolves. Without this, a tab
  // close during the upload loses the text message — it was visible in the UI
  // via the optimistic echo but never durably stored.
  //
  // Mutation: move the enqueue call in sendOptimistic back inside the
  // #serializeSend callback → RED (the text message is not in the outbox
  // while the upload holds the chain).
  it('F1_text_queued_behind_slow_upload_is_in_outbox_before_upload_resolves', async () => {
    let attResolve!: (v: ArrayBuffer) => void;
    const slowUpload = new Promise<ArrayBuffer>((resolve) => { attResolve = resolve; });

    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'ok', created_at: 0 }),
      { status: 200 },
    ));

    const c = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, _testNoSleep: true });

    // 1. Start an attachment send with a slow upload (never resolves during the
    //    assertion). This enters the serial chain and blocks on the upload.
    c.sendAttachmentMessageOptimistic('room-h1', {
      senderUid: 'u',
      body: 'photo caption',
      uploadPromise: slowUpload,
      msgId: 'att-h1',
    });

    // 2. Immediately send a text message — it is queued behind the attachment's
    //    serial chain slot (the upload hasn't resolved).
    c.sendOptimistic('room-h1', {
      senderUid: 'u',
      sealed: new TextEncoder().encode('text behind upload').buffer as ArrayBuffer,
      msgId: 'text-h1',
    });

    // 3. Let the microtask gap + enqueue settle, but do NOT resolve the upload.
    //    The text message's outbox entry must already exist — if the tab closed
    //    now, the text message would be recoverable from the outbox.
    await new Promise((r) => setTimeout(r, 50));

    const queued = await pending('room-h1');
    // The text message IS in the outbox even though the upload hasn't resolved.
    expect(queued.some((m) => m.msgId === 'text-h1')).toBe(true);

    // Cleanup: resolve the upload so background promises settle.
    attResolve(new ArrayBuffer(8));
  });

  // ── H1/F1b: same invariant for the sendTextOptimistic E2EE path ──────────
  //
  // The E2EE path seals the text before enqueuing. The enqueue must still
  // happen before entering the serial chain, so a text message sent behind a
  // slow upload is persisted before the upload resolves.
  //
  // Mutation: move the enqueue call in sendTextOptimistic back inside the
  // #serializeSend callback → RED.
  it('F1b_e2ee_text_queued_behind_slow_upload_is_in_outbox_before_upload_resolves', async () => {
    let attResolve!: (v: ArrayBuffer) => void;
    const slowUpload = new Promise<ArrayBuffer>((resolve) => { attResolve = resolve; });

    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ seq: 1, sender_uid: 'u', msg_id: 'ok', created_at: 0 }),
      { status: 200 },
    ));

    const c = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      _testNoSleep: true,
      e2ee: { provider: trivialProvider },
      cryptoMode: 'sframe-static',
    });

    // 1. Start an attachment send with a slow upload.
    c.sendAttachmentMessageOptimistic('room-h1b', {
      senderUid: 'u',
      body: 'photo caption',
      uploadPromise: slowUpload,
      msgId: 'att-h1b',
    });

    // 2. Immediately send a text message via the E2EE path.
    c.sendTextOptimistic('room-h1b', {
      senderUid: 'u',
      text: 'e2ee text behind upload',
      msgId: 'text-h1b',
    });

    // 3. Let the seal + enqueue settle, but do NOT resolve the upload.
    await new Promise((r) => setTimeout(r, 50));

    const queued = await pending('room-h1b');
    expect(queued.some((m) => m.msgId === 'text-h1b')).toBe(true);

    // Cleanup.
    attResolve(new ArrayBuffer(8));
  });

  // ── #261: the loss of durability must be observable ───────────────────────
  //
  // Each case re-imports ../outbox.js after vi.doMock so it gets FRESH module
  // state — the degradation flag is module-scoped and would otherwise leak
  // between cases and make the first one poison the rest.
  describe('#261 durability signal', () => {
    async function loadWithBrokenIdb() {
      vi.resetModules();
      vi.doMock('idb-keyval', () => ({
        get: () => Promise.reject(new Error('idb unavailable')),
        update: () => Promise.reject(new Error('idb unavailable')),
        set: () => Promise.reject(new Error('idb unavailable')),
        clear: () => Promise.resolve(),
      }));
      return import('../outbox.js');
    }

    async function loadWithWorkingIdb() {
      vi.resetModules();
      vi.doUnmock('idb-keyval');
      return import('../outbox.js');
    }

    const MSG = (msgId: string): PendingMessage => ({
      msgId,
      roomId: 'r261',
      senderUid: 'u',
      sealedB64: 'AA==',
      attempts: 0,
      enqueuedAt: 1,
    });

    it('F1_enqueue_failure_notifies_a_registered_listener_once', async () => {
      const mod = await loadWithBrokenIdb();
      const seen: string[] = [];
      mod.onOutboxDegraded((d) => seen.push(d.op));

      expect(mod.isOutboxDurable()).toBe(true);
      await mod.enqueue('r261', MSG('m1'));

      expect(seen).toEqual(['enqueue']);
      expect(mod.isOutboxDurable()).toBe(false);
    });

    it('F2_a_listener_registered_AFTER_the_failure_still_learns', async () => {
      const mod = await loadWithBrokenIdb();
      // The failure happens first, with nobody listening — this is the real
      // ordering when storage is unavailable from the very first send.
      await mod.enqueue('r261', MSG('m1'));

      const seen: string[] = [];
      mod.onOutboxDegraded((d) => seen.push(d.op));
      expect(seen).toEqual(['enqueue']);
    });

    it('F3_repeated_failures_notify_exactly_once', async () => {
      const mod = await loadWithBrokenIdb();
      const seen: string[] = [];
      mod.onOutboxDegraded((d) => seen.push(d.op));

      await mod.enqueue('r261', MSG('m1'));
      await mod.enqueue('r261', MSG('m2'));
      await mod.dequeue('r261', 'm1');
      await mod.pending('r261');

      expect(seen).toEqual(['enqueue']);
    });

    it('F7_pruneFailedEntries_failure_also_signals', async () => {
      // Review of #264 caught this missing: four of the five storage operations
      // were instrumented and prune was not — the fixed-only-where-the-reviewer-
      // probed half-fix that review prompts in this repo explicitly warn against.
      const mod = await loadWithBrokenIdb();
      const seen: string[] = [];
      mod.onOutboxDegraded((d) => seen.push(d.op));

      await mod.pruneFailedEntries('r261');

      expect(seen).toEqual(['pruneFailedEntries']);
      expect(mod.isOutboxDurable()).toBe(false);
    });

    // F5 (#263) — flushOutbox must RESOLVE when storage is dead in every
    // direction. This is the invariant the #263 in-flight guard rests on.
    //
    // The guard releases in a `finally`, but no test can currently distinguish
    // that from a release at the end of the `try`: moving it out leaves all of
    // this file GREEN, because flushOutbox cannot throw — every helper above
    // swallows its own error rather than propagating. So the `finally` is
    // defence-in-depth, not a tested guarantee, and what actually keeps the
    // outbox alive is this no-reject property.
    //
    // If a future refactor makes a helper propagate instead of degrade, the
    // failure is invisible: the widget calls flushOutbox fire-and-forget with
    // `.catch(() => {})`, so the rejection is swallowed, and the guard latches
    // that room's outbox dead for the page's lifetime with no error, no counter
    // and no log. This test goes RED first.
    //
    // Mutation: src/outbox.ts `pending`'s `return [];` -> `throw err;`
    //   -> RED (flushOutbox rejects instead of resolving).
    it('F5_263_flushOutbox_against_a_broken_store_resolves_rather_than_rejecting', async () => {
      vi.resetModules();
      vi.doMock('idb-keyval', () => ({
        get: () => Promise.reject(new Error('idb unavailable')),
        update: () => Promise.reject(new Error('idb unavailable')),
        set: () => Promise.reject(new Error('idb unavailable')),
        clear: () => Promise.resolve(),
      }));
      // Fresh client, so it binds to the broken-storage module graph.
      const { SDKChatClient: BrokenStoreClient } = await import('../client.js');
      const c = new BrokenStoreClient({ baseUrl: BASE_URL, jwt: JWT });

      await expect(c.flushOutbox('r263-broken')).resolves.toBeUndefined();

      // NOTE on what this does NOT prove: with `pending` degraded to [] a
      // latched guard would resolve too, so a second call cannot observe the
      // release. The release itself is unobservable until some helper can
      // propagate — which is exactly why the invariant above is the thing
      // worth pinning.

      vi.doUnmock('idb-keyval');
      vi.resetModules();
    });

    it('F4_CONTROL_working_storage_never_signals', async () => {
      // Without this the three cases above would all pass against an
      // implementation that notifies unconditionally.
      const mod = await loadWithWorkingIdb();
      const seen: string[] = [];
      mod.onOutboxDegraded((d) => seen.push(d.op));

      await mod.enqueue('r261', MSG('m1'));
      expect(await mod.pending('r261')).toHaveLength(1);
      await mod.dequeue('r261', 'm1');

      expect(seen).toEqual([]);
      expect(mod.isOutboxDurable()).toBe(true);
    });
  });

});
