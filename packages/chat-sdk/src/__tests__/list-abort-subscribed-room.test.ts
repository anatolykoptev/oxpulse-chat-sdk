/**
 * list-abort-subscribed-room.test.ts — #312, the interleaving the change most endangers.
 *
 * Aborting a list() on a room that ALSO has a live subscription puts two kinds of
 * task on the same serial chain: the list rows, which carry the caller's signal and
 * short-circuit on abort, and the subscriber's rows, which carry no signal and
 * belong to a different caller entirely. The cancellation must not cross that line,
 * and neither must the ratchet's at-most-one-unseal-in-flight invariant
 * (SEC-CR-14-02) bend around the early reject.
 *
 * A regression guard rather than a mutation gate: it fails on a change that leaks
 * the caller's signal into subscriber tasks, or that lets the abandoned page run
 * concurrently with the live stream. Both would be SILENT in production — the
 * subscriber would simply stop delivering, or the ratchet would desync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';
import { installMockEventSource } from './helpers.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const SENDER_UID = 'user-1';
const ROOM = 'room-probe';

async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function row(seq: number): Record<string, unknown> {
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

interface P extends CryptoProvider {
  inFlight: number;
  maxInFlight: number;
  started: number[];
  release(seq: number): void;
}

function makeProvider(): P {
  const resolvers = new Map<number, () => void>();
  const p: P = {
    inFlight: 0,
    maxInFlight: 0,
    started: [],
    async seal(pt: ArrayBuffer, _c: SealContext): Promise<ArrayBuffer> {
      return pt;
    },
    unseal(sealed: ArrayBuffer, _c: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
      const seq = new Uint8Array(sealed)[0] ?? 0;
      p.started.push(seq);
      p.inFlight += 1;
      p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        let done = false;
        const dec = (): void => {
          if (done) return;
          done = true;
          p.inFlight -= 1;
        };
        resolvers.set(seq, () => {
          dec();
          resolve(new Uint8Array([seq]).buffer as ArrayBuffer);
        });
        signal?.addEventListener(
          'abort',
          () => {
            dec();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    release(seq: number): void {
      resolvers.get(seq)?.();
      resolvers.delete(seq);
    },
  };
  return p;
}

describe('PROBE — abort a list() on a SUBSCRIBED room', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not run two unseals at once and leaves the subscriber working', async () => {
    const provider = makeProvider();
    const es = installMockEventSource();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/subscribe-ticket')) {
          return new Response(JSON.stringify({ ticket: 't1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ items: [row(10), row(11), row(12)], has_more: false, next_cursor: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    const seen: number[] = [];
    client.subscribe(ROOM, {
      onMessage: (r) => {
        if (r.plaintext !== undefined) seen.push(new Uint8Array(r.plaintext)[0] ?? -1);
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(es.getControllers().length).toBe(1);
    expect(client._decryptChainSize()).toBe(1);

    // Live frame seq=1 starts unsealing and HANGS.
    es.getLastController()!.emitMessage(
      JSON.stringify({ ...row(1), sealed_b64: btoa(String.fromCharCode(1)) }),
    );
    await flush();
    expect(provider.started).toEqual([1]);

    // Scrollback list() of the SAME room, cancellable, queues behind it.
    const ac = new AbortController();
    const p = client.list(ROOM, { beforeSeq: 100, signal: ac.signal });
    await flush();
    expect(provider.maxInFlight).toBeLessThanOrEqual(1);

    // Caller cancels while the subscriber's unseal is still in flight.
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await flush();

    // The subscriber's own in-flight unseal must NOT have been cancelled — it
    // carries no signal and belongs to a different caller.
    expect(provider.started).toEqual([1]);
    expect(provider.inFlight).toBe(1);

    // Release it: the subscriber still gets its message, and the cancelled
    // scrollback rows were never unsealed.
    provider.release(1);
    await flush();
    expect(seen).toEqual([1]);
    expect(provider.started).toEqual([1]);
    expect(provider.maxInFlight).toBe(1);

    // A later live frame still decrypts — the room is not wedged.
    es.getLastController()!.emitMessage(
      JSON.stringify({ ...row(2), sealed_b64: btoa(String.fromCharCode(2)) }),
    );
    await flush();
    provider.release(2);
    await flush();
    expect(seen).toEqual([1, 2]);
    expect(provider.maxInFlight).toBe(1);
    expect(client._decryptChainSize()).toBe(1); // still one LIVE subscriber
  });
});
