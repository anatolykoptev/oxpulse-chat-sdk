/**
 * subscribe-reconnect-decrypt-chain.test.ts
 *
 * SEC-CR-14-01 — HIGH E2EE-integrity concurrency bug, same class as the merged
 * PR #14 (per-room serial decrypt chain) but on the code path the chain did NOT
 * cover: the reconnect / replay delivery.
 *
 * subscribe()'s live SSE frames unseal through the per-room #decryptChain (at
 * most ONE unseal in flight per room). But reconnect() and reconnectImmediate()
 * replay missed rows via `await this.list(...)`, and list() UNSEALS INTERNALLY —
 * OFF the chain. When the stream closes (onerror / graceful `event: shutdown`),
 * an in-flight streamed unseal keeps running as a detached promise (up to the 5s
 * unseal timeout); the reconnect replay then starts a SECOND, concurrent unseal
 * on the SAME room's ratchet → replay-window / ratchet desync — the exact class
 * the chain exists to prevent. The shutdown path makes it fleet-wide: one server
 * graceful restart fires reconnectImmediate for EVERY subscribed room at once.
 *
 * Invariant under test: for one room, at most ONE provider.unseal() is ever in
 * flight at a time (serial), across the reconnect / replay boundary too.
 *
 * RED against HEAD 6babab7: an in-flight streamed unseal + a reconnect replay of
 * the SAME room run concurrently → per-room maxInFlight === 2.
 * GREEN after routing the reconnect replay unseal through #decryptChain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';

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

function makeRoomTrackingProvider(): RoomTrackingProvider {
  const resolvers = new Map<string, () => void>();
  const p: RoomTrackingProvider = {
    inFlightByRoom: new Map(),
    maxInFlightByRoom: new Map(),
    startedOrder: [],
    async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      return plaintext;
    },
    unseal(sealed: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      const room = ctx.roomId;
      const now = (p.inFlightByRoom.get(room) ?? 0) + 1;
      p.inFlightByRoom.set(room, now);
      p.maxInFlightByRoom.set(room, Math.max(p.maxInFlightByRoom.get(room) ?? 0, now));
      p.startedOrder.push({ room, seq });
      return new Promise<ArrayBuffer>((resolve) => {
        resolvers.set(`${room}:${seq}`, () => {
          p.inFlightByRoom.set(room, (p.inFlightByRoom.get(room) ?? 1) - 1);
          resolve(new Uint8Array([seq]).buffer);
        });
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

/** A list()-replay row (same single-byte sealed encoding as `frame`). */
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

interface FakeES {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, (ev: MessageEvent) => void>;
  emit(data: string): void;
  fireShutdown(): void;
  fireError(): void;
}

/** Install a mock EventSource collecting EVERY constructed instance in order. */
function installMockEventSource(): FakeES[] {
  const instances: FakeES[] = [];
  class MockES {
    url: string;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    listeners: Record<string, (ev: MessageEvent) => void> = {};
    constructor(url: string) {
      this.url = url;
      const self = this;
      instances.push({
        url,
        get onmessage() { return self.onmessage; },
        get onerror() { return self.onerror; },
        get listeners() { return self.listeners; },
        emit: (data: string) => self.onmessage?.({ data } as MessageEvent),
        fireShutdown: () => self.listeners['shutdown']?.(new Event('shutdown') as MessageEvent),
        fireError: () => self.onerror?.(),
      } as FakeES);
    }
    addEventListener(type: string, cb: (ev: MessageEvent) => void) {
      this.listeners[type] = cb;
    }
    removeEventListener(type: string) {
      delete this.listeners[type];
    }
    close() {}
  }
  vi.stubGlobal('EventSource', MockES);
  return instances;
}

/**
 * Route fetch by URL/method:
 *   POST .../subscribe-ticket        → { ticket }
 *   GET  .../api/sdk/messages?...     → the next queued replay page (list())
 * Replay pages are consumed FIFO from `replayPages` per-room via room_id in the
 * query string so a multi-room fan-out test can queue per room.
 */
function installFetchRouter(replayByRoom: Map<string, unknown[][]>): void {
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
        const pages = replayByRoom.get(roomId);
        const items = (pages && pages.length > 0 ? pages.shift() : []) ?? [];
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

describe('subscribe() reconnect replay — per-room decrypt chain (SEC-CR-14-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('graceful shutdown: replay unseal must NOT run concurrently with an in-flight streamed unseal', async () => {
    const room = 'room-shutdown';
    const provider = makeRoomTrackingProvider();
    const instances = installMockEventSource();
    const replayByRoom = new Map<string, unknown[][]>();
    installFetchRouter(replayByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();
    expect(instances.length).toBe(1);

    // Live frame seq=1 arrives → its unseal starts on the chain and HANGS.
    instances[0]!.emit(frame(1));
    await flushMicrotasks();
    expect(provider.inFlightByRoom.get(room)).toBe(1);
    expect(provider.maxFor(room)).toBe(1);

    // Queue a replay row (seq=2 arrived while disconnected) for this room.
    replayByRoom.set(room, [[listRow(2)]]);

    // Server graceful shutdown → reconnectImmediate → list()-replay of seq=2.
    instances[0]!.fireShutdown();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // INVARIANT: the replay unseal(2) must queue behind the still-in-flight
    // unseal(1), never run concurrently. Off-chain list() unseal breaks this.
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    provider.releaseAll();
    await flushMicrotasks();
  });

  it('onerror reconnect: replay unseal must NOT run concurrently with an in-flight streamed unseal', async () => {
    const room = 'room-onerror';
    const provider = makeRoomTrackingProvider();
    const instances = installMockEventSource();
    const replayByRoom = new Map<string, unknown[][]>();
    installFetchRouter(replayByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();

    instances[0]!.emit(frame(1));
    await flushMicrotasks();
    expect(provider.inFlightByRoom.get(room)).toBe(1);

    replayByRoom.set(room, [[listRow(2)]]);

    // SSE error → reconnect(0) with jittered backoff (base 1000ms).
    instances[0]!.fireError();
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    provider.releaseAll();
    await flushMicrotasks();
  });

  it('shutdown fan-out: each of several rooms reconnecting at once stays <=1 unseal in flight', async () => {
    const rooms = ['fanout-a', 'fanout-b', 'fanout-c'];
    const provider = makeRoomTrackingProvider();
    const instances = installMockEventSource();
    const replayByRoom = new Map<string, unknown[][]>();
    installFetchRouter(replayByRoom);

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    for (const r of rooms) client.subscribe(r, { onMessage: vi.fn() });
    await settleInitialSubscribe();
    expect(instances.length).toBe(rooms.length);

    // Each room gets an in-flight streamed unseal (distinct seq per room).
    rooms.forEach((_r, i) => instances[i]!.emit(frame(10 + i)));
    await flushMicrotasks();
    rooms.forEach((r) => expect(provider.inFlightByRoom.get(r)).toBe(1));

    // Queue a replay row per room, then fire shutdown on every stream at once
    // (the real fleet-wide trigger: one server graceful restart).
    rooms.forEach((r, i) => replayByRoom.set(r, [[listRow(20 + i)]]));
    rooms.forEach((_r, i) => instances[i]!.fireShutdown());
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Per-room serialization holds independently: none exceeds 1 in flight.
    rooms.forEach((r) => expect(provider.maxFor(r)).toBeLessThanOrEqual(1));

    provider.releaseAll();
    await flushMicrotasks();
  });

  it('replay preserves order: missed row delivers after the in-flight unseal drains, before the resumed live stream', async () => {
    const room = 'room-order';
    const provider = makeRoomTrackingProvider();
    const instances = installMockEventSource();
    const replayByRoom = new Map<string, unknown[][]>();
    installFetchRouter(replayByRoom);

    const delivered: number[] = [];
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(room, { onMessage: (row) => { delivered.push(row.seq); } });
    await settleInitialSubscribe();

    // Live seq=1 unseal starts and hangs.
    instances[0]!.emit(frame(1));
    await flushMicrotasks();
    expect(delivered).toEqual([]);

    // Replay seq=2 queued; shutdown triggers reconnect.
    replayByRoom.set(room, [[listRow(2)]]);
    instances[0]!.fireShutdown();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Nothing delivered yet — replay seq=2 is queued behind the hung unseal(1).
    expect(delivered).toEqual([]);
    expect(provider.maxFor(room)).toBeLessThanOrEqual(1);

    // Drain seq=1 → delivers, then seq=2 unseal may run.
    provider.release(room, 1);
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();
    expect(delivered).toEqual([1, 2]);

    // A live frame on the re-attached stream unseals AFTER the replay, still serial.
    expect(instances.length).toBe(2);
    instances[1]!.emit(frame(3));
    await flushMicrotasks();
    provider.release(room, 3);
    await flushMicrotasks();
    expect(delivered).toEqual([1, 2, 3]);
    expect(provider.maxFor(room)).toBe(1);
  });

  // SEC-CR-14-03: teardown racing an in-flight reconnect fetch must deliver
  // nothing to the torn-down subscriber — and must not append onto a surviving
  // co-subscriber's still-live chain. A co-subscriber keeps the room's refCount
  // > 0, so append would NOT no-op; only the destroyed re-check drops delivery.
  it('teardown during an in-flight reconnect fetch delivers nothing to the torn-down subscriber', async () => {
    const room = 'room-teardown-during-reconnect';
    const provider = makeRoomTrackingProvider();
    const instances = installMockEventSource();
    let releaseList: (() => void) | null = null;
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
          // Hang the reconnect replay fetch until released, so teardown can race it.
          await new Promise<void>((r) => { releaseList = r; });
          return new Response(
            JSON.stringify({ items: [listRow(2)], has_more: false, next_cursor: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    const aMsgs: number[] = [];
    const teardownA = client.subscribe(room, { onMessage: (row) => { aMsgs.push(row.seq); } });
    // Co-subscriber B keeps the room chain alive (refCount stays > 0 after A leaves).
    const teardownB = client.subscribe(room, { onMessage: vi.fn() });
    await settleInitialSubscribe();
    expect(instances.length).toBe(2);

    // A's stream shuts down → reconnectImmediate → replay fetch hangs in flight.
    instances[0]!.fireShutdown();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(releaseList).not.toBeNull();

    // Tear down A while its replay fetch is still in flight.
    teardownA();

    // Release the fetch → replayMissed resolves; the destroyed guard must drop it
    // before any append. Release the (would-be) unseal too so a MISSING guard
    // would visibly deliver seq=2 to A (this keeps the assertion non-vacuous).
    releaseList!();
    await flushMicrotasks();
    provider.release(room, 2);
    await flushMicrotasks();

    expect(aMsgs).toEqual([]);

    provider.releaseAll();
    await flushMicrotasks();
    teardownB();
  });
});
