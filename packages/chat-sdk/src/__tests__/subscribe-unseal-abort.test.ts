/**
 * subscribe-unseal-abort.test.ts
 *
 * The LAST residual of the concurrent-unseal class (e2ee-model.md §3): the 5s
 * per-row unseal timeout was a `Promise.race` that ABANDONS — not cancels — a
 * slow unseal. On a >5s row the abandoned `provider.unseal` kept running detached
 * while the chain task settled (as `unsealError`) and the chain started the NEXT
 * unseal → TWO unseals in flight for the same room, violating the "one unseal in
 * flight per room" invariant a ratcheting AEAD needs.
 *
 * Fix under test (fix/e2ee-unseal-cancel):
 *   - `CryptoProvider.unseal(sealed, ctx, signal?)` gains an OPTIONAL AbortSignal
 *     (backward-compatible — a 2-arg provider still works, just non-cancelling).
 *   - `#appendDecryptTask` bounds each unseal TWICE: an AbortController at the abort
 *     deadline (a signal-honoring provider rejects promptly → chain advances, strict
 *     one-in-flight), AND a FORCE-DRAIN at deadline+grace — if the unseal STILL has
 *     not settled (a provider that ignores the signal AND hangs), that one row is
 *     bailed as unsealError so the chain DRAINS (bounded), rather than black-holing
 *     the room. No more Promise.race abandonment (which started the next unseal while
 *     the loser ran detached → two-in-flight).
 *
 * Invariant under test: for one room, at most ONE provider.unseal() is ever in
 * flight — across the >5s deadline boundary too.
 *
 * RED against main 5487a3d: crossing the 5s deadline abandons the slow unseal and
 * starts the next → per-room maxInFlight === 2. GREEN after the abort + gate fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';
import { installMockEventSource, flush, TEST_BASE_URL, TEST_JWT, TEST_SENDER_UID } from './helpers.js';

const ROOM_ID = 'room-unseal-abort';

/** SSE frame whose sealed_b64 encodes `seq` as its single byte. */
function frame(seq: number): string {
  return JSON.stringify({
    seq,
    msg_id: `m${seq}`,
    sender_uid: TEST_SENDER_UID,
    sealed_b64: btoa(String.fromCharCode(seq)),
    created_at: '2026-05-18T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  });
}

/** Ticket fetch stub — subscribe() POSTs for a stream ticket before attaching. */
function stubTicketFetch(): void {
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

interface Provider extends CryptoProvider {
  inFlight: number;
  maxInFlight: number;
  startedOrder: number[];
  /** seqs whose unseal() received a defined AbortSignal (proves the signal is threaded). */
  sawSignal: Set<number>;
  releaseSeq(seq: number): void;
  releaseAll(): void;
}

/**
 * Controllable unseal provider. `unseal` hangs until `releaseSeq(seq)`.
 * When `honorSignal` is true it ALSO rejects promptly if its per-call AbortSignal
 * fires — modelling a cancel-capable provider (worker/streaming/KMS-with-abort).
 * When false it ignores the signal entirely — modelling the built-in WebCrypto
 * provider whose atomic AES-GCM decrypt cannot be cancelled.
 */
function makeProvider(honorSignal: boolean): Provider {
  const resolvers = new Map<number, () => void>();
  const p: Provider = {
    inFlight: 0,
    maxInFlight: 0,
    startedOrder: [],
    sawSignal: new Set<number>(),
    async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      return plaintext;
    },
    unseal(sealed: ArrayBuffer, _ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      p.inFlight += 1;
      p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
      p.startedOrder.push(seq);
      if (signal) p.sawSignal.add(seq);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          p.inFlight -= 1;
          fn();
        };
        resolvers.set(seq, () => finish(() => resolve(new Uint8Array([seq]).buffer)));
        if (honorSignal && signal) {
          const onAbort = (): void =>
            finish(() => reject(signal.reason ?? new DOMException('aborted', 'AbortError')));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
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

interface Delivered {
  seq: number;
  ok: boolean;
  err?: 'replay' | 'auth' | 'unknown';
}

async function subscribeAndSettle(
  client: SDKChatClient,
  onRow: (d: Delivered) => void,
): Promise<() => void> {
  const teardown = client.subscribe(ROOM_ID, {
    onMessage: (row) =>
      onRow(
        row.plaintext !== undefined
          ? { seq: row.seq, ok: true }
          : { seq: row.seq, ok: false, err: row.unsealError },
      ),
  });
  await flush();
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  return teardown;
}

describe('subscribe() unseal deadline — abort + chain-advance gating (>5s residual)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a >5s unseal aborts and does NOT start the next unseal concurrently [signal-honoring provider]', async () => {
    const provider = makeProvider(true);
    const es = installMockEventSource();
    stubTicketFetch();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT, e2ee: { provider } });
    const delivered: Delivered[] = [];
    const teardown = await subscribeAndSettle(client, (d) => delivered.push(d));

    const ctrl = es.getLastController()!;
    ctrl.emitMessage(frame(1)); // unseal(1) starts, hangs
    ctrl.emitMessage(frame(2)); // queued behind unseal(1)
    await flush();
    expect(provider.startedOrder).toEqual([1]);
    expect(provider.inFlight).toBe(1);
    expect(provider.sawSignal.has(1)).toBe(true); // signal threaded through (RED on HEAD: false)

    // Cross the 5s delivery deadline.
    // FIX: the client aborts unseal(1)'s signal -> provider rejects unseal(1) -> the
    //      chain advances ONLY THEN -> unseal(2) starts with unseal(1) already SETTLED.
    // HEAD: Promise.race abandons the still-hung unseal(1) -> chain advances -> unseal(2)
    //      starts concurrently -> maxInFlight 2.
    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(provider.maxInFlight).toBeLessThanOrEqual(1); // RED on HEAD (=== 2)
    expect(delivered).toEqual([{ seq: 1, ok: false, err: 'unknown' }]);
    expect(provider.startedOrder).toEqual([1, 2]); // unseal(2) started AFTER unseal(1) settled

    // unseal(2) succeeds -> delivered in order, still one in flight.
    provider.releaseSeq(2);
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: false, err: 'unknown' }, { seq: 2, ok: true }]);
    expect(provider.maxInFlight).toBeLessThanOrEqual(1);

    warnSpy.mockRestore();
    teardown();
  });

  it('a slow unseal that SUCCEEDS past the deadline is delivered once as plaintext, in order — no double-deliver, no concurrency [non-honoring provider]', async () => {
    const provider = makeProvider(false); // ignores the signal (models WebCrypto atomic decrypt)
    const es = installMockEventSource();
    stubTicketFetch();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT, e2ee: { provider } });
    const delivered: Delivered[] = [];
    const teardown = await subscribeAndSettle(client, (d) => delivered.push(d));

    const ctrl = es.getLastController()!;
    ctrl.emitMessage(frame(1));
    ctrl.emitMessage(frame(2));
    await flush();
    expect(provider.inFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(5000); // deadline crosses; provider ignores abort -> unseal(1) still hung
    await flush();

    // FIX: chain gated on real settle -> unseal(2) NOT started; nothing delivered yet.
    // HEAD: Promise.race abandoned unseal(1) -> delivered unsealError(1) -> unseal(2) started.
    expect(provider.startedOrder).toEqual([1]); // RED on HEAD ([1, 2])
    expect(provider.maxInFlight).toBe(1);
    expect(delivered).toEqual([]); // RED on HEAD ([{ seq: 1, ok: false, err: 'unknown' }])

    // unseal(1) finally completes -> its REAL plaintext is delivered (not discarded), in order.
    provider.releaseSeq(1);
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: true }]); // RED on HEAD (would be ok:false unsealError)
    expect(provider.startedOrder).toEqual([1, 2]); // only now does unseal(2) start

    provider.releaseSeq(2);
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: true }, { seq: 2, ok: true }]);
    expect(provider.maxInFlight).toBe(1);

    warnSpy.mockRestore();
    teardown();
  });

  it('bounded-drain: a non-honoring provider that NEVER settles force-drains each row as unsealError after deadline+grace — chain keeps advancing, no black-hole, no leak', async () => {
    // This is the HIGH the pr-council caught: awaiting the real settle without a bound
    // turns a hung non-honoring provider into a permanent room black-hole + Map leak.
    // The force-drain restores the bounded-settle guarantee WITHOUT reintroducing
    // two-in-flight for the healthy path.
    const provider = makeProvider(false); // ignores the abort AND we never releaseSeq → hangs forever
    const es = installMockEventSource();
    stubTicketFetch();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT, e2ee: { provider } });
    const delivered: Delivered[] = [];
    const teardown = await subscribeAndSettle(client, (d) => delivered.push(d));

    const ctrl = es.getLastController()!;
    ctrl.emitMessage(frame(1));
    ctrl.emitMessage(frame(2));
    await flush();

    // At the abort DEADLINE (5s) alone the chain is still gated (the abort is ignored,
    // the unseal has not settled, force-drain has not fired) — nothing delivered yet,
    // strictly one in flight. This proves the deadline does not itself abandon the row.
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(provider.startedOrder).toEqual([1]);
    expect(delivered).toEqual([]);
    expect(provider.maxInFlight).toBe(1);

    // Cross the FORCE-DRAIN bound (deadline+grace = 10s) for row 1 → it bails as
    // unsealError and the chain DRAINS: unseal(2) now starts (RED against #25 code,
    // where the chain awaited the real settle and hung here → delivered stays []).
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: false, err: 'unknown' }]);
    expect(provider.startedOrder).toEqual([1, 2]);
    // INHERENT residual: row 1's unseal is ORPHANED (JS cannot cancel a pending promise),
    // so while unseal(2) runs, the still-pending unseal(1) counts as in-flight → maxInFlight
    // reaches 2 for the genuinely-stuck case. This is NOT the every->5s-row two-in-flight of
    // the old Promise.race — it happens ONLY after deadline+grace, and the orphan is PARKED
    // (not progressing / not racing the ratchet), its late result dropped (asserted next).
    expect(provider.maxInFlight).toBe(2);
    // Observable: the force-drain is not silent. Match the force-drain-specific token
    // ('force-draining'), not 'force-drain', so the deadline warn (which mentions the
    // 'force-drain grace') cannot satisfy this assertion.
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes('force-draining')),
    ).toBe(true);

    // SAFETY: if the orphaned stuck unseal(1) settles LATE, its result MUST be dropped —
    // no re-delivery, no chain advance from it (the `settled` guard). Release it now.
    provider.releaseSeq(1);
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: false, err: 'unknown' }]); // unchanged — not re-delivered

    // Tear down the (only) subscriber, then force-drain row 2 too. release() defers the
    // chain-entry delete until the chain drains — which force-drain guarantees.
    teardown();
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(delivered).toEqual([
      { seq: 1, ok: false, err: 'unknown' },
      { seq: 2, ok: false, err: 'unknown' },
    ]);

    // No leak: the room's decrypt-chain entry is removed once its chain drained and its
    // last subscriber released (RED against #25 code — the eternally-pending tail never
    // fires release()'s deferred delete).
    expect(client._decryptChainSize()).toBe(0);

    provider.releaseAll();
    await flush();
    warnSpy.mockRestore();
  });

  it('regression: a normal (<5s) unseal is unaffected — delivered as plaintext, no deadline signal, timer cleared', async () => {
    const provider = makeProvider(true);
    const es = installMockEventSource();
    stubTicketFetch();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT, e2ee: { provider } });
    const delivered: Delivered[] = [];
    const teardown = await subscribeAndSettle(client, (d) => delivered.push(d));

    const ctrl = es.getLastController()!;
    ctrl.emitMessage(frame(1));
    await flush();
    provider.releaseSeq(1); // resolves well within the 5s deadline
    await flush();
    expect(delivered).toEqual([{ seq: 1, ok: true }]);

    // Advancing past 5s must NOT fire a spurious abort/deadline signal (timer cleared on settle).
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes('deadline')),
    ).toBe(false);
    expect(provider.maxInFlight).toBe(1);

    warnSpy.mockRestore();
    teardown();
  });

  it('backward-compat: a CryptoProvider whose unseal takes NO signal param still works', async () => {
    // 2-arg unseal (the pre-existing provider shape) — the optional signal must not
    // break a provider that ignores it. This is the compile-time + runtime guard that
    // `signal?` stays additive (a REQUIRED signal would fail to typecheck here).
    const provider: CryptoProvider = {
      async seal(pt: ArrayBuffer): Promise<ArrayBuffer> {
        return pt;
      },
      async unseal(sealed: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
        return sealed;
      },
    };
    const es = installMockEventSource();
    stubTicketFetch();

    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT, e2ee: { provider } });
    const delivered: Delivered[] = [];
    const teardown = await subscribeAndSettle(client, (d) => delivered.push(d));

    es.getLastController()!.emitMessage(frame(7));
    await flush();
    expect(delivered).toEqual([{ seq: 7, ok: true }]);

    teardown();
  });
});
