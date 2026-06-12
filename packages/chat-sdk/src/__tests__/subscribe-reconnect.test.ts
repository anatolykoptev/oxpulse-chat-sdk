/**
 * subscribe-reconnect.test.ts — SDKChatClient.subscribe() reconnect + replay (W7 / v1.0.0).
 *
 * Ported from web/src/lib/api/sdkChat.test.ts tests #7 and #8.
 * SDK subscribe() has reconnect-with-backoff and list()-replay; these behaviors
 * must be covered in the canonical SDK test suite.
 *
 * Notable difference from mirror tests:
 *   - SDK SubscribeArgs has no fromSeq or onReconnect — internal plumbing only.
 *   - Reconnect is verified via EventSource constructor call count.
 *   - Replay is verified via onMessage call count + delivered seq.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface MockESController {
  emit(data: string): void;
  emitError(): void;
  emitNamed(type: string, data: string): void;
}

let esConstructorCallCount = 0;

function installMockEventSource(): { getLastController: () => MockESController | null } {
  let lastController: MockESController | null = null;
  esConstructorCallCount = 0;

  class MockES {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    private _closed = false;
    private _listeners: Map<string, Array<(ev: Event) => void>> = new Map();

    get readyState() { return this._closed ? 2 : 1; }

    constructor(_url: string) {
      esConstructorCallCount++;
      const self = this;
      const ctrl: MockESController = {
        emit: (data: string) => { self.onmessage?.({ data } as MessageEvent); },
        emitError: () => { self.onerror?.(new Event('error')); },
        emitNamed: (type: string, data: string) => {
          const listeners = self._listeners.get(type);
          if (listeners) {
            const ev = Object.assign(new Event(type), { data }) as MessageEvent;
            for (const l of listeners) l(ev);
          }
        },
      };
      lastController = ctrl;
    }

    addEventListener(type: string, listener: (ev: Event) => void) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(listener);
    }

    removeEventListener(type: string, listener: (ev: Event) => void) {
      const ls = this._listeners.get(type);
      if (ls) { const i = ls.indexOf(listener); if (i !== -1) ls.splice(i, 1); }
    }

    close() { this._closed = true; }
  }

  vi.stubGlobal('EventSource', MockES);
  return { getLastController: () => lastController };
}

function mockTicketResponse(fetchMock: ReturnType<typeof vi.fn>, ticket = 'test-ticket') {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ ticket, expires_at: new Date(Date.now() + 60000).toISOString() }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

function makeListResponse(items: unknown[] = []) {
  return new Response(JSON.stringify({ items, has_more: false, next_cursor: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

describe('SDKChatClient.subscribe() reconnect + replay', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Ported from sdkChat.test.ts test #7 (adapted: no onReconnect param in SDK)
  it('subscribe() opens a second EventSource after SSE error (reconnect with backoff)', async () => {
    const { getLastController } = installMockEventSource();
    const client = new SDKChatClient({ jwt: 'test-jwt', baseUrl: 'https://example.com' });

    mockTicketResponse(fetchMock, 'ticket-1');
    // list() for replay returns empty
    fetchMock.mockResolvedValue(makeListResponse([]));

    client.subscribe('room-reconnect', { onMessage: vi.fn() });

    await flushMicrotasks();
    expect(esConstructorCallCount).toBe(1);

    // Queue second ticket before triggering error
    fetchMock.mockResolvedValueOnce(makeListResponse([])); // replay list()
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ticket: 'ticket-2', expires_at: new Date(Date.now() + 60000).toISOString() }),
        { status: 200 },
      ),
    );

    getLastController()!.emitError();

    // Advance past max jittered backoff (1s × 1.2 + margin = 1500ms)
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    // EventSource was constructed a second time after reconnect
    expect(esConstructorCallCount).toBe(2);
  });

  // MAJOR #5: graceful shutdown event — immediate reconnect-with-replay, no backoff delay.
  // RED: fails until client.ts adds addEventListener('shutdown', ...) handler.
  it('subscribe() reconnects immediately (no backoff) on server shutdown event', async () => {
    const { getLastController } = installMockEventSource();
    const client = new SDKChatClient({ jwt: 'test-jwt', baseUrl: 'https://example.com' });

    mockTicketResponse(fetchMock, 'ticket-1');
    fetchMock.mockResolvedValue(makeListResponse([]));

    const onMessage = vi.fn();
    client.subscribe('room-shutdown', { onMessage });
    await flushMicrotasks();
    expect(esConstructorCallCount).toBe(1);

    // Deliver seq=3 live so lastSeq advances.
    getLastController()!.emit(JSON.stringify(makeServerRow(3)));
    expect(onMessage).toHaveBeenCalledTimes(1);

    // Queue replay (seq=4 arrived while disconnected) + new ticket.
    fetchMock.mockResolvedValueOnce(makeListResponse([makeServerRow(4)]));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ticket: 'ticket-2', expires_at: new Date(Date.now() + 60000).toISOString() }),
        { status: 200 },
      ),
    );

    // Server emits graceful shutdown event (stream.rs Phase-2 emit).
    getLastController()!.emitNamed('shutdown', 'server_restart');

    // MAJOR #5 contract: client must reconnect within 50ms (no backoff, not 800-1200ms).
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks(20);

    // EventSource opened a second time — reconnect happened.
    expect(esConstructorCallCount).toBe(2);
    // Replay delivered seq=4.
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[1] as [{ seq: number }])[0].seq).toBe(4);
  });

  // Ported from sdkChat.test.ts test #8 (adapted: no fromSeq param in SDK public API)
  it('subscribe() replays missed messages via list() before re-attaching after reconnect', async () => {
    const { getLastController } = installMockEventSource();
    const client = new SDKChatClient({ jwt: 'test-jwt', baseUrl: 'https://example.com' });

    mockTicketResponse(fetchMock, 'ticket-init');
    fetchMock.mockResolvedValue(makeListResponse([]));

    const onMessage = vi.fn();
    client.subscribe('room-replay', { onMessage });

    await flushMicrotasks();

    // Deliver seq=5 live
    getLastController()!.emit(JSON.stringify(makeServerRow(5)));
    expect(onMessage).toHaveBeenCalledTimes(1);

    // Queue replay response with seq=6, then new ticket
    fetchMock.mockResolvedValueOnce(makeListResponse([makeServerRow(6)]));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ticket: 'ticket-reconnect', expires_at: new Date(Date.now() + 60000).toISOString() }),
        { status: 200 },
      ),
    );

    getLastController()!.emitError();
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    // The replay delivered seq=6
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[1] as [{ seq: number }])[0].seq).toBe(6);
  });
});
