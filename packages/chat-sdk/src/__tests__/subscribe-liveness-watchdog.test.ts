/**
 * subscribe-liveness-watchdog.test.ts — a half-open SSE link (NAT drop, captive
 * Wi-Fi, mobile handover) never fires EventSource.onerror, so the stream stalls
 * silently. The server emits a named `ping` event (non-empty `data: 1`, else the
 * browser never dispatches it) every 15 s; the client forces
 * a reconnect (replay from the last seq) when nothing arrives for
 * `livenessTimeoutMs`, and promptly on `online` / `visibilitychange`.
 *
 * Gap analysis: reports/oxpulse-chat/research/messaging-gap-vs-mature-messengers-2026-10-22.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Ctl {
  url: string;
  closed: boolean;
  emit(data: string): void;
  emitNamed(type: string, data: string): void;
}
const streams: Ctl[] = [];

function installES(): void {
  streams.length = 0;
  class MockES {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    private ls = new Map<string, Array<(ev: Event) => void>>();
    constructor(url: string) {
      const self = this;
      const ctl: Ctl = {
        url,
        closed: false,
        emit: (data) => {
          if (!ctl.closed) self.onmessage?.({ data } as MessageEvent);
        },
        emitNamed: (type, data) => {
          if (ctl.closed) return;
          // HTML SSE spec "dispatch the event": an event whose data buffer is empty is
          // DISCARDED, never dispatched to listeners. (axum's `Event::data("")` writes no
          // `data:` line at all.) Mirror it so a mock can't deliver what a browser won't.
          if (data === '') return;
          for (const l of self.ls.get(type) ?? []) l(Object.assign(new Event(type), { data }));
        },
      };
      streams.push(ctl);
      (this as unknown as { ctl: Ctl }).ctl = ctl;
    }
    addEventListener(t: string, l: (ev: Event) => void) {
      if (!this.ls.has(t)) this.ls.set(t, []);
      this.ls.get(t)!.push(l);
    }
    removeEventListener() {}
    close() {
      (this as unknown as { ctl: Ctl }).ctl.closed = true;
    }
  }
  vi.stubGlobal('EventSource', MockES);
}

function row(seq: number) {
  return {
    seq,
    msg_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    sender_uid: 'alice',
    sealed_b64: btoa('x'),
    created_at: '2026-05-13T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  };
}

/** Fake server: a message log, a ticket endpoint, and a list endpoint honouring after_seq. */
let serverLog: number[] = [];
const ticketAfterSeqs: number[] = [];
/** Plain Response stand-in: a real Response body settles on I/O ticks that fake timers freeze. */
function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
const serverImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/subscribe-ticket')) {
    const body = JSON.parse(String(init?.body)) as { after_seq: number };
    ticketAfterSeqs.push(body.after_seq);
    return ok({ ticket: 't', expires_at: 'x' });
  }
  const after = Number(new URL(url).searchParams.get('after_seq'));
  const items = serverLog.filter((s) => s > after).map(row);
  return ok({ items, has_more: false, next_cursor: null });
};
const fetchMock = vi.fn<typeof fetch>();

const THRESHOLD = 45_000;

/** Every subscription is torn down in afterEach so a failing test cannot leak timers into the next. */
const unsubs: Array<() => void> = [];
function make(): SDKChatClient {
  const client = new SDKChatClient({ jwt: 'j', baseUrl: 'https://example.com' });
  const sub = client.subscribe.bind(client);
  client.subscribe = (roomId, args) => {
    const u = sub(roomId, args);
    unsubs.push(u);
    return u;
  };
  return client;
}

describe('subscribe() liveness watchdog', () => {
  beforeEach(() => {
    fetchMock.mockReset(); // drops any unconsumed mockImplementationOnce from a failed test
    fetchMock.mockImplementation(serverImpl);
    serverLog = [];
    ticketAfterSeqs.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    installES();
  });
  afterEach(() => {
    for (const u of unsubs.splice(0)) u();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('(1) silence past the threshold forces a reconnect that resumes after the last seq', async () => {
    const onMessage = vi.fn();
    make().subscribe('r1', { onMessage, livenessTimeoutMs: THRESHOLD });
    await flush();
    expect(streams).toHaveLength(1);

    streams[0].emit(JSON.stringify(row(3)));
    streams[0].emitNamed('ping', '1');
    serverLog = [3, 4]; // seq 4 landed while the link was half-open

    await vi.advanceTimersByTimeAsync(THRESHOLD + 1);
    await flush();

    expect(streams[0].closed).toBe(true);
    expect(streams).toHaveLength(2);
    // Replay delivered the missed row; the new ticket resumes AFTER it.
    expect(onMessage.mock.calls.map((c) => (c[0] as { seq: number }).seq)).toEqual([3, 4]);
    expect(ticketAfterSeqs.at(-1)).toBe(4);
    expect(streams[1].url).toContain('after_seq=4');
  });

  it('(2) keep-alive pings arriving in time never trigger a reconnect', async () => {
    make().subscribe('r2', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      streams[0].emitNamed('ping', '1');
    }
    await flush();
    expect(streams).toHaveLength(1);
    expect(streams[0].closed).toBe(false);
  });

  it('(3) no message is delivered twice across the forced reconnect', async () => {
    const onMessage = vi.fn();
    make().subscribe('r3', { onMessage, livenessTimeoutMs: THRESHOLD });
    await flush();
    serverLog = [1, 2, 3];
    for (const s of [1, 2, 3]) streams[0].emit(JSON.stringify(row(s)));
    streams[0].emitNamed('ping', '1');

    await vi.advanceTimersByTimeAsync(THRESHOLD + 1);
    await flush();
    // The dead stream is closed: a late frame on it must not be delivered.
    streams[0].emit(JSON.stringify(row(3)));
    streams[1].emit(JSON.stringify(row(4)));

    const seqs = onMessage.mock.calls.map((c) => (c[0] as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('(4) a hung replay fetch during the forced reconnect is itself recovered, with one live stream', async () => {
    const onMessage = vi.fn();
    make().subscribe('r4', { onMessage, livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    serverLog = [1];

    // First replay list hangs (half-open link: the fetch never settles).
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((res) => { release = res; }),
    );
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1);
    await flush();
    expect(streams).toHaveLength(1); // stuck in the hung replay

    await vi.advanceTimersByTimeAsync(THRESHOLD + 1); // watchdog restarts the cycle
    await flush();
    expect(streams).toHaveLength(2);

    // The abandoned replay finally resolves: it must not deliver or attach.
    release(ok({ items: [row(1)], has_more: false, next_cursor: null }));
    await flush();
    expect(streams).toHaveLength(2);
    expect(onMessage.mock.calls.map((c) => (c[0] as { seq: number }).seq)).toEqual([1]);
  });

  it('(5) a server that never pings is left alone (watchdog arms only once a ping is seen)', async () => {
    make().subscribe('r5', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emit(JSON.stringify(row(1)));
    await vi.advanceTimersByTimeAsync(THRESHOLD * 4);
    await flush();
    expect(streams).toHaveLength(1);
  });

  it('(6) `online` reconnects promptly, resuming after the last seq', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    const onMessage = vi.fn();
    make().subscribe('r6', { onMessage });
    await flush();
    streams[0].emit(JSON.stringify(row(7)));
    serverLog = [7, 8];

    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    expect(streams).toHaveLength(2);
    expect(streams[0].closed).toBe(true);
    expect(onMessage.mock.calls.map((c) => (c[0] as { seq: number }).seq)).toEqual([7, 8]);
  });

  it('(7) tab becoming visible reconnects only when the stream is stale', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    vi.stubGlobal('document', doc);
    make().subscribe('r7', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');

    // Fresh stream: becoming visible is a no-op.
    await vi.advanceTimersByTimeAsync(10_000);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(streams).toHaveLength(1);

    // Stale: timers frozen in the background (as on mobile), then visible.
    vi.setSystemTime(Date.now() + THRESHOLD + 5_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(streams).toHaveLength(2);
  });

  it('(8) onConnectionState reports connecting -> connected -> reconnecting -> connected', async () => {
    const states: string[] = [];
    make().subscribe('r8', {
      onMessage: vi.fn(),
      livenessTimeoutMs: THRESHOLD,
      onConnectionState: (s) => states.push(s),
    });
    expect(states).toEqual(['connecting']);
    await flush();
    streams[0].emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    streams[0].emitNamed('ping', '1');
    expect(states.at(-1)).toBe('connected');

    await vi.advanceTimersByTimeAsync(THRESHOLD + 1);
    expect(states.at(-1)).toBe('reconnecting');
    await flush();
    streams[1].emitNamed('ping', '1');
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('teardown clears the watchdog (no reconnect after unsubscribe)', async () => {
    const unsub = make().subscribe('r9', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    unsub();
    await vi.advanceTimersByTimeAsync(THRESHOLD * 3);
    await flush();
    expect(streams).toHaveLength(1);
  });
});
