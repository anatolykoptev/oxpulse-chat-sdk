/**
 * element-anon-read.test.ts — anon-read mode tests for OxpulseChatElement.
 *
 * Tests:
 *   1. anon mode: allow-anon-read + no jwt → calls injected _mintAnonReadToken
 *   2. anon mode: client constructed with minted token
 *   3. anon mode: composer NOT rendered (read-only UX)
 *   4. authed mode: jwt present → composer rendered, mint NOT called
 *   5. anon mode: mint failure → oxpulse-chat:error dispatched, onError called
 *   6. neither jwt nor allow-anon-read → no bootstrap (null config)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement, mount } from '../element.js';
import type { MessageListClient } from '../ui/message-list.js';
import type { WidgetConfig } from '../types.js';
import { AnonReadMintError } from '@oxpulse/chat-sdk';

// Helper: make a valid JWT with aud_origins matching localhost
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u1' });
const ANON_TOKEN = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'anon-001', anon: true });

const DEFAULT_MINT_RESULT = {
  token: ANON_TOKEN,
  userId: 'anon-uid-001',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

/**
 * Mock client factory — duck-typed MessageListClient + sendText.
 * Inject via _createClient to avoid real network in jsdom.
 */
function makeMockClient(opts?: { captureOpts?: (o: { baseUrl: string; jwt: string; appId: string }) => void }): MessageListClient & {
  sendText(roomId: string, text: string, _args?: unknown): Promise<{ msgId: string }>;
} {
  return {
    list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock-msg-id' }),
    ...(opts?.captureOpts ? {} : {}),
  };
}

describe('OxpulseChatElement — anon-read mode', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.clearAllMocks();
  });

  it('anon mode: calls _mintAnonReadToken when allow-anon-read set and no jwt', async () => {
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el._setCallbacks({
      _mintAnonReadToken: mintFn,
      _createClient: () => makeMockClient(),
    });
    container.appendChild(el);

    // Wait for async bootstrap (origin check + mint + client construction)
    await new Promise((r) => setTimeout(r, 50));

    expect(mintFn).toHaveBeenCalledOnce();
    expect(mintFn).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app1', roomId: 'room1' }),
    );
  });

  it('anon mode: constructs client with minted token', async () => {
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);
    const capturedOpts: Array<{ baseUrl: string; jwt: string; appId: string }> = [];
    const createClient = vi.fn().mockImplementation((opts: { baseUrl: string; jwt: string; appId: string }) => {
      capturedOpts.push(opts);
      return makeMockClient();
    });

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el._setCallbacks({ _mintAnonReadToken: mintFn, _createClient: createClient });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    expect(createClient).toHaveBeenCalledOnce();
    expect(capturedOpts[0]?.jwt).toBe(ANON_TOKEN);
    expect(capturedOpts[0]?.appId).toBe('app1');
  });

  it('anon mode: composer NOT rendered in shadow DOM', async () => {
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el._setCallbacks({
      _mintAnonReadToken: mintFn,
      _createClient: () => makeMockClient(),
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    // Composer renders an element with class oxp-composer
    const composerEl = shadow!.querySelector('.oxp-composer');
    expect(composerEl).toBeNull();
  });

  it('authed mode: jwt present → composer rendered, mint NOT called', async () => {
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    // allow-anon-read is NOT set — normal authed path
    el._setCallbacks({
      _mintAnonReadToken: mintFn,
      _createClient: () => makeMockClient(),
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    // Mint must NOT be called when jwt is provided
    expect(mintFn).not.toHaveBeenCalled();

    // Composer should be present
    const shadow = el.shadowRoot;
    const composerEl = shadow!.querySelector('.oxp-composer');
    expect(composerEl).not.toBeNull();
  });

  it('anon mode: mint failure → oxpulse-chat:error dispatched + onError called', async () => {
    const mintError = new AnonReadMintError('not_anon_readable', 'room not anon readable', 403);
    const mintFn = vi.fn().mockRejectedValue(mintError);
    const onError = vi.fn();

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el._setCallbacks({
      _mintAnonReadToken: mintFn,
      _createClient: () => makeMockClient(),
      onError,
    });

    const errorPromise = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('oxpulse-chat:error', (ev) => resolve(ev as CustomEvent));
    });

    container.appendChild(el);
    const evt = await errorPromise;

    expect(evt.detail).toBeTruthy();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('neither jwt nor allow-anon-read → no client construction', async () => {
    const mintFn = vi.fn();
    const createClient = vi.fn().mockImplementation(() => makeMockClient());

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    // No jwt, no allow-anon-read → #resolveConfig returns null → no bootstrap
    el._setCallbacks({ _mintAnonReadToken: mintFn, _createClient: createClient });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    expect(mintFn).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('allow-anon-read + jwt present → authed path (jwt wins), mint not called', async () => {
    // When both are set, the jwt takes precedence (allowAnonRead=true but jwt is set → not anon mode)
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);
    const capturedOpts: Array<{ jwt: string }> = [];
    const createClient = vi.fn().mockImplementation((opts: { jwt: string }) => {
      capturedOpts.push(opts);
      return makeMockClient();
    });

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', ''); // set but jwt present
    el._setCallbacks({ _mintAnonReadToken: mintFn, _createClient: createClient });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    // With jwt present, anon mode is not triggered
    expect(mintFn).not.toHaveBeenCalled();
    // The authed path MUST construct the client — asserted so the jwt check below
    // cannot pass vacuously if a regression silently no-ops the authed path.
    expect(createClient).toHaveBeenCalledOnce();
    expect(capturedOpts[0]?.jwt).toBe(LOCALHOST_JWT);
  });
});

// ── mount() API — anon-read mode ─────────────────────────────────────────────

describe('mount() — anon-read mode', () => {
  let target: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (target.parentNode) target.parentNode.removeChild(target);
    vi.clearAllMocks();
  });

  it('mount with allowAnonRead=true mounts read-only widget', async () => {
    const mintFn = vi.fn().mockResolvedValue(DEFAULT_MINT_RESULT);

    const handle = mount(target, {
      appId: 'app1',
      roomId: 'room1',
      jwt: '', // empty jwt — anon mode activated by allowAnonRead
      allowAnonRead: true,
      _mintAnonReadToken: mintFn,
      _createClient: () => makeMockClient(),
    } as unknown as WidgetConfig & { allowAnonRead: boolean; _mintAnonReadToken: typeof mintFn });

    await new Promise((r) => setTimeout(r, 50));

    expect(mintFn).toHaveBeenCalledOnce();
    handle.destroy();
  });
});
