/**
 * subscribe-replay-mismatch-teardown.test.ts — CR17 Item G (#43).
 *
 * replayMissed's generic catch called only reportError on a thrown crypto_mode_mismatch;
 * teardownSubscriber was NOT called, so enforcement landed ~1 microtask late via the new
 * attach's connected handler. This tears the subscription down IMMEDIATELY when the replay
 * fetch resolves a downgraded/mismatched crypto_mode, mirroring the connected handler's
 * contract.
 *
 * Observable: with the fix, the reconnect returns before re-attaching (destroyed=true), so
 * NO second EventSource is constructed. Without it, the reconnect proceeds and opens a 2nd
 * stream (instances.length === 2) — enforcement a microtask late.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider, SealContext } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const ROOM = 'room-replay-mismatch';

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface FakeES {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, (ev: MessageEvent) => void>;
  fireShutdown(): void;
}

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
        get onmessage() {
          return self.onmessage;
        },
        get onerror() {
          return self.onerror;
        },
        get listeners() {
          return self.listeners;
        },
        fireShutdown: () => self.listeners['shutdown']?.(new Event('shutdown') as MessageEvent),
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

const passthroughProvider: CryptoProvider = {
  async seal(p: ArrayBuffer, _c: SealContext) {
    return p;
  },
  async unseal(c: ArrayBuffer, _c2: SealContext) {
    return c;
  },
};

describe('CR17 Item G — crypto_mode_mismatch during reconnect replay tears down immediately', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not re-attach a second stream when the replay fetch resolves a downgraded crypto_mode', async () => {
    const instances = installMockEventSource();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/subscribe-ticket')) {
          return new Response(JSON.stringify({ ticket: 't' }), { status: 200 });
        }
        if (url.includes('/api/sdk/messages?')) {
          // Replay page carrying a DOWNGRADED crypto_mode → mismatch vs configured 'sframe-static'.
          return new Response(
            JSON.stringify({ items: [], has_more: false, next_cursor: null, crypto_mode: 'plaintext' }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    // e2ee provider → #cryptoMode defaults to 'sframe-static'.
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider: passthroughProvider },
    });
    const onError = vi.fn();
    client.subscribe(ROOM, { onMessage: vi.fn(), onError });

    // Initial subscribe settles (stream #1 attached).
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(instances.length).toBe(1);

    // Graceful shutdown → reconnectImmediate → replayMissed → crypto_mode_mismatch thrown.
    instances[0]!.fireShutdown();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    // Teardown fires inside replayMissed's catch → the reconnect returns before re-attach,
    // so no second EventSource is constructed. The mismatch is surfaced to the caller.
    expect(instances.length).toBe(1);
    expect(onError).toHaveBeenCalled();
  });
});
