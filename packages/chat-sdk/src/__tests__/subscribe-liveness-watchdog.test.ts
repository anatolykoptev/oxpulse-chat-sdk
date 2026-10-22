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
  error(): void;
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
        error: () => {
          if (!ctl.closed) self.onerror?.(new Event('error'));
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
  let randomSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchMock.mockReset(); // drops any unconsumed mockImplementationOnce from a failed test
    fetchMock.mockImplementation(serverImpl);
    serverLog = [];
    ticketAfterSeqs.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    installES();
    // Forced reconnects add 0-1 s jitter and backoffMs adds +-20%: pin Math.random so
    // timings are deterministic; jitter tests override it.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    randomSpy.mockRestore();
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
    await vi.advanceTimersByTimeAsync(1_000);
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

  it('(10) `online` during a hung INITIAL ticket fetch yields exactly one EventSource', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    // The first-ever ticket fetch hangs (half-open link at connect time).
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { release = res; }));
    const onMessage = vi.fn();
    make().subscribe('r10', { onMessage });
    await flush();
    expect(streams).toHaveLength(0);

    win.dispatchEvent(new Event('online')); // forceReconnect -> replay -> ticket -> attach
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(streams).toHaveLength(1);

    // The original, abandoned ticket fetch now resolves: it must NOT attach a 2nd stream.
    release(ok({ ticket: 'stale', expires_at: 'x' }));
    await flush();
    expect(streams).toHaveLength(1);
    expect(streams.filter((s) => !s.closed)).toHaveLength(1);
    streams[0].emit(JSON.stringify(row(1)));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('(10b) a hung initial ticket fetch that REJECTS after `online` does not start a parallel cycle', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    let fail!: (e: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_, rej) => { fail = rej; }));
    make().subscribe('r10b', { onMessage: vi.fn() });
    await flush();
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const listsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sdk/messages?')).length;
    fail(new Error('boom'));
    await vi.advanceTimersByTimeAsync(2_000); // would fire the parallel reconnect(0) backoff
    await flush();
    const listsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sdk/messages?')).length;
    expect(listsAfter).toBe(listsBefore);
    expect(streams).toHaveLength(1);
  });

  it('(11) online / watchdog-forced reconnects are jittered over 0-1 s (no thundering herd)', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    make().subscribe('r11', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');

    randomSpy.mockReturnValue(0.9);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(streams).toHaveLength(1); // still waiting out the jitter
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(streams).toHaveLength(2);

    // Same for a watchdog-forced reconnect.
    streams[1].emitNamed('ping', '1');
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1);
    await flush();
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(streams).toHaveLength(3);
  });

  it('(12) a watchdog expiry during a reconnect() backoff does not cut the backoff short', async () => {
    make().subscribe('r12', { onMessage: vi.fn(), livenessTimeoutMs: 2_000 });
    await flush();
    streams[0].emitNamed('ping', '1');
    // From now on every ticket fetch fails: forced cycle -> reconnect(0) 0.8 s -> reconnect(1) 1.6 s ...
    fetchMock.mockImplementation(async (input, init) =>
      String(input).endsWith('/subscribe-ticket')
        ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
        : serverImpl(input, init),
    );
    const tickets = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/subscribe-ticket')).length;
    await vi.advanceTimersByTimeAsync(2_001); // watchdog -> forceReconnect at T
    await flush();
    expect(tickets()).toBe(2); // initial + forced cycle #1 (failed)
    await vi.advanceTimersByTimeAsync(800); // T+800: reconnect(0) fires -> ticket #3 fails
    await flush();
    expect(tickets()).toBe(3);
    // T+1600 .. T+2400 the 1.6 s backoff is pending; the watchdog (re-armed at T) expires at T+2000.
    await vi.advanceTimersByTimeAsync(1_300); // T+2100
    await flush();
    expect(tickets()).toBe(3); // backoff honoured, not cut by the watchdog
    await vi.advanceTimersByTimeAsync(400); // T+2500: backoff done
    await flush();
    expect(tickets()).toBe(4);
  });

  /** A fetch that never settles on its own but rejects the way a real one does when its signal aborts. */
  const hangUntilAbort = (init?: RequestInit) =>
    new Promise<Response>((_, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });

  it('(13) an abandoned cycle aborts its in-flight replay request, silently', async () => {
    const onError = vi.fn();
    make().subscribe('r13', { onMessage: vi.fn(), onError, livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    fetchMock.mockImplementationOnce((_i, init) => hangUntilAbort(init));
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1); // forced cycle #1 hangs in replay
    await flush();
    const replayCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sdk/messages?'));
    const hung = replayCalls()[0][1] as RequestInit;
    expect(hung.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1); // watchdog abandons it
    await flush();
    expect(hung.signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled(); // the abort is not a user-visible error
    expect(streams).toHaveLength(2);
  });

  it('(13b) `online` aborts a hung initial ticket request; unsubscribe aborts the live cycle', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    fetchMock.mockImplementationOnce((_i, init) => hangUntilAbort(init));
    const onError = vi.fn();
    const unsub = make().subscribe('r13b', { onMessage: vi.fn(), onError });
    await flush();
    const ticketCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/subscribe-ticket'));
    const first = ticketCalls()[0][1] as RequestInit;
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(first.signal?.aborted).toBe(true);
    expect(streams).toHaveLength(1);

    // Unsubscribe mid-cycle: a hung replay is aborted and nothing is reported or rescheduled.
    fetchMock.mockImplementationOnce((_i, init) => hangUntilAbort(init));
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const replays = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sdk/messages?'));
    const hung = replays.at(-1)![1] as RequestInit;
    unsub();
    await flush();
    expect(hung.signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(before); // no reconnect timer left behind
  });

  it('(14) a slow-but-progressing multi-page replay is not restarted by the watchdog', async () => {
    const onMessage = vi.fn();
    make().subscribe('r14', { onMessage, livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    // Each replay page takes 30 s; three pages = 90 s > the 45 s silence budget.
    const pages: Array<[number, boolean]> = [[1, true], [2, true], [3, false]];
    let page = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (!String(input).includes('/api/sdk/messages?')) return serverImpl(input, init);
      const [seq, more] = pages[Math.min(page++, pages.length - 1)];
      await new Promise((r) => setTimeout(r, 30_000));
      return ok({ items: [row(seq)], has_more: more, next_cursor: more ? seq : null });
    });
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1); // forced reconnect -> slow replay starts
    await vi.advanceTimersByTimeAsync(95_000);
    await flush();
    const replays = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sdk/messages?'));
    expect(replays).toHaveLength(3); // one pass, never restarted
    expect(onMessage.mock.calls.map((c) => (c[0] as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(streams).toHaveLength(2);
  });

  it('(15) pings are tracked per stream: a re-attached stream that never pings is not churned', async () => {
    make().subscribe('r15', { onMessage: vi.fn(), livenessTimeoutMs: THRESHOLD });
    await flush();
    streams[0].emitNamed('ping', '1');
    await vi.advanceTimersByTimeAsync(THRESHOLD + 1); // old (pinging) stream goes silent -> recycled
    await flush();
    expect(streams).toHaveLength(2);
    // Mixed-version deploy: the replacement server instance does not ping. Quiet room.
    await vi.advanceTimersByTimeAsync(THRESHOLD * 5);
    await flush();
    expect(streams).toHaveLength(2);
    expect(streams[1].closed).toBe(false);
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
