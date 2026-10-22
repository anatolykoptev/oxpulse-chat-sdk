/**
 * batch-append-retry.test.ts — batchAppend() per-attempt timeout + bounded retry.
 *
 * Retrying is safe only because every row carries a caller-supplied msg_id and the
 * server's batch_append is `INSERT ... ON CONFLICT (app_id, room_id, msg_id) DO
 * UPDATE SET app_id = EXCLUDED.app_id` in ONE transaction (oxpulse-core
 * msg_log.rs batch_append): re-sending an already-applied batch is a no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError, SDKChatRetryError } from '../errors.js';

const MSG_A = '00000000-0000-4000-8000-00000000000a';
const MSG_B = '00000000-0000-4000-8000-00000000000b';
const ITEMS = [
  { msgId: MSG_A, sealed: new Uint8Array([1, 2, 3]).buffer },
  { msgId: MSG_B, sealed: new Uint8Array([4, 5, 6]).buffer },
];

function make(): SDKChatClient {
  return new SDKChatClient({ baseUrl: 'https://chat.example.com', jwt: 'jwt' });
}
const okRes = (): Response => ({ ok: true, status: 200, headers: new Headers() }) as unknown as Response;
const errRes = (status: number, headers: Record<string, string> = {}): Response =>
  ({ ok: false, status, headers: new Headers(headers) }) as unknown as Response;

/** A fetch that never settles on its own but honours the abort signal, like the real one. */
function hang(): (input: unknown, init?: RequestInit) => Promise<Response> {
  return (_i, init) =>
    new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true });
    });
}

const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>();
const bodies = (): string[] => fetchMock.mock.calls.map((c) => String(c[1]?.body));

describe('batchAppend() timeout + retry', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('timeout -> retry -> success, sending the identical body both times', async () => {
    fetchMock.mockImplementationOnce(hang()).mockResolvedValueOnce(okRes());
    const p = make().batchAppend('room', ITEMS);
    await vi.advanceTimersByTimeAsync(20_000); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(2_000); // backoff
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [b1, b2] = bodies();
    expect(b1).toBe(b2);
    expect(b1).toContain(MSG_A);
    expect(b1).toContain(MSG_B);
  });

  it('the per-attempt timeout is not shorter than 20 s', async () => {
    fetchMock.mockImplementation(hang());
    const p = make().batchAppend('room', ITEMS);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    // unwind so no timers leak
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p.catch(() => {});
  });

  it.each([400, 401, 403, 404, 413, 422])('HTTP %i is never retried', async (status) => {
    fetchMock.mockResolvedValue(errRes(status));
    await expect(make().batchAppend('room', ITEMS)).rejects.toSatisfy(
      (e: unknown) => e instanceof SDKChatError && !(e instanceof SDKChatRetryError) && e.statusCode === status,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('503 then 200 -> success after one retry', async () => {
    fetchMock.mockResolvedValueOnce(errRes(503)).mockResolvedValueOnce(okRes());
    const p = make().batchAppend('room', ITEMS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[0]).toBe(bodies()[1]);
  });

  it('a network error (fetch rejects) is retried', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(okRes());
    const p = make().batchAppend('room', ITEMS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 honours Retry-After (seconds): no retry before it elapses', async () => {
    fetchMock.mockResolvedValueOnce(errRes(429, { 'Retry-After': '20' })).mockResolvedValueOnce(okRes());
    const p = make().batchAppend('room', ITEMS);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // backoff alone would have retried by ~1.2 s
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts with a typed SDKChatRetryError carrying the last failure', async () => {
    fetchMock.mockResolvedValue(errRes(503));
    const p = make().batchAppend('room', ITEMS);
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof SDKChatRetryError &&
        e instanceof SDKChatError &&
        e.code === 'server_error' &&
        e.statusCode === 503 &&
        e.attempts === 4
      );
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('exhausted timeouts surface as code network', async () => {
    fetchMock.mockImplementation(hang());
    const p = make().batchAppend('room', ITEMS, { maxAttempts: 2, timeoutMs: 1_000 });
    const assertion = expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof SDKChatRetryError && e.code === 'network' && e.attempts === 2,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('maxAttempts: 1 disables retry', async () => {
    fetchMock.mockResolvedValue(errRes(503));
    await expect(make().batchAppend('room', ITEMS, { maxAttempts: 1 })).rejects.toBeInstanceOf(SDKChatError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a caller abort during backoff stops retrying and rejects with the abort reason', async () => {
    fetchMock.mockResolvedValue(errRes(503));
    const ac = new AbortController();
    const p = make().batchAppend('room', ITEMS, { signal: ac.signal });
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
    await vi.advanceTimersByTimeAsync(10); // attempt 1 done, sleeping
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a caller abort mid-flight is surfaced as an abort, not retried as a timeout', async () => {
    fetchMock.mockImplementation(hang());
    const ac = new AbortController();
    const p = make().batchAppend('room', ITEMS, { signal: ac.signal });
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal sends nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(make().batchAppend('room', ITEMS, { signal: ac.signal })).rejects.toSatisfy(
      (e: unknown) => (e as Error).name === 'AbortError',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
