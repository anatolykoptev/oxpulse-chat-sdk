/**
 * element-product-card.test.ts — #116 end-to-end product-card test.
 *
 * Mounts OxpulseChatElement with a REAL SDKChatClient (no _createClient mock)
 * + a fetch mock, calls setProductCard + sends, and asserts the outgoing
 * POST /api/sdk/messages body carries product_ref + product_meta — spanning
 * element.ts composerClient adapter → SDK sendText → wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement } from '../element.js';

// Helper: make a valid JWT with aud_origins matching localhost
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u1' });

const BASE_URL = 'https://chat.example.com';

/** No-op EventSource stub — subscribe() opens one but we don't need live SSE. */
class MockEventSource {
  url: string;
  closed = false;
  constructor(url: string) { this.url = url; }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.closed = true; }
}

describe('OxpulseChatElement — product-card end-to-end (#116)', () => {
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  it('setProductCard + send → POST body carries product_ref + product_meta through real adapter → SDK → wire', async () => {
    const postBodies: Array<{ url: string; body: string }> = [];

    const fetchMock = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);

      // GET /api/sdk/messages?... — initial list (empty, plaintext mode)
      if (urlStr.startsWith(`${BASE_URL}/api/sdk/messages?`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], has_more: false, next_cursor: null, crypto_mode: 'plaintext' }),
        } as Response;
      }

      // POST /api/sdk/messages/subscribe-ticket
      if (urlStr === `${BASE_URL}/api/sdk/messages/subscribe-ticket`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ticket: 'test-ticket' }),
        } as Response;
      }

      // POST /api/sdk/messages — the actual send (capture the body)
      if (urlStr === `${BASE_URL}/api/sdk/messages` && init?.method === 'POST') {
        const bodyStr = init.body as string;
        postBodies.push({ url: urlStr, body: bodyStr });
        return {
          ok: true,
          status: 200,
          json: async () => ({ seq: 1, msg_id: 'msg-product-1' }),
        } as Response;
      }

      // Roster fetch — empty / non-fatal
      if (urlStr.startsWith(`${BASE_URL}/api/sdk/roster?`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        } as Response;
      }

      // Any other fetch — reject harmlessly
      return { ok: false, status: 404, json: async () => null, text: async () => '' } as Response;
    });
    globalThis.fetch = fetchMock;

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('base-url', BASE_URL);
    // No _createClient — element creates a REAL SDKChatClient (plaintext mode).
    container.appendChild(el);

    // Wait for mount (list + subscribe-ticket + EventSource + roster).
    await new Promise((r) => setTimeout(r, 80));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const textarea = shadow!.querySelector('.oxp-composer-input') as HTMLTextAreaElement | null;
    const sendBtn = shadow!.querySelector('.oxp-composer-send') as HTMLButtonElement | null;
    expect(textarea).not.toBeNull();
    expect(sendBtn).not.toBeNull();

    // Stage a product card via the element's public API.
    const productMeta = {
      title: 'Widget Pro',
      price: 999,
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };
    el.setProductCard('sku-e2e-1', productMeta);

    // Type + send through the real composer.
    textarea!.value = 'check this product';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    sendBtn!.click();
    await new Promise((r) => setTimeout(r, 50));

    // Assert the POST /api/sdk/messages body carries product_ref + product_meta.
    const sendPosts = postBodies.filter((p) => p.url === `${BASE_URL}/api/sdk/messages`);
    expect(sendPosts.length).toBeGreaterThanOrEqual(1);
    const lastPost = sendPosts[sendPosts.length - 1];
    const payload = JSON.parse(lastPost.body) as Record<string, unknown>;
    expect(payload['product_ref']).toBe('sku-e2e-1');
    expect(payload['product_meta']).toEqual(productMeta);
    expect(payload['room_id']).toBe('room1');

    el.destroy();
  });
});
