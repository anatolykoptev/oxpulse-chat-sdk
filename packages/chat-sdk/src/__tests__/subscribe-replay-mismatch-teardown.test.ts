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
 * stream (2 controllers) — enforcement a microtask late.
 *
 * Uses the shared EventSource mock + microtask flush from ./helpers.ts (no local re-copy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import {
  installMockEventSource,
  makeSpyCryptoProvider,
  flush,
  TEST_BASE_URL,
  TEST_JWT,
} from './helpers.js';

const ROOM = 'room-replay-mismatch';

describe('CR17 Item G — crypto_mode_mismatch during reconnect replay tears down immediately', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not re-attach a second stream when the replay fetch resolves a downgraded crypto_mode', async () => {
    const es = installMockEventSource();
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
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      e2ee: { provider: makeSpyCryptoProvider() },
    });
    const onError = vi.fn();
    client.subscribe(ROOM, { onMessage: vi.fn(), onError });

    // Initial subscribe settles (stream #1 attached).
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(es.getControllers().length).toBe(1);

    // Graceful shutdown → reconnectImmediate → replayMissed → crypto_mode_mismatch thrown.
    es.getControllers()[0]!.emitNamed('shutdown', '');
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    // Teardown fires inside replayMissed's catch → the reconnect returns before re-attach,
    // so no second EventSource is constructed. The mismatch is surfaced to the caller.
    expect(es.getControllers().length).toBe(1);
    expect(onError).toHaveBeenCalled();
  });
});
