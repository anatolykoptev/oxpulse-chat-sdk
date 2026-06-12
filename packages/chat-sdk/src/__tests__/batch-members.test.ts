/**
 * batch-members.test.ts — batchAddMembers + deleteRoom (v1.2.0)
 *
 * Tests (RED first, per TDD):
 *   batchAddMembers:
 *     1. Single-chunk basic case (3 userIds → 1 fetch call)
 *     2. Multi-chunk (750 userIds → 2 fetch calls, sizes 500+250)
 *     3. Empty array rejection (throws SDKChatError 'invalid_args', 0 fetch calls)
 *     4. Role default ('member' applied when not specified)
 *     5. HTTP error (429 → throws SDKChatBatchError with correct code + status)
 *     6. Wire-shape assertion (missing 'added'/'updated' → SDKChatError server_error)
 *     7. Mid-bulk failure (chunk 2 of 2 fails → SDKChatBatchError with partial)
 *   deleteRoom:
 *     1. Happy path (DELETE /api/sdk/messages/:roomId, returns void)
 *     2. HTTP error (404 → throws SDKChatError with correct code)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient, BATCH_ADD_MEMBERS_CHUNK } from '../client.js';
import { SDKChatError, SDKChatBatchError } from '../errors.js';

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => '',
  } as unknown as Response;
}

describe('SDKChatClient — batchAddMembers (v1.2.0)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    // vi.restoreAllMocks() does NOT restore vi.stubGlobal-set globals;
    // vi.unstubAllGlobals() is required for that.
    vi.unstubAllGlobals();
  });

  it('single-chunk: 3 userIds → 1 fetch call with user_ids array', async () => {
    // Plan: docs/superpowers/plans/2026-05-19-chat-sdk-v2.0-alt-plaintext-groups.md rev 16
    const userIds = ['u1', 'u2', 'u3'];
    // Real server shape: { added, updated } (crates/sdk/src/rooms.rs:281-286)
    const serverResp = { added: ['u1', 'u2', 'u3'], updated: [] as string[] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverResp)));

    const client = makeClient();
    const result = await client.batchAddMembers('r1', userIds);

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/rooms/r1/members`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['user_ids']).toEqual(['u1', 'u2', 'u3']);
    expect(body['role']).toBe('member');

    expect(result).toEqual({ added: ['u1', 'u2', 'u3'], updated: [] });
  });

  it('multi-chunk: 750 userIds → 2 fetch calls with chunk sizes 500+250', async () => {
    const userIds = Array.from({ length: 750 }, (_, i) => `u${i}`);
    // Real server shape: { added, updated }
    const chunk1Resp = {
      added: userIds.slice(0, 500),
      updated: [] as string[],
    };
    const chunk2Resp = {
      added: userIds.slice(500, 750),
      updated: [] as string[],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(fakeResponse(chunk1Resp))
        .mockResolvedValueOnce(fakeResponse(chunk2Resp)),
    );

    const client = makeClient();
    const result = await client.batchAddMembers('r1', userIds);

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First chunk: 500 entries
    const [, init1] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body1 = JSON.parse(init1?.body as string) as Record<string, unknown>;
    expect((body1['user_ids'] as string[]).length).toBe(500);

    // Second chunk: 250 entries
    const [, init2] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(init2?.body as string) as Record<string, unknown>;
    expect((body2['user_ids'] as string[]).length).toBe(250);

    // Aggregated result: all 750 unique entries across added + updated
    expect(result.added.length + result.updated.length).toBe(750);
  });

  it('empty array → throws SDKChatError invalid_args without calling fetch', async () => {
    const client = makeClient();

    const err = await client.batchAddMembers('r1', []).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_args' });
    expect(err).toBeInstanceOf(SDKChatError);

    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('role default: omitting role sends role: "member"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse({ added: ['u1'], updated: [] })),
    );

    const client = makeClient();
    await client.batchAddMembers('r1', ['u1']);

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['role']).toBe('member');
  });

  it('HTTP 429 → throws SDKChatBatchError with statusCode 429 and code rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 429)));

    const client = makeClient();
    const err = await client.batchAddMembers('r1', ['u1']).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', statusCode: 429 });
    expect(err).toBeInstanceOf(SDKChatBatchError);
  });

  it('wire-shape assertion: missing "added" field → throws SDKChatError server_error', async () => {
    // Regression guard: if server changes shape, SDK throws server_error immediately
    // rather than silently pushing undefined and corrupting the aggregate.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse({ inserted: ['u1'], reactivated: [] })),
    );

    const client = makeClient();
    const err = await client.batchAddMembers('r1', ['u1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'server_error' });
  });

  it('mid-bulk failure: chunk 2 of 2 fails with 429 → SDKChatBatchError carries partial', async () => {
    // 750 userIds → chunk 1 (500) succeeds, chunk 2 (250) hits 429.
    // Caller must be able to recover the 500 that succeeded and retry the 250.
    const userIds = Array.from({ length: 750 }, (_, i) => `u${i}`);
    const chunk1Added = userIds.slice(0, 500);

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(fakeResponse({ added: chunk1Added, updated: [] }))
        .mockResolvedValueOnce(fakeResponse({}, 429)),
    );

    const client = makeClient();
    const err = await client.batchAddMembers('r1', userIds).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SDKChatBatchError);
    expect(err).toMatchObject({ code: 'rate_limited', statusCode: 429 });

    const batchErr = err as SDKChatBatchError;
    // Partial covers the 500 that went through chunk 1
    expect(batchErr.partial.added.length + batchErr.partial.updated.length).toBe(500);
    // Failed chunk starts at index 500
    expect(batchErr.failedAtIndex).toBe(500);
    // Failed chunk is the 250-element second chunk
    expect(batchErr.failedChunk.length).toBe(250);
    // Nothing remains after the failed chunk (only 2 chunks total)
    expect(batchErr.remaining.length).toBe(0);
  });
});

describe('SDKChatClient — deleteRoom (v1.2.0)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    // vi.unstubAllGlobals() required — vi.restoreAllMocks() does not cover stubGlobal.
    vi.unstubAllGlobals();
  });

  it('happy path: DELETEs /api/sdk/messages/:roomId and returns void', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(null, 200)));

    const client = makeClient();
    const result = await client.deleteRoom('r1');

    expect(result).toBeUndefined();
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/messages/r1`);
    expect(init?.method).toBe('DELETE');
  });

  it('HTTP 404 → throws SDKChatError with correct code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 404)));

    const client = makeClient();
    const err = await client.deleteRoom('r1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not_found' });
    expect(err).toBeInstanceOf(SDKChatError);
  });
});

describe('BATCH_ADD_MEMBERS_CHUNK constant', () => {
  it('is exported and equals 500 (server BULK_ADD_MAX)', () => {
    // Verifies the constant import from client.ts
    expect(BATCH_ADD_MEMBERS_CHUNK).toBe(500);
  });
});
