/**
 * element-flush-debounce.test.ts — #263: reconnect flush debounce.
 *
 * F4 — N reconnects inside the debounce window produce ONE flushOutbox call,
 *      and a reconnect AFTER the window produces another.
 *
 * The widget drives flushOutbox on every reconnect (subscribeFn in element.ts).
 * On a flaky network N reconnects produce N flushes — N×M request amplification
 * (N pending entries × M reconnects). The debounce collapses rapid reconnects
 * into one flush.
 *
 * Mutation: remove the debounce wrapper in subscribeFn (call flushOutbox
 * directly instead of through the setTimeout debounce) → RED (flushOutbox is
 * called once per reconnect, not once per window).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement } from '../element.js';

// fetchRoster is called unconditionally on mount; jsdom has no roster server.
vi.mock('@oxpulse/chat-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxpulse/chat-sdk')>();
  return {
    ...actual,
    fetchRoster: vi.fn().mockResolvedValue(new Map()),
    onOutboxDegraded: () => () => {},
  };
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u1' });

/** Wait for the element's oxpulse-chat:ready event (fires after mount). */
function waitForReady(el: OxpulseChatElement, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oxpulse-chat:ready timed out')), timeoutMs);
    el.addEventListener('oxpulse-chat:ready', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Mock client with a flushOutbox spy and a no-op subscribe. */
function makeDebounceClient() {
  const flushOutbox = vi.fn(async () => {});
  return {
    client: {
      list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
      subscribe: vi.fn().mockImplementation(() => () => {}),
      sendText: vi.fn().mockResolvedValue({ msgId: 'mock' }),
      flushOutbox,
    },
    flushOutbox,
  };
}

describe('OxpulseChatElement — #263 reconnect flush debounce', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('F4_reconnect_debounce_collapses_rapid_reconnects_into_one_flush', async () => {
    const { client, flushOutbox } = makeDebounceClient();

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => client });
    container.appendChild(el);
    await waitForReady(el);

    // Mount calls flushOutbox once (not debounced — the mount trigger is
    // a direct call, not the reconnect trigger). Record the baseline.
    const mountCalls = flushOutbox.mock.calls.length;
    expect(mountCalls).toBeGreaterThanOrEqual(1);

    vi.useFakeTimers();

    // ── Burst 1: two rapid reconnects inside the debounce window ──

    // Trigger a reconnect → startReconnectLoop → setTimeout(0) → subscribeFn.
    el.triggerSubscribeError({ status: 503 });
    // Fire the setTimeout(0) reconnect attempt → subscribeFn called →
    // debounce timer started.
    await vi.advanceTimersByTimeAsync(0);

    // Trigger a second reconnect immediately → another subscribeFn call →
    // debounce timer cleared + restarted.
    el.triggerSubscribeError({ status: 503 });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the debounce window → one flushOutbox call.
    await vi.advanceTimersByTimeAsync(600);
    expect(flushOutbox.mock.calls.length).toBe(mountCalls + 1);

    // ── Burst 2: a reconnect AFTER the window produces another flush ──

    el.triggerSubscribeError({ status: 503 });
    await vi.advanceTimersByTimeAsync(0);

    // Before the debounce fires, flushOutbox has NOT been called yet.
    expect(flushOutbox.mock.calls.length).toBe(mountCalls + 1);

    await vi.advanceTimersByTimeAsync(600);
    // The post-window reconnect produced another flush.
    expect(flushOutbox.mock.calls.length).toBe(mountCalls + 2);

    vi.useRealTimers();
    el.destroy();
  });

  // F6 — the remount path must clear the pending debounce timer.
  //
  // `#bootstrap` cleared `#anonRenewTimer` and not `#flushDebounceTimer`, so a
  // debounced flush armed before a remount survived it and fired against the
  // OLD client and OLD roomId. Its callback then set `#flushDebounceTimer =
  // null`, clobbering the handle the NEW bootstrap had just stored, leaving the
  // new timer uncancellable. Both halves are silent in production: the stale
  // flush's rejection is swallowed by the callback's own `.catch(() => {})`.
  //
  // Mutation: element.ts `#bootstrap` — delete the
  // `if (this.#flushDebounceTimer !== null) { ... }` block added beside the
  // `#anonRenewTimer` clear → RED (the old client gets a flush it must not get).
  it('F6_remount_clears_the_pending_debounce_timer', async () => {
    const first = makeDebounceClient();
    const second = makeDebounceClient();
    let created = 0;

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({
      _createClient: () => {
        created += 1;
        return created === 1 ? first.client : second.client;
      },
    });
    container.appendChild(el);
    await waitForReady(el);

    const staleBaseline = first.flushOutbox.mock.calls.length;
    expect(staleBaseline).toBeGreaterThanOrEqual(1);

    vi.useFakeTimers();

    // Arm the debounce against the FIRST client.
    el.triggerSubscribeError({ status: 503 });
    await vi.advanceTimersByTimeAsync(0);
    // Not yet fired — the timer is pending, which is the whole premise.
    expect(first.flushOutbox.mock.calls.length).toBe(staleBaseline);

    // Remount before the window elapses.
    el.setAttribute('room-id', 'room2');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Past the window: the stale timer must NOT have fired against the old client.
    await vi.advanceTimersByTimeAsync(600);
    expect(first.flushOutbox.mock.calls.length).toBe(staleBaseline);

    vi.useRealTimers();
    el.destroy();
  });
});
