/**
 * replay-cursor-monotonic.test.ts — pr-review-council MED-1.
 *
 * replayMissed()'s `while (true)` pagination loop (client.ts subscribe() reconnect
 * path) trusted the server's `next_cursor` to strictly advance on every
 * `has_more: true` page. The server is UNTRUSTED under the E2EE threat model
 * (SEC-CR conventions throughout this file) — a malicious/buggy server replying
 * `has_more: true` with a `next_cursor` that does not advance past the current
 * cursor would spin the loop forever (same page re-fetched indefinitely).
 *
 * Verifies:
 *   - happy path: an advancing cursor across multiple pages delivers every row,
 *     in order, and the loop terminates.
 *   - malicious path: a non-advancing `next_cursor` on a `has_more: true` page
 *     is rejected with a bounded number of fetches (the guard fires on the
 *     FIRST offending page, not after N retries) and surfaces via onError as
 *     the guard's own SDKChatError — not a hang, not the test's safety-valve
 *     error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import { installMockEventSource, flush, TEST_BASE_URL, TEST_JWT } from './helpers.js';

const ROOM = 'room-replay-cursor';

function makeServerRow(seq: number) {
  return {
    seq,
    msg_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    sender_uid: 'alice',
    sealed_b64: btoa(String.fromCharCode(1, 2, 3)),
    created_at: '2026-05-13T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  };
}

function ticketResponse(ticket: string) {
  return new Response(
    JSON.stringify({ ticket, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    { status: 200 },
  );
}

function messagesPage(
  items: unknown[],
  opts: { hasMore: boolean; nextCursor: number | null },
) {
  return new Response(
    JSON.stringify({ items, has_more: opts.hasMore, next_cursor: opts.nextCursor }),
    { status: 200 },
  );
}

describe('replayMissed() cursor-monotonicity guard (pr-review-council MED-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delivers all rows across multiple advancing-cursor pages, in order, and terminates', async () => {
    const es = installMockEventSource();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(ticketResponse('ticket-1'));

    const onMessage = vi.fn();
    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT });
    client.subscribe(ROOM, { onMessage });
    await flush();
    expect(es.getControllers().length).toBe(1);

    // Reconnect replay: page 1 (seq 1,2) advances cursor 0 -> 2, page 2 (seq 3)
    // terminates with has_more=false. Then a fresh ticket for re-attach.
    fetchMock.mockResolvedValueOnce(
      messagesPage([makeServerRow(1), makeServerRow(2)], { hasMore: true, nextCursor: 2 }),
    );
    fetchMock.mockResolvedValueOnce(
      messagesPage([makeServerRow(3)], { hasMore: false, nextCursor: null }),
    );
    fetchMock.mockResolvedValueOnce(ticketResponse('ticket-2'));

    es.getControllers()[0]!.emitError();
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(3);
    expect((onMessage.mock.calls[0] as [{ seq: number }])[0].seq).toBe(1);
    expect((onMessage.mock.calls[1] as [{ seq: number }])[0].seq).toBe(2);
    expect((onMessage.mock.calls[2] as [{ seq: number }])[0].seq).toBe(3);
    // Loop terminated cleanly and re-attached: a second EventSource opened.
    expect(es.getControllers().length).toBe(2);
  });

  it('rejects a non-monotonic (stalled) pagination cursor from a malicious/buggy server without spinning', async () => {
    const es = installMockEventSource();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(ticketResponse('ticket-1'));

    const onMessage = vi.fn();
    const onError = vi.fn();
    const client = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT });
    client.subscribe(ROOM, { onMessage, onError });
    await flush();
    expect(es.getControllers().length).toBe(1);

    // MALICIOUS: has_more=true forever, next_cursor stuck at 0 (== the initial
    // cursor, lastSeq=0) — never advances. Without the guard this spins
    // #fetchRows indefinitely. A safety valve throws a DISTINCT error past a
    // handful of calls so a regression fails loud instead of hanging the run;
    // the assertion below proves the guard's error fires on call #1, never
    // reaching the safety valve.
    let messagesCallCount = 0;
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/sdk/messages?')) {
        messagesCallCount++;
        if (messagesCallCount > 3) {
          throw new Error('TEST SAFETY VALVE: replayMissed did not terminate (spinning)');
        }
        return messagesPage([], { hasMore: true, nextCursor: 0 });
      }
      if (url.includes('/subscribe-ticket')) {
        return ticketResponse('ticket-2');
      }
      return new Response('{}', { status: 200 });
    });

    es.getControllers()[0]!.emitError();
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    // Bounded: the guard fires on the FIRST offending page, not after retries.
    expect(messagesCallCount).toBe(1);
    expect(onMessage).not.toHaveBeenCalled();

    expect(onError).toHaveBeenCalledTimes(1);
    const err = (onError.mock.calls[0] as [SDKChatError])[0];
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err.code).toBe('server_error');
    expect(err.message).toMatch(/non-monotonic/i);
    expect(err.message).not.toMatch(/TEST SAFETY VALVE/);
  });
});
