/**
 * send.test.ts — SDKChatClient.send() product fields (B3 / v1.0.0 pre-publish).
 *
 * Verifies:
 *   - B3: SendArgs now accepts productRef and productMeta.
 *   - send() forwards product fields to wire body (product_ref, product_meta).
 *   - sendText() accepts and forwards product fields via send().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { CryptoProvider } from '../types.js';

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';
const ROOM_ID = 'room-b3-test';

const SEALED_BYTES = [1, 2, 3, 4];
function makeSealed(): ArrayBuffer {
  return new Uint8Array(SEALED_BYTES).buffer;
}

function makeOkResponse(seq = 1, msgId = 'msg-001'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ seq, msg_id: msgId }),
  } as unknown as Response;
}

function makeE2EEClient(): SDKChatClient {
  const cryptoProvider: CryptoProvider = {
    seal: vi.fn(async (plain: ArrayBuffer) => plain),
    unseal: vi.fn(async (cipher: ArrayBuffer) => cipher),
  };
  return new SDKChatClient({
    baseUrl: BASE_URL,
    jwt: JWT,
    e2ee: { provider: cryptoProvider },
    // Gate: send-before-discover requires cryptoMode to be known when e2ee is configured.
    cryptoMode: 'sframe-static',
  });
}

describe('SDKChatClient.send() — B3: productRef/productMeta in SendArgs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('send() includes product_ref and product_meta in wire body when provided', async () => {
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    await client.send(ROOM_ID, {
      senderUid: 'user-1',
      sealed: makeSealed(),
      productRef: 'prod-xyz',
      productMeta: { title: 'Widget', price: 42 },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['product_ref']).toBe('prod-xyz');
    expect(body['product_meta']).toEqual({ title: 'Widget', price: 42 });
  });

  it('send() omits product_ref and product_meta when not provided', async () => {
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    await client.send(ROOM_ID, {
      senderUid: 'user-1',
      sealed: makeSealed(),
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['product_ref']).toBeUndefined();
    expect(body['product_meta']).toBeUndefined();
  });

  it('sendText() forwards productRef and productMeta through to send()', async () => {
    const client = makeE2EEClient();

    await client.sendText(ROOM_ID, {
      senderUid: 'user-1',
      text: 'hello product',
      productRef: 'prod-abc',
      productMeta: { sku: '123' },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['product_ref']).toBe('prod-abc');
    expect(body['product_meta']).toEqual({ sku: '123' });
  });
});
