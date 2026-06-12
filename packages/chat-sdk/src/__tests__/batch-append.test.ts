/**
 * batch-append.test.ts — SDKChatClient.batchAppend() (W7 / v1.0.0).
 *
 * Verifies:
 *   - batchAppend() sends POST /api/sdk/messages/batch with correct payload.
 *   - room_id is injected; optional fields default to null when absent.
 *   - BatchAppendItem uses camelCase (public surface); wire DTO uses snake_case.
 *   - sealed is ArrayBuffer on input; wire sends sealed_b64 (base64 string).
 *   - Optional fields (sealed, threadRootMsgId, productRef, productMeta) forwarded.
 *   - Network failure throws SDKChatError with code 'network'.
 *   - HTTP 4xx throws SDKChatError with mapped code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { BatchAppendItem } from '../types.js';
import { SDKChatError } from '../errors.js';

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';
const ROOM_ID = 'room-abc';

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

/** Helper: create a minimal ArrayBuffer from bytes */
function makeSealed(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** Decode a base64 string to the original bytes for assertion */
function fromBase64(b64: string): number[] {
  return Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe('SDKChatClient.batchAppend()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true, status: 200 } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends POST /api/sdk/messages/batch with Authorization header', async () => {
    const client = makeClient();
    // B1: camelCase input — msgId (not msg_id)
    const item: BatchAppendItem = { msgId: '00000000-0000-4000-8000-000000000001' };
    await client.batchAppend(ROOM_ID, [item]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/messages/batch`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${JWT}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('injects room_id into each item and defaults optional fields to null (wire snake_case)', async () => {
    const client = makeClient();
    // B1: camelCase input
    const items: BatchAppendItem[] = [
      { msgId: '00000000-0000-4000-8000-000000000001' },
      { msgId: '00000000-0000-4000-8000-000000000002' },
    ];
    await client.batchAppend(ROOM_ID, items);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown[];
    expect(body).toHaveLength(2);
    // Wire DTO must be snake_case
    expect(body[0]).toEqual({
      room_id: ROOM_ID,
      msg_id: '00000000-0000-4000-8000-000000000001',
      sealed_b64: null,
      thread_root_msg_id: null,
      product_ref: null,
      product_meta: null,
    });
  });

  it('B2: sealed ArrayBuffer → base64 encoded as sealed_b64 on wire', async () => {
    const client = makeClient();
    // [115, 101, 97, 108, 101, 100] = 'sealed' in UTF-8
    const sealedBytes = [115, 101, 97, 108, 101, 100];
    const item: BatchAppendItem = {
      msgId: '00000000-0000-4000-8000-000000000003',
      // B2: sealed is ArrayBuffer, not base64 string
      sealed: makeSealed(sealedBytes),
    };
    await client.batchAppend(ROOM_ID, [item]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Array<Record<string, unknown>>;
    // Wire must contain sealed_b64 (base64 string), not the raw ArrayBuffer
    const wireItem = body[0];
    expect(typeof wireItem['sealed_b64']).toBe('string');
    // Verify the base64 decodes back to original bytes
    expect(fromBase64(wireItem['sealed_b64'] as string)).toEqual(sealedBytes);
  });

  it('forwards all optional fields when present (camelCase → snake_case wire)', async () => {
    const client = makeClient();
    const sealedBytes = [115, 101, 97, 108, 101, 100]; // 'sealed'
    const item: BatchAppendItem = {
      msgId: '00000000-0000-4000-8000-000000000004',
      sealed: makeSealed(sealedBytes),
      threadRootMsgId: '00000000-0000-4000-8000-FFFFFFFFFFF0',
      productRef: 'prod-123',
      productMeta: { price: 99 },
    };
    await client.batchAppend(ROOM_ID, [item]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Array<Record<string, unknown>>;
    const wireItem = body[0];
    expect(wireItem['msg_id']).toBe(item.msgId);
    expect(wireItem['room_id']).toBe(ROOM_ID);
    expect(typeof wireItem['sealed_b64']).toBe('string');
    expect(fromBase64(wireItem['sealed_b64'] as string)).toEqual(sealedBytes);
    expect(wireItem['thread_root_msg_id']).toBe('00000000-0000-4000-8000-FFFFFFFFFFF0');
    expect(wireItem['product_ref']).toBe('prod-123');
    expect(wireItem['product_meta']).toEqual({ price: 99 });
  });

  it('throws SDKChatError with code network on fetch failure', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = makeClient();
    await expect(
      client.batchAppend(ROOM_ID, [{ msgId: '00000000-0000-4000-8000-000000000001' }]),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof SDKChatError && err.code === 'network';
    });
  });

  it('throws SDKChatError with code unauthorized on HTTP 401', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const client = makeClient();
    await expect(
      client.batchAppend(ROOM_ID, [{ msgId: '00000000-0000-4000-8000-000000000001' }]),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof SDKChatError && err.code === 'unauthorized';
    });
  });
});
