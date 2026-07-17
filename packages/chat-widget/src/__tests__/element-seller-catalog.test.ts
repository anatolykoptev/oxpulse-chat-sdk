/**
 * element-seller-catalog.test.ts — opt-in seller-catalog picker wiring (#196).
 *
 * Tests:
 *   1. seller-catalog ON + _createCatalogClient → product button renders in shadow DOM
 *   2. seller-catalog OFF (default) → no product button (backward compat)
 *   3. seller-catalog in OBSERVED_ATTRIBUTES
 *   4. mount() API passes the seller-catalog attribute
 *   5. _createCatalogClient receives the same jwt + baseUrl as the main SDK client
 *
 * Falsification (RED-on-revert): if element.ts stops constructing/passing
 * catalogClient to the Composer, the `if (this.#catalogClient)` gate in
 * composer.ts skips the product button → T1 asserts presence → fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement, mount } from '../element.js';
import type { MessageListClient } from '../ui/message-list.js';
import type { SDKCatalogClient } from '@oxpulse/chat-sdk';

// Helper: make a valid JWT with aud_origins matching localhost
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u1' });

/**
 * Mock SDK chat client — minimal surface for the authed (composer) path.
 */
function makeMockClient(): MessageListClient & {
  sendText(roomId: string, args: { senderUid: string; text: string }): Promise<{ msgId: string }>;
} {
  return {
    list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock-msg-id' }),
  };
}

/**
 * Mock SDK catalog client — listProducts returns an empty page so the picker
 * renders its empty state without a network call.
 */
function makeMockCatalogClient(): SDKCatalogClient {
  return {
    listProducts: vi.fn().mockResolvedValue({ products: [], hasMore: false }),
  } as unknown as SDKCatalogClient;
}

describe('OxpulseChatElement — seller-catalog picker wiring (#196)', () => {
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

  // ── T1: seller-catalog ON → product button renders ──────────────────────────

  it('sellerCatalog_on_renders_product_button_in_shadow_DOM', async () => {
    const createCatalogClient = vi.fn().mockImplementation(() => makeMockCatalogClient());

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('seller-catalog', '');
    el._setCallbacks({
      _createClient: () => makeMockClient(),
      _createCatalogClient: createCatalogClient,
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    // Composer must be mounted (authed path → effectiveSendClient !== null).
    expect(shadow!.querySelector('.oxp-composer')).not.toBeNull();
    // #196: the catalog client was constructed and passed → the product
    // button (gated on `if (this.#catalogClient)` in composer.ts) renders.
    const productBtn = shadow!.querySelector('.oxp-composer-product-btn');
    expect(productBtn).not.toBeNull();
    // The catalog client factory was actually called (not dead code).
    expect(createCatalogClient).toHaveBeenCalledOnce();
    el.destroy();
  });

  // ── T2: seller-catalog OFF (default) → no product button ────────────────────

  it('sellerCatalog_off_no_product_button_backward_compat', async () => {
    const createCatalogClient = vi.fn().mockImplementation(() => makeMockCatalogClient());

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    // seller-catalog NOT set — default OFF
    el._setCallbacks({
      _createClient: () => makeMockClient(),
      _createCatalogClient: createCatalogClient,
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    // Composer still mounts in authed mode.
    expect(shadow!.querySelector('.oxp-composer')).not.toBeNull();
    // No product button — catalog client never constructed.
    expect(shadow!.querySelector('.oxp-composer-product-btn')).toBeNull();
    expect(createCatalogClient).not.toHaveBeenCalled();
    el.destroy();
  });

  // ── T3: seller-catalog in OBSERVED_ATTRIBUTES ───────────────────────────────

  it('seller_catalog_is_an_observed_attribute', () => {
    expect(OxpulseChatElement.observedAttributes).toContain('seller-catalog');
  });

  // ── T4: mount() API passes the seller-catalog attribute ─────────────────────

  it('mount_passes_seller_catalog_attribute', async () => {
    const createCatalogClient = vi.fn().mockImplementation(() => makeMockCatalogClient());

    const { destroy } = mount(container, {
      appId: 'app1',
      jwt: LOCALHOST_JWT,
      roomId: 'room1',
      sellerCatalog: true,
      _createClient: () => makeMockClient(),
      _createCatalogClient: createCatalogClient,
    });

    await new Promise((r) => setTimeout(r, 60));

    const el = container.querySelector('oxpulse-chat') as OxpulseChatElement | null;
    expect(el).not.toBeNull();
    expect(el!.hasAttribute('seller-catalog')).toBe(true);
    const shadow = el!.shadowRoot;
    expect(shadow!.querySelector('.oxp-composer-product-btn')).not.toBeNull();
    destroy();
  });

  // ── T5: _createCatalogClient receives the same jwt + baseUrl as the SDK client ─

  it('createCatalogClient_receives_same_jwt_and_baseUrl_as_sdk_client', async () => {
    const capturedSdk: { jwt: string; baseUrl: string }[] = [];
    const capturedCatalog: { jwt: string; baseUrl: string }[] = [];

    const createClient = vi.fn().mockImplementation((opts: { baseUrl: string; jwt: string; appId: string }) => {
      capturedSdk.push({ jwt: opts.jwt, baseUrl: opts.baseUrl });
      return makeMockClient();
    });
    const createCatalogClient = vi.fn().mockImplementation((opts: { jwt: string; baseUrl: string }) => {
      capturedCatalog.push({ jwt: opts.jwt, baseUrl: opts.baseUrl });
      return makeMockCatalogClient();
    });

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('seller-catalog', '');
    el.setAttribute('base-url', 'https://chat.test.example');
    el._setCallbacks({
      _createClient: createClient,
      _createCatalogClient: createCatalogClient,
    });
    container.appendChild(el);

    await new Promise((r) => setTimeout(r, 60));

    // Both clients were constructed with the SAME jwt + baseUrl (no re-derivation).
    expect(capturedSdk.length).toBeGreaterThan(0);
    expect(capturedCatalog).toHaveLength(1);
    expect(capturedCatalog[0]!.jwt).toBe(capturedSdk[0]!.jwt);
    expect(capturedCatalog[0]!.baseUrl).toBe(capturedSdk[0]!.baseUrl);
    expect(capturedCatalog[0]!.jwt).toBe(LOCALHOST_JWT);
    expect(capturedCatalog[0]!.baseUrl).toBe('https://chat.test.example');
    el.destroy();
  });
});
