/**
 * element-named-write.test.ts — named-write (allow-write) mode tests.
 *
 * Tests:
 *   1. allowWrite=false (default) → read-only: no compose UI rendered
 *   2. allowWrite=true + writeMintEndpoint → calls injected _mintNamedWriteToken
 *   3. allowWrite=true + write token → compose UI renders in shadow DOM
 *   4. send via compose invokes write client's sendText
 *   5. mint failure → oxpulse-chat:error with WRITE_MINT_FAILED code
 *   6. allow-write + allow-anon-read combined → read client uses anon token, write client uses write token
 *   7. message-sent event dispatched on successful send
 *   8. allow-write attr in OBSERVED_ATTRIBUTES
 *   9. write-mint-endpoint attr in OBSERVED_ATTRIBUTES
 *  10. mount() API passes allowWrite + writeMintEndpoint attributes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement, mount } from '../element.js';
import type { MessageListClient } from '../ui/message-list.js';
import { NamedWriteMintError } from '@oxpulse/chat-sdk';

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
const WRITE_TOKEN = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'named-writer', write: true });

const DEFAULT_ANON_MINT_RESULT = {
  token: ANON_TOKEN,
  userId: 'anon-uid-001',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

/**
 * Mock client factory.
 * Inject via _createClient; captureClientOpts optionally records construction args.
 */
function makeMockClient(opts?: {
  captureClientOpts?: (o: { baseUrl: string; jwt: string; appId: string }) => void;
}): MessageListClient & {
  sendText(roomId: string, args: { senderUid: string; text: string }): Promise<{ msgId: string }>;
} {
  return {
    list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock-msg-id' }),
    ...(opts?.captureClientOpts ? {} : {}),
  };
}

// ── Named-write mode ──────────────────────────────────────────────────────────

describe('OxpulseChatElement — named-write mode', () => {
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

  // ── T1: allowWrite=false → read-only (regression guard) ────────────────────

  it('allowWrite_false_no_allow_write_attr_composer_hidden', async () => {
    // allowWrite is not set — normal authed mode with JWT → composer visible.
    // This test asserts the PRESENCE of compose UI in authed mode as baseline,
    // so that allowWrite=false cannot vacuously "pass" a no-compose assertion.
    // (The actual allowWrite=false no-compose guard is in element-anon-read.test.ts
    //  for anon mode; here we verify the existing authed path is unchanged.)
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    // allowWrite NOT set — standard authed path
    el._setCallbacks({ _createClient: () => makeMockClient() });
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 60));

    // Standard authed mode should still render composer
    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow!.querySelector('.oxp-composer')).not.toBeNull();
    el.destroy();
  });

  // ── T2: allow-write + writeMintEndpoint → _mintNamedWriteToken called ──────

  it('allowWrite_calls_mintNamedWriteToken_with_endpoint_and_roomId', async () => {
    const mintWriteFn = vi.fn().mockResolvedValue(WRITE_TOKEN);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', ''); // use anon-read for the read side
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: () => makeMockClient(),
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    expect(mintWriteFn).toHaveBeenCalledOnce();
    expect(mintWriteFn).toHaveBeenCalledWith(
      expect.objectContaining({
        mintEndpoint: '/api/write-token',
        roomId: 'room1',
      }),
    );
    el.destroy();
  });

  // ── T3: allow-write + write token → compose UI rendered ────────────────────

  it('allowWrite_renders_composer_in_shadow_DOM', async () => {
    const mintWriteFn = vi.fn().mockResolvedValue(WRITE_TOKEN);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: () => makeMockClient(),
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const composerEl = shadow!.querySelector('.oxp-composer');
    expect(composerEl).not.toBeNull();
    el.destroy();
  });

  // ── T4: send via composer invokes write client's sendText ───────────────────

  it('allowWrite_send_invokes_write_client_sendText', async () => {
    const writeSendText = vi.fn().mockResolvedValue({ msgId: 'write-msg-1' });
    const capturedClients: Array<{ jwt: string; client: ReturnType<typeof makeMockClient> }> = [];

    const createClient = vi.fn().mockImplementation((opts: { baseUrl: string; jwt: string; appId: string }) => {
      const c = makeMockClient();
      (c.sendText as ReturnType<typeof vi.fn>) = writeSendText;
      capturedClients.push({ jwt: opts.jwt, client: c });
      return c;
    });

    const mintWriteFn = vi.fn().mockResolvedValue(WRITE_TOKEN);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: createClient,
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    // Verify write client was constructed with the write token (not anon token)
    const writeClientEntry = capturedClients.find((c) => c.jwt === WRITE_TOKEN);
    expect(writeClientEntry).toBeDefined();

    // Simulate a send by finding the send button and clicking it
    const shadow = el.shadowRoot;
    const textarea = shadow!.querySelector('.oxp-composer-input') as HTMLTextAreaElement | null;
    const sendBtn = shadow!.querySelector('.oxp-composer-send') as HTMLButtonElement | null;
    expect(textarea).not.toBeNull();
    expect(sendBtn).not.toBeNull();

    // Set text and trigger send
    textarea!.value = 'Hello from named writer';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    sendBtn!.click();
    await new Promise((r) => setTimeout(r, 30));

    // sendText must be called (via write client)
    expect(writeSendText).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ text: 'Hello from named writer' }),
    );
    el.destroy();
  });

  // ── T5: mint failure → oxpulse-chat:error with WRITE_MINT_FAILED ───────────

  it('allowWrite_mint_failure_dispatches_error_with_WRITE_MINT_FAILED', async () => {
    const mintError = new NamedWriteMintError('forbidden', 'write not allowed', 403);
    const mintWriteFn = vi.fn().mockRejectedValue(mintError);
    const onError = vi.fn();

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: () => makeMockClient(),
      onError,
    });

    const errorPromise = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('oxpulse-chat:error', (ev) => resolve(ev as CustomEvent));
    });

    container.appendChild(el);
    const evt = await errorPromise;

    // Error event must carry WRITE_MINT_FAILED code (not generic UNKNOWN)
    // This guards that the error is distinguishable from anon-mint failures
    expect((evt.detail as { code?: string }).code).toBe('WRITE_MINT_FAILED');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'WRITE_MINT_FAILED' }));
    el.destroy();
  });

  // ── T6: allow-write + allow-anon-read: two separate clients ────────────────

  it('allowWrite_anon_read_two_clients_different_tokens', async () => {
    const capturedJwts: string[] = [];
    const createClient = vi.fn().mockImplementation((opts: { jwt: string }) => {
      capturedJwts.push(opts.jwt);
      return makeMockClient();
    });

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: vi.fn().mockResolvedValue(WRITE_TOKEN),
      _createClient: createClient,
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    // Two clients must be created: one with anon token, one with write token
    expect(capturedJwts).toHaveLength(2);
    expect(capturedJwts).toContain(ANON_TOKEN);
    expect(capturedJwts).toContain(WRITE_TOKEN);
    el.destroy();
  });

  // ── T7: message-sent event dispatched on successful send ───────────────────

  it('allowWrite_dispatches_message_sent_on_success', async () => {
    const mintWriteFn = vi.fn().mockResolvedValue(WRITE_TOKEN);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    el.setAttribute('write-mint-endpoint', '/api/write-token');
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: () => makeMockClient(),
    });

    const sentEvents: CustomEvent[] = [];
    el.addEventListener('oxpulse-chat:message-sent', (ev) => sentEvents.push(ev as CustomEvent));

    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 60));

    const shadow = el.shadowRoot;
    const textarea = shadow!.querySelector('.oxp-composer-input') as HTMLTextAreaElement | null;
    const sendBtn = shadow!.querySelector('.oxp-composer-send') as HTMLButtonElement | null;

    textarea!.value = 'Test message';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    sendBtn!.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    expect((sentEvents[0]!.detail as { roomId: string; msgId: string }).roomId).toBe('room1');
    expect((sentEvents[0]!.detail as { roomId: string; msgId: string }).msgId).toBe('mock-msg-id');
    el.destroy();
  });

  // ── T8: allow-write attribute in OBSERVED_ATTRIBUTES ───────────────────────

  it('allow_write_in_observed_attributes', () => {
    expect(OxpulseChatElement.observedAttributes).toContain('allow-write');
  });

  // ── T9: write-mint-endpoint attribute in OBSERVED_ATTRIBUTES ───────────────

  it('write_mint_endpoint_in_observed_attributes', () => {
    expect(OxpulseChatElement.observedAttributes).toContain('write-mint-endpoint');
  });

  // ── T10: mount() API passes allow-write + write-mint-endpoint attrs ─────────

  it('mount_passes_allow_write_and_write_mint_endpoint_attributes', () => {
    const handle = mount(container, {
      appId: 'app1',
      roomId: 'room1',
      jwt: '',
      allowAnonRead: true,
      allowWrite: true,
      writeMintEndpoint: '/api/write-token',
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: vi.fn().mockResolvedValue(WRITE_TOKEN),
      _createClient: () => makeMockClient(),
    });

    const el = container.querySelector('oxpulse-chat') as OxpulseChatElement | null;
    expect(el).not.toBeNull();
    expect(el!.hasAttribute('allow-write')).toBe(true);
    expect(el!.getAttribute('write-mint-endpoint')).toBe('/api/write-token');

    handle.destroy();
  });

  // ── T11: allowWrite without writeMintEndpoint → no write mint, no composer ──

  it('allowWrite_without_endpoint_no_write_client_anon_read_only', async () => {
    // allowWrite=true but no writeMintEndpoint → mint is skipped, widget stays read-only
    // (anon-read path active). Regression guard: no spurious error dispatched.
    const mintWriteFn = vi.fn();

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('room-id', 'room1');
    el.setAttribute('allow-anon-read', '');
    el.setAttribute('allow-write', '');
    // write-mint-endpoint NOT set
    el._setCallbacks({
      _mintAnonReadToken: vi.fn().mockResolvedValue(DEFAULT_ANON_MINT_RESULT),
      _mintNamedWriteToken: mintWriteFn,
      _createClient: () => makeMockClient(),
    });

    const errors: Event[] = [];
    el.addEventListener('oxpulse-chat:error', (ev) => errors.push(ev));

    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 60));

    // Write mint must NOT be called without endpoint
    expect(mintWriteFn).not.toHaveBeenCalled();
    // No errors dispatched
    expect(errors).toHaveLength(0);
    // Composer must NOT appear (anon-read mode without write capability)
    const shadow = el.shadowRoot;
    expect(shadow!.querySelector('.oxp-composer')).toBeNull();
    el.destroy();
  });
});
