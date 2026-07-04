/**
 * subscribe-scrollback-decrypt-chain.test.ts
 *
 * SEC-CR-14-02 — the LAST off-chain unseal path of the concurrent-unseal class.
 * Same class as PR #14 (per-room serial decrypt chain) and #15 (reconnect replay
 * on-chain), but on the code path neither covered: the PUBLIC list() PAGINATION /
 * scrollback path.
 *
 * subscribe()'s live SSE frames unseal through the per-room #decryptChain (at most
 * ONE unseal in flight per room). #15 routed reconnect/replay through it too. BUT
 * list() (backward scrollback via beforeSeq, or any list of a subscribed room)
 * unseals INTERNALLY — OFF the chain. A direct-SDK consumer that subscribe()s a
 * room AND list()s the same room's scrollback concurrently runs a SECOND unseal on
 * that room's SFrame ratchet while a streamed unseal is still in flight →
 * ratchet / replay-window desync — the exact class the chain exists to prevent.
 *
 * Invariant under test: for one room WITH a live subscription, at most ONE
 * provider.unseal() is ever in flight at a time (serial), across the scrollback
 * boundary too.
 *
 * RED against main 85e5fdc: an in-flight streamed unseal + a concurrent scrollback
 * list() of the SAME room run two unseals at once → per-room maxInFlight === 2.
 * GREEN after routing scrollback unseal through #decryptChain WHEN a subscription
 * exists (refCountOf(roomId) > 0). A room with NO subscription (refCount 0) keeps
 * unsealing directly off-chain — appending to a chainless room no-ops and would
 * DROP the rows; the one-shot delivery test guards that footgun.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';
import { installMockEventSource } from './helpers.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const SENDER_UID = 'user-1';

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Controllable crypto provider tracking concurrency PER ROOM (rooms are
 * independent chains, so a global counter would wrongly flag two rooms unsealing
 * at once). unseal() hangs until release(room, seq) is called. seq is encoded as
 * the first byte of the sealed bytes; the room comes from the SealContext.
 */
interface RoomTrackingProvider extends CryptoProvider {
  inFlightByRoom: Map<string, number>;
  maxInFlightByRoom: Map<string, number>;
  startedOrder: Array<{ room: string; seq: number }>;
  maxFor(room: string): number;
  release(room: string, seq: number): void;
  releaseAll(): void;
}

function makeRoomTrackingProvider(honorSignal = true): RoomTrackingProvider {
  const resolvers = new Map<string, () => void>();
  const p: RoomTrackingProvider = {
    inFlightByRoom: new Map(),
    maxInFlightByRoom: new Map(),
    startedOrder: [],
    async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      return plaintext;
    },
    unseal(sealed: ArrayBuffer, ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      const room = ctx.roomId;
      const now = (p.inFlightByRoom.get(room) ?? 0) + 1;
      p.inFlightByRoom.set(room, now);
      p.maxInFlightByRoom.set(room, Math.max(p.maxInFlightByRoom.get(room) ?? 0, now));
      p.startedOrder.push({ room, seq });
      return new Promise<ArrayBuffer>((resolve, reject) => {
        let settled = false;
        const dec = (): void => {
          if (settled) return;
          settled = true;
          p.inFlightByRoom.set(room, (p.inFlightByRoom.get(room) ?? 1) - 1);
        };
        resolvers.set(`${room}:${seq}`, () => {
          dec();
          resolve(new Uint8Array([seq]).buffer);
        });
        // Signal-honoring (default): the SDK's abort deadline rejects a stuck unseal so a
        // hung scrollback row bails at the deadline. Inert for tests that release before
        // the deadline. honorSignal=false models a provider that IGNORES the abort — it
        // hangs until the SDK's force-drain bound bails the row (fix/e2ee-unseal-cancel).
        if (honorSignal) {
          signal?.addEventListener(
            'abort',
            () => {
              dec();
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        }
      });
    },
    maxFor(room: string): number {
      return p.maxInFlightByRoom.get(room) ?? 0;
    },
    release(room: string, seq: number): void {
      const r = resolvers.get(`${room}:${seq}`);
      if (r) {
        resolvers.delete(`${room}:${seq}`);
        r();
      }
    },
    releaseAll(): void {
      for (const [, r] of [...resolvers]) r();
      resolvers.clear();
    },
  };
  return p;
}

/** SSE frame whose sealed_b64 encodes `seq` as its single byte. */
function frame(seq: number): string {
  return JSON.stringify({
    seq,
    msg_id: `m${seq}`,
    sender_uid: SENDER_UID,
    sealed_b64: btoa(String.fromCharCode(seq)),
    created_at: '2026-05-18T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  });
}

/** A list()/scrollback row (same single-byte sealed encoding as `frame`). */
function listRow(seq: number): Record<string, unknown> {
  return {
    seq,
    msg_id: `m${seq}`,
    sender_uid: SENDER_UID,
    sealed_b64: btoa(String.fromCharCode(seq)),
    created_at: '2026-05-18T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  };
}

/**
 * Route fetch by URL/method:
 *   POST .../subscribe-ticket    → { ticket }
 *   GET  .../api/sdk/messages?...→ the queued scrollback page for the room
 * The scrollback page is served from `pageByRoom` (per room_id in the query).
 */
function installFetchRouter(pageByRoom: Map<string, unknown[]>): void {
  let ticketCounter = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/subscribe-ticket')) {
        ticketCounter += 1;
        return new Response(JSON.stringify({ ticket: `ticket-${ticketCounter}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sdk/messages?')) {
        const roomId = new URL(url).searchParams.get('room_id') ?? '';
        const items = pageByRoom.get(roomId) ?? [];
        return new Response(
          JSON.stringify({ items, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

async function settleInitialSubscribe(): Promise<void> {
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();
}

describe('list() scrollback — per-room decrypt chain (SEC-CR-14-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('scrollback unseal must NOT run concurrently with an in-flight streamed unseal (subscribed room)', async () => {
    const room = 'room-scrollback';
    const provider = makeRoomTrackingProvider();
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();
    expect(es.getControllers().length).toBe(1);

    // Live frame seq=1 arrives → its unseal starts on the chain and HANGS.
    es.getLastController()!.emitMessage(frame(1));
    await flushMicrotasks();
    expect(provider.inFlightByRoom.get(room)).toBe(1);
    expect(provider.maxFor(room)).toBe(1);

    // A backward scrollback page (seq=2) is available for this room.
    pageByRoom.set(room, [listRow(2)]);

    // Consumer scrolls back on the SAME e2ee room while the stream is live.
    // Do NOT await list() to completion: at GREEN its scrollback unseal queues
    // behind the still-hung streamed unseal(1), so the promise won't resolve yet.
    const listPromise = client.list(room, { beforeSeq: 100 });
    await flushMicrotasks();

    // INVARIANT: the scrollback unseal(2) must queue behind the in-flight
    // streamed unseal(1), never run concurrently. Off-chain list() unseal breaks
    // this → maxInFlight 2 (RED at base 85e5fdc).
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    // Drain the hung streamed unseal → the queued scrollback unseal may now run.
    provider.release(room, 1);
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();
    const res = await listPromise;
    // Serialization never let two run at once, and the scrollback row is still
    // delivered (decrypted, not dropped).
    expect(provider.maxFor(room)).toBe(1);
    expect(res.items.map((r) => r.seq)).toEqual([2]);
    expect(res.items[0]!.unsealError).toBeUndefined();
  });

  it('one-shot list() for a room with NO subscription still delivers all rows (off-chain, not append-dropped)', async () => {
    const room = 'room-oneshot';
    // Immediate-resolving provider: this test is about DELIVERY (all rows come
    // back decrypted), not concurrency, so unseal resolves synchronously.
    const provider: CryptoProvider = {
      async seal(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
        return plaintext;
      },
      async unseal(sealed: ArrayBuffer): Promise<ArrayBuffer> {
        return sealed;
      },
    };
    installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    pageByRoom.set(room, [listRow(5), listRow(6), listRow(7)]);
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    // No subscribe() → refCountOf(room) === 0 → the chain has no entry. Routing
    // this through #decryptChain.append would no-op (drop every row); it MUST
    // unseal directly off-chain and deliver.
    const res = await client.list(room, { limit: 50 });
    expect(res.items.map((r) => r.seq)).toEqual([5, 6, 7]);
    for (const r of res.items) {
      expect(r.unsealError).toBeUndefined();
      expect(r.plaintext).toBeInstanceOf(ArrayBuffer);
    }
  });

  it('scrollback ordering preserved: multi-row page unseals in server order, serialized behind the live stream', async () => {
    const room = 'room-order';
    const provider = makeRoomTrackingProvider();
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    // Live seq=1 unseal starts and hangs.
    es.getLastController()!.emitMessage(frame(1));
    await flushMicrotasks();
    expect(provider.maxFor(room)).toBe(1);

    // A 3-row scrollback page for the same subscribed room.
    pageByRoom.set(room, [listRow(2), listRow(3), listRow(4)]);
    const listPromise = client.list(room, { beforeSeq: 100 });
    await flushMicrotasks();

    // Still serial while unseal(1) hangs — no scrollback row has unsealed yet.
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);
    expect(provider.startedOrder.filter((s) => s.room === room && s.seq >= 2)).toEqual([]);

    // Drain the live unseal, then release each scrollback row in turn. Each must
    // unseal only after the previous drains (serial), in server order 2,3,4.
    provider.release(room, 1);
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();
    provider.release(room, 3);
    await flushMicrotasks();
    provider.release(room, 4);
    await flushMicrotasks();

    const res = await listPromise;
    expect(provider.maxFor(room)).toBe(1);
    expect(res.items.map((r) => r.seq)).toEqual([2, 3, 4]);
    // Unseal STARTED strictly in server order (serial), never interleaved.
    expect(provider.startedOrder.filter((s) => s.room === room).map((s) => s.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('on-chain scrollback preserves a failed unseal as unsealError (not dropped, Promise.all still settles)', async () => {
    const room = 'room-scrollback-fail';
    // Provider whose unseal REJECTS — the on-chain path must catch it, return the
    // row with unsealError set (M2 preservation), and still settle the fetch.
    const provider: CryptoProvider = {
      async seal(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
        return plaintext;
      },
      async unseal(): Promise<ArrayBuffer> {
        throw new Error('bad tag');
      },
    };
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();
    expect(es.getControllers().length).toBe(1);

    // Subscription is live (refCount > 0) → scrollback routes on-chain.
    pageByRoom.set(room, [listRow(2), listRow(3)]);
    const res = await client.list(room, { beforeSeq: 100 });

    // Both rows returned (not dropped), each flagged with an unsealError; no plaintext.
    expect(res.items.map((r) => r.seq)).toEqual([2, 3]);
    for (const r of res.items) {
      expect(r.unsealError).toBeDefined();
      expect(r.plaintext).toBeUndefined();
    }
  });

  it('subscription torn down mid-scrollback: already-queued scrollback rows still drain and deliver', async () => {
    const room = 'room-teardown-mid-scrollback';
    const provider = makeRoomTrackingProvider();
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    const teardown = client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    // Live seq=1 unseal starts and hangs — keeps refCount > 0 during scrollback.
    es.getLastController()!.emitMessage(frame(1));
    await flushMicrotasks();

    // Scrollback queued on-chain (refCount > 0 at dispatch).
    pageByRoom.set(room, [listRow(2)]);
    const listPromise = client.list(room, { beforeSeq: 100 });
    await flushMicrotasks();
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    // Tear down the subscription AFTER the scrollback task was queued. The queued
    // task is already in the room's promise chain — release()'s deferred delete
    // waits for it to drain, so it still runs (serial) and the row is delivered.
    teardown();

    provider.release(room, 1);
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();

    const res = await listPromise;
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);
    expect(res.items.map((r) => r.seq)).toEqual([2]);
    expect(res.items[0]!.unsealError).toBeUndefined();
  });

  it('on-chain scrollback: a row whose unseal exceeds the 5s timeout is bailed as unsealError (isTimeout branch), row not dropped', async () => {
    const room = 'room-scrollback-timeout';
    const provider = makeRoomTrackingProvider(); // unseal HANGS until released
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    // Subscribed (refCount > 0), chain empty → the scrollback unseal runs
    // immediately and hangs. The on-chain 5s timeout (via #appendDecryptTask)
    // must fire and bail the row — the off-chain path has no such timeout.
    pageByRoom.set(room, [listRow(2)]);
    const listPromise = client.list(room, { beforeSeq: 100 });
    await flushMicrotasks();
    expect(provider.inFlightByRoom.get(room)).toBe(1);

    // Advance past the 5s timeout while the provider is still hung.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    const res = await listPromise;
    // Row preserved (not dropped), flagged with the timeout classification.
    expect(res.items.map((r) => r.seq)).toEqual([2]);
    expect(res.items[0]!.unsealError).toBe('unknown');
    expect(res.items[0]!.plaintext).toBeUndefined();

    provider.releaseAll();
    await flushMicrotasks();
  });

  it('on-chain scrollback: list() RESOLVES via force-drain even if the provider IGNORES the abort and never settles (no list() hang)', async () => {
    // The HIGH the pr-council caught for the scrollback path: awaiting the real settle
    // without a bound makes #unsealRowsOnChain's Promise.all — and thus the public
    // list() promise — hang forever on a non-honoring stuck provider. The force-drain
    // bounds it: the row bails as unsealError and list() resolves.
    const room = 'room-scrollback-forcedrain';
    const provider = makeRoomTrackingProvider(false); // ignores the abort; never released
    const es = installMockEventSource();
    const pageByRoom = new Map<string, unknown[]>();
    installFetchRouter(pageByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    pageByRoom.set(room, [listRow(2)]);
    const listPromise = client.list(room, { beforeSeq: 100 });
    await flushMicrotasks();
    expect(provider.inFlightByRoom.get(room)).toBe(1);

    // Deadline (5s) alone: the abort is ignored, the unseal is still hung, list() not resolved.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(provider.maxFor(room)).toBe(1);

    // Cross the force-drain bound (deadline+grace = 10s) → the row bails, Promise.all
    // resolves, list() resolves (RED against #25 code — list() would hang forever here).
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    const res = await listPromise;
    expect(res.items.map((r) => r.seq)).toEqual([2]);
    expect(res.items[0]!.unsealError).toBe('unknown');
    expect(res.items[0]!.plaintext).toBeUndefined();
    expect(provider.maxFor(room)).toBe(1);

    provider.releaseAll();
    await flushMicrotasks();
  });

  it('two concurrent list() calls on the same subscribed room stay <=1 unseal in flight', async () => {
    const room = 'room-two-list';
    const provider = makeRoomTrackingProvider();
    const es = installMockEventSource();
    // Route by before_seq so each list() gets a DISTINCT scrollback row (no
    // resolver-collision) while both target the same room's shared chain.
    let ticketCounter = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/subscribe-ticket')) {
          ticketCounter += 1;
          return new Response(JSON.stringify({ ticket: `t-${ticketCounter}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/sdk/messages?')) {
          const before = new URL(url).searchParams.get('before_seq');
          const seq = before === '100' ? 2 : 3;
          return new Response(
            JSON.stringify({ items: [listRow(seq)], has_more: false, next_cursor: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    // A live streamed unseal starts and hangs (holds the chain head).
    es.getLastController()!.emitMessage(frame(1));
    await flushMicrotasks();
    expect(provider.maxFor(room)).toBe(1);

    // Two scrollback list() calls on the SAME subscribed room: both pass the
    // refCount check and append their row onto the SAME serial chain.
    const p1 = client.list(room, { beforeSeq: 100 });
    const p2 = client.list(room, { beforeSeq: 200 });
    await flushMicrotasks();

    // INVARIANT: both queue behind the hung stream unseal — never concurrent.
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    // Drain the head, then each scrollback row in turn — still serial throughout.
    provider.release(room, 1);
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();
    provider.release(room, 3);
    await flushMicrotasks();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(provider.maxFor(room)).toBe(1);
    expect(r1.items.map((r) => r.seq)).toEqual([2]);
    expect(r2.items.map((r) => r.seq)).toEqual([3]);
  });
});
