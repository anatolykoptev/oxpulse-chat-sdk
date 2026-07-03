/**
 * subscribe-decrypt-chain-refcount.test.ts
 *
 * HIGH E2EE-integrity concurrency bug: the per-room serial-decrypt chain used by
 * subscribe() is keyed by the bare roomId and its teardown closure deletes the
 * shared chain entry UNCONDITIONALLY. When two subscribe() calls share a roomId
 * on one client (widget remount / visibility re-subscribe without awaiting
 * teardown / reconnect race), tearing down the FIRST removes the SHARED chain.
 * The surviving subscriber's next inbound frame then starts a FRESH chain from
 * Promise.resolve(), so its unseal() runs CONCURRENTLY with any unseal still
 * in-flight — breaking the strictly-serial in-order-unseal invariant that a
 * ratcheting AEAD (SFrame replay window) depends on.
 *
 * Invariant under test: for one room, at most ONE provider.unseal() is ever
 * in flight at a time (serial), regardless of subscribe/teardown interleaving.
 *
 * RED against HEAD 25e7e72: tearing down subscriber A while B is live lets B's
 * unseal run concurrently with A's in-flight unseal → maxInFlight === 2.
 * GREEN after refcounting the shared chain (delete only at refCount 0).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const ROOM_ID = 'room-shared-chain';
const SENDER_UID = 'user-1';

async function flushMicrotasks(rounds = 15): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Controllable crypto provider: unseal() hangs until releaseSeq(seq) is called,
 * and tracks concurrency (inFlight / maxInFlight) plus the order unseals STARTED.
 * The seq of each frame is encoded as the first byte of its sealed bytes.
 */
interface ControllableProvider extends CryptoProvider {
  inFlight: number;
  maxInFlight: number;
  startedOrder: number[];
  releaseSeq(seq: number): void;
  releaseAll(): void;
}

function makeControllableProvider(): ControllableProvider {
  const resolvers = new Map<number, () => void>();
  const p: ControllableProvider = {
    inFlight: 0,
    maxInFlight: 0,
    startedOrder: [],
    async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      return plaintext;
    },
    unseal(sealed: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      p.inFlight += 1;
      p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
      p.startedOrder.push(seq);
      return new Promise<ArrayBuffer>((resolve) => {
        resolvers.set(seq, () => {
          p.inFlight -= 1;
          // Return a distinct plaintext byte so callers can distinguish frames.
          resolve(new Uint8Array([seq]).buffer);
        });
      });
    },
    releaseSeq(seq: number): void {
      const r = resolvers.get(seq);
      if (r) {
        resolvers.delete(seq);
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
  const sealedB64 = btoa(String.fromCharCode(seq));
  return JSON.stringify({
    seq,
    msg_id: `m${seq}`,
    sender_uid: SENDER_UID,
    sealed_b64: sealedB64,
    created_at: '2026-05-18T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  });
}

interface FakeES {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, (ev: MessageEvent) => void>;
  emit(data: string): void;
}

/** Install a mock EventSource that collects EVERY constructed instance in order. */
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

function stubTicketFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
      text: async () => '',
    } as unknown as Response),
  );
}

describe('subscribe() per-room decrypt chain — shared-subscriber refcount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('teardown of one of two subscribers must NOT let the survivor decrypt concurrently', async () => {
    const provider = makeControllableProvider();
    const instances = installMockEventSource();
    stubTicketFetch();

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider },
    });

    // Two independent subscribers to the SAME room on ONE client instance.
    const teardownA = client.subscribe(ROOM_ID, { onMessage: vi.fn() });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    const teardownB = client.subscribe(ROOM_ID, { onMessage: vi.fn() });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(instances.length).toBe(2);
    const esA = instances[0]!;
    const esB = instances[1]!;

    // Frame 1 arrives on A → unseal(1) starts and HANGS (in flight).
    esA.emit(frame(1));
    await flushMicrotasks();
    expect(provider.inFlight).toBe(1);
    expect(provider.maxInFlight).toBe(1);

    // Tear down subscriber A while A's unseal(1) is still in flight and B is live.
    teardownA();

    // Frame 2 arrives on the SURVIVING subscriber B.
    esB.emit(frame(2));
    await flushMicrotasks();

    // INVARIANT: unseal must stay serial for the room — unseal(2) must wait for
    // the in-flight unseal(1), never run concurrently. The unconditional
    // delete(roomId) in A's teardown breaks this → maxInFlight becomes 2.
    expect(provider.maxInFlight).toBeLessThanOrEqual(1);

    // Cleanup: release hung unseals so no promise dangles.
    provider.releaseAll();
    await flushMicrotasks();
    teardownB();
  });

  // Regression lock: the single-subscriber in-order guarantee must be unchanged.
  it('single subscriber: frames unseal strictly serially and deliver in seq order', async () => {
    const provider = makeControllableProvider();
    const instances = installMockEventSource();
    stubTicketFetch();

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider },
    });

    const delivered: number[] = [];
    const teardown = client.subscribe(ROOM_ID, {
      onMessage: (row) => { delivered.push(row.seq); },
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    const es = instances[0]!;

    // Three frames arrive back-to-back before any unseal completes.
    es.emit(frame(1));
    es.emit(frame(2));
    es.emit(frame(3));
    await flushMicrotasks();

    // Head-of-line: only frame 1's unseal has started; 2 and 3 are queued.
    expect(provider.startedOrder).toEqual([1]);
    expect(provider.inFlight).toBe(1);
    expect(delivered).toEqual([]);

    // Complete frame 1 → it delivers, then frame 2's unseal starts.
    provider.releaseSeq(1);
    await flushMicrotasks();
    expect(delivered).toEqual([1]);
    expect(provider.startedOrder).toEqual([1, 2]);

    provider.releaseSeq(2);
    await flushMicrotasks();
    expect(delivered).toEqual([1, 2]);
    expect(provider.startedOrder).toEqual([1, 2, 3]);

    provider.releaseSeq(3);
    await flushMicrotasks();

    // Delivery order matches injection order; never more than one unseal at once.
    expect(delivered).toEqual([1, 2, 3]);
    expect(provider.maxInFlight).toBe(1);

    teardown();
  });
});
