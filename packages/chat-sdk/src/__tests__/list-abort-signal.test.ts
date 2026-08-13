/**
 * list-abort-signal.test.ts — #312: an AbortSignal that reaches INSIDE list().
 *
 * What #312 actually was, once measured: NOT the unbounded off-chain unseal loop
 * its text described. #309 (fix for #185) had already removed that loop — every
 * fetched-row unseal goes through `#appendDecryptTask`, which is bounded by a 5s
 * abort deadline plus a 5s force-drain grace. The export branch was cut FROM that
 * commit, so the three docstrings claiming an unbounded loop were false when
 * written, not stale.
 *
 * The real gap is abort LATENCY. `ListArgs` carried no signal, so a caller's
 * `abort()` could not reach either leg of `list()`: not the HTTP fetch, and not
 * the per-row unseal. With a provider that hangs, the caller waited for the whole
 * page to drain serially — up to `10s × limit` (minutes at the server's page cap)
 * — before the cancellation was even looked at.
 *
 * This suite gates the fix. Every `it` that guards a silent-failure surface names
 * the file:line mutation that must turn it RED; a bound that only ever proves
 * "terminates eventually" would pass against unpatched main, since main already
 * terminates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const SENDER_UID = 'user-1';
const ROOM = 'room-312';

async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** A list() row whose sealed bytes encode `seq` as their single byte. */
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

interface HangingProvider extends CryptoProvider {
  /**
   * Seqs handed to unseal(), in order. The load-bearing oracle for the ratchet
   * claim: a row the caller cancelled must never appear here, because calling
   * unseal advances replay/ratchet state for a row nobody will receive.
   */
  started: number[];
  releaseAll(): void;
}

/**
 * A provider whose unseal() HANGS until released. `honorSignal` models the two
 * halves of the CryptoProvider contract — one that rejects on the AbortSignal
 * (a worker/KMS that wires it up) and one that ignores it (bounded only by the
 * chain's force-drain). Both are legal; the fix must behave for both.
 */
function makeHangingProvider(honorSignal = true): HangingProvider {
  const resolvers: Array<() => void> = [];
  const p: HangingProvider = {
    started: [],
    async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> {
      return plaintext;
    },
    unseal(sealed: ArrayBuffer, _ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      p.started.push(seq);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        resolvers.push(() => resolve(new Uint8Array([seq]).buffer as ArrayBuffer));
        if (honorSignal) {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
      });
    },
    releaseAll(): void {
      for (const r of resolvers.splice(0)) r();
    },
  };
  return p;
}

interface FetchOpts {
  rows: number[];
  /** When true the fetch itself hangs until ITS AbortSignal fires (network leg). */
  hangUntilAbort?: boolean;
}

function installFetch(opts: FetchOpts): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      if (opts.hangUntilAbort === true) {
        return await new Promise<Response>((_resolve, reject) => {
          const s = init?.signal;
          // No signal reached fetch → this hangs, which is exactly the RED the
          // `signal: args.signal` mutation below is meant to produce.
          if (s == null) return;
          if (s.aborted) {
            reject(s.reason);
            return;
          }
          s.addEventListener('abort', () => reject(s.reason), { once: true });
        });
      }
      return new Response(
        JSON.stringify({
          items: opts.rows.map(listRow),
          has_more: false,
          next_cursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

function makeClient(provider: CryptoProvider): SDKChatClient {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
}

describe('#312 — AbortSignal reaches inside list()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects the caller AS SOON AS the abort fires, not after the page drains', async () => {
    // MUTATION GATE — must go RED:
    //   client.ts #unsealRowsOnChain — replace
    //     `if (signal === undefined) return page;`
    //   with
    //     `return page;`
    //   The caller then waits for the whole page. Timers are frozen and the
    //   provider hangs, so nothing settles it: the test times out instead of
    //   passing. Note what this does NOT assert — "the export terminates" is
    //   true on unpatched main too (force-drain), so it would gate nothing.
    const provider = makeHangingProvider();
    installFetch({ rows: [1, 2, 3] });
    const client = makeClient(provider);

    const ac = new AbortController();
    const p = client.list(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    // Serial chain: exactly one unseal in flight for the room (SEC-CR-14-02).
    expect(provider.started).toEqual([1]);

    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never hands a cancelled row to the provider', async () => {
    // MUTATION GATE — must go RED:
    //   client.ts #appendDecryptTask — delete the
    //     `if (signal?.aborted === true) { deliver(mappedRow); return; }`
    //   block. Rows 2 and 3 then reach provider.unseal AFTER the caller cancelled,
    //   each with a FRESH controller (a listener registered after an abort event
    //   has already fired never runs), so `started` grows past [1].
    //
    // This is the ratchet-safety half of the fix, not an optimisation: unsealing a
    // row nobody will receive advances replay-window / ratchet state for it.
    const provider = makeHangingProvider();
    installFetch({ rows: [1, 2, 3] });
    const client = makeClient(provider);

    const ac = new AbortController();
    const p = client.list(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    ac.abort();
    await expect(p).rejects.toThrow();
    await flushMicrotasks();

    expect(provider.started).toEqual([1]);
  });

  it('drains the chain and leaves the room usable afterwards', async () => {
    // MUTATION GATE — must go RED:
    //   client.ts #appendDecryptTask — delete
    //     `signal?.addEventListener('abort', forwardAbort, { once: true });`
    //   The in-flight row is then never told to stop, so it hangs to its 5s
    //   deadline; with timers frozen the chain never drains and the entry count
    //   stays 1.
    //
    // The wedge is the failure this fix most risks and the one that would be
    // SILENT in production: rejecting the caller early while the chain still
    // holds the room's entry would break every LATER call for that room.
    // `_decryptChainSize()` is the repo's own leak oracle, not one written here.
    const provider = makeHangingProvider();
    installFetch({ rows: [1, 2] });
    const client = makeClient(provider);

    const ac = new AbortController();
    const p = client.list(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    ac.abort();
    await expect(p).rejects.toThrow();
    await flushMicrotasks();

    expect(client._decryptChainSize()).toBe(0);

    // And the room still decrypts: a cancelled call must not poison its successor.
    installFetch({ rows: [9] });
    const p2 = client.list(ROOM, {});
    await flushMicrotasks();
    expect(provider.started).toContain(9);
    provider.releaseAll();
    const res = await p2;
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.unsealError).toBeUndefined();
    expect(res.items[0]?.plaintext).toBeDefined();
  });

  it('force-drains a signal-IGNORING provider in the background, bounded', async () => {
    // Not a mutation gate — this asserts the bound the new docstrings CLAIM, which
    // is the thing #311 got wrong by asserting a bound that did not exist. The
    // caller is rejected immediately either way; what is bounded is the orphaned
    // row's background drain, at deadline + grace.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeHangingProvider(false);
    installFetch({ rows: [1, 2] });
    const client = makeClient(provider);

    const ac = new AbortController();
    const p = client.list(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await flushMicrotasks();

    // Caller already rejected, row still orphaned in flight → entry still held.
    expect(client._decryptChainSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(
      10_000, // DECRYPT_DEADLINE_MS + DECRYPT_FORCE_DRAIN_GRACE_MS
    );
    await flushMicrotasks();
    expect(client._decryptChainSize()).toBe(0);
  });

  it('surfaces an abort during the FETCH as AbortError, not SDKChatError(network)', async () => {
    // MUTATION GATE — must go RED, two independent mutations:
    //   (a) client.ts #fetchRows — delete `signal: args.signal,` from the fetch
    //       init. The stub then never sees an abort and the test times out.
    //   (b) client.ts #fetchRows — delete
    //         `if (isAbortError(err, args.signal)) throw err;`
    //       The abort is rewrapped as SDKChatError('network'), so `name` is no
    //       longer 'AbortError' — a cancelled call becomes indistinguishable from
    //       a dropped connection, and exportRoomHistory's documented contract
    //       breaks.
    installFetch({ rows: [], hangUntilAbort: true });
    const client = makeClient(makeHangingProvider());

    const ac = new AbortController();
    const p = client.list(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels an exportRoom() stuck INSIDE its first page', async () => {
    // MUTATION GATE — must go RED:
    //   export.ts — drop `signal` from
    //     `client.list(roomId, { afterSeq: 0, limit, signal })`.
    //   The page carries has_more:false, so the between-pages check is never
    //   reached; with nothing else able to cancel, the export hangs. That is the
    //   end-to-end shape of the bug #312 was filed for, minus its wrong mechanism.
    const provider = makeHangingProvider();
    installFetch({ rows: [1, 2] });
    const client = makeClient(provider);

    const ac = new AbortController();
    const p = client.exportRoom(ROOM, { signal: ac.signal });
    await flushMicrotasks();
    expect(provider.started).toEqual([1]);

    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves getThread / searchByProductRef untouched (no signal, no behaviour change)', async () => {
    // The signal parameter is optional on #unsealFetchedRows and those two callers
    // pass two arguments, so they keep the pre-#312 path exactly. Guards against a
    // later edit wiring a signal into them by accident and inheriting the
    // early-reject semantics without a decision.
    const provider = makeHangingProvider();
    installFetch({ rows: [1] });
    const client = makeClient(provider);

    const p = client.list(ROOM, {}); // no signal at all
    await flushMicrotasks();
    provider.releaseAll();
    const res = await p;
    expect(res.items[0]?.plaintext).toBeDefined();
    expect(client._decryptChainSize()).toBe(0);
  });
});
