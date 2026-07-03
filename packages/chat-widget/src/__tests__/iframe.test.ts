/**
 * iframe.test.ts — in-place token-refresh receiver (W2.2 stub → live).
 *
 * The iframe entry (`initIframe`) wires its subsequent-message listener via
 * `onParentMessage`, which fail-closed gates on `event.origin === ?origin=`.
 * These tests drive the REAL wiring (dynamic import → real MessageEvent dispatch)
 * so the origin gate is exercised, not mocked:
 *   1. a `refresh-token` from the trusted parent origin applies the fresh JWT
 *      to the live iframe session IN PLACE (no re-init / no remount);
 *   2. a `refresh-token` from an UNTRUSTED origin is dropped (JWT unchanged).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const NS = 'oxpulse-chat';
// The parent page origin. In the iframe test the parent === the iframe's own
// jsdom origin (e.g. http://localhost:3000). Using it verbatim keeps both the
// origin gate (?origin=) and checkOrigin (aud_origins) matching whatever jsdom uses.
const PARENT_ORIGIN = window.location.origin;

/** Build a base64url JWT (no signature verification is done client-side). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesig`;
}

interface IframeTestHooks {
  /** @internal test hook — the JWT currently applied to the live iframe session. */
  __getLiveJwt(): string | null;
}

/** Fresh-import iframe.ts with a controlled `?origin=` parent origin. */
async function importIframeWithParentOrigin(origin: string): Promise<IframeTestHooks> {
  vi.resetModules();
  // replaceState keeps location.origin/hostname intact (so checkOrigin passes)
  // while setting location.search=?origin= (what onParentMessage reads).
  window.history.replaceState(null, '', '/?origin=' + encodeURIComponent(origin));
  const mod = await import('../iframe.js');
  return mod as unknown as IframeTestHooks;
}

function dispatch(data: unknown, origin: string): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin }));
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('iframe receiver — refresh-token applies fresh JWT in place (origin-gated)', () => {
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    parentPostMessage = vi.fn();
    Object.defineProperty(globalThis, 'parent', {
      value: { postMessage: parentPostMessage },
      writable: true,
      configurable: true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('applies a trusted refresh-token in place and drops an untrusted one, no remount', async () => {
    const hooks = await importIframeWithParentOrigin(PARENT_ORIGIN);

    const oldJwt = makeJwt({ aud_origins: [PARENT_ORIGIN], sub: 'u1' });
    // 1) init from the trusted parent origin
    dispatch(
      { ns: NS, type: 'init', config: { appId: 'a', jwt: oldJwt, roomId: 'r', mode: 'iframe' } },
      PARENT_ORIGIN,
    );
    await flush();

    const readyCount = (): number =>
      parentPostMessage.mock.calls.filter(
        ([m]) => (m as { type?: string }).type === 'ready',
      ).length;

    // init established the live session JWT and reported ready exactly once.
    expect(hooks.__getLiveJwt()).toBe(oldJwt);
    expect(readyCount()).toBe(1);

    // 2) refresh-token from the TRUSTED origin → applied in place, no re-init.
    const newJwt = makeJwt({ aud_origins: [PARENT_ORIGIN], sub: 'u2' });
    dispatch({ ns: NS, type: 'refresh-token', jwt: newJwt }, PARENT_ORIGIN);
    await flush();
    expect(hooks.__getLiveJwt()).toBe(newJwt);
    expect(readyCount()).toBe(1); // no remount — the iframe did not re-init

    // 3) refresh-token from an UNTRUSTED origin → dropped, JWT unchanged.
    const evilJwt = makeJwt({ aud_origins: ['https://attacker.com'], sub: 'evil' });
    dispatch({ ns: NS, type: 'refresh-token', jwt: evilJwt }, 'https://attacker.com');
    await flush();
    expect(hooks.__getLiveJwt()).toBe(newJwt); // still the trusted refresh, not evil
  });
});
