/**
 * product-meta-validation.test.ts — #117 SDK-side product_meta validation.
 *
 * Verifies rowToMessageRow normalizes product_meta at the receive boundary:
 *   - partial (missing core fields) → null
 *   - non-object → null
 *   - oversized strings → capped
 *   - bad/oversized URLs → ''
 *   - valid → passed through
 *
 * Tested through list() which calls rowToMessageRow on each server row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

function makeServerRow(opts: { seq?: number; product_ref?: string | null; product_meta?: unknown } = {}) {
  return {
    seq: opts.seq ?? 1,
    msg_id: `00000000-0000-0000-0000-${String(opts.seq ?? 1).padStart(12, '0')}`,
    sender_uid: 'u1',
    sealed_b64: 'AA==',
    created_at: '2026-05-16T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: opts.product_ref ?? null,
    product_meta: opts.product_meta ?? null,
  };
}

function makeListResponse(items: unknown[]) {
  return {
    items,
    has_more: false,
    next_cursor: null,
    crypto_mode: 'plaintext',
  };
}

function stubFetch(responseBody: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => responseBody,
  }) as unknown as Response));
}

describe('rowToMessageRow — product_meta validation (#117)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('valid product_meta passes through', async () => {
    const meta = {
      title: 'Widget Pro',
      price: '999',
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };
    stubFetch(makeListResponse([makeServerRow({ product_ref: 'sku-1', product_meta: meta })]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toEqual(meta);
    expect(result.items[0].productRef).toBe('sku-1');
  });

  it('null product_meta → null', async () => {
    stubFetch(makeListResponse([makeServerRow({ product_meta: null })]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });

  it('non-object product_meta (string) → null', async () => {
    stubFetch(makeListResponse([makeServerRow({ product_ref: 'sku-1', product_meta: 'garbage' })]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });

  it('non-object product_meta (number) → null', async () => {
    stubFetch(makeListResponse([makeServerRow({ product_meta: 42 })]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });

  it('partial product_meta (missing price) → null', async () => {
    stubFetch(makeListResponse([
      makeServerRow({ product_ref: 'sku-1', product_meta: { title: 'Widget', currency: 'USD' } }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });

  it('partial product_meta (empty title) → null', async () => {
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: '', price: '999', currency: 'USD' },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });

  it('oversized title (201 chars) → capped to 200', async () => {
    const longTitle = 'A'.repeat(201);
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: longTitle, price: '999', currency: 'USD' },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.title.length).toBe(200);
    expect(result.items[0].productMeta!.price).toBe('999');
  });

  it('oversized price (41 chars) → capped to 40', async () => {
    const longPrice = '9'.repeat(41);
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 'Widget', price: longPrice, currency: 'USD' },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.price.length).toBe(40);
  });

  it('oversized currency (17 chars) → capped to 16', async () => {
    const longCurrency = 'X'.repeat(17);
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 'Widget', price: '999', currency: longCurrency },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.currency.length).toBe(16);
  });

  it('oversized imageUrl (2049 chars) → coerced to empty string', async () => {
    const longUrl = 'https://example.com/' + 'A'.repeat(2030);
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 'Widget', price: '999', currency: 'USD', imageUrl: longUrl },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    // Over-cap URL degrades to '' (not a truncated, broken-but-clickable URL) —
    // the render-side isSafeAttachmentUrl gate then omits the image.
    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.imageUrl).toBe('');
  });

  it('bad imageUrl (not a string) → coerced to empty string', async () => {
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 'Widget', price: '999', currency: 'USD', imageUrl: 123 },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.imageUrl).toBe('');
  });

  it('bad productUrl (not a string) → coerced to empty string', async () => {
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 'Widget', price: '999', currency: 'USD', productUrl: false },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).not.toBeNull();
    expect(result.items[0].productMeta!.productUrl).toBe('');
  });

  it('non-string title → null (core field invalid)', async () => {
    stubFetch(makeListResponse([
      makeServerRow({
        product_ref: 'sku-1',
        product_meta: { title: 42, price: '999', currency: 'USD' },
      }),
    ]));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.items[0].productMeta).toBeNull();
  });
});
