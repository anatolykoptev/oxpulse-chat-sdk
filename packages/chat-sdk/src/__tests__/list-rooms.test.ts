/**
 * list-rooms.test.ts — listRooms() (P3.3 seller-side deals view)
 *
 * Tests (RED first, per TDD):
 *   1. Happy path single page (3 rooms, hasMore=false)
 *   2. Multi-page (limit=2 with hasMore=true, second call offset=2 returns rest)
 *   3. includeArchived=true → adds include_archived=true to URL
 *   4. HTTP 403 → throws SDKChatError with correct code
 *   5. HTTP 500 → throws SDKChatError
 *   6. URL construction: limit, offset, include_archived query params
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';

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

/** Minimal server room shape returned by GET /api/sdk/rooms */
function serverRoom(roomId: string) {
  return {
    app_id: 'app1',
    room_id: roomId,
    title: `Room ${roomId}`,
    product_ref: null,
    created_by: 'user1',
    created_at: '2026-05-27T00:00:00Z',
    archived_at: null,
    metadata: {},
  };
}

function serverListResponse(
  rooms: ReturnType<typeof serverRoom>[],
  limit = 50,
  offset = 0,
  has_more = false,
) {
  return { rooms, limit, offset, has_more };
}

describe('SDKChatClient — listRooms (P3.3)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: 3 rooms returned, hasMore=false', async () => {
    const serverRooms = [serverRoom('r1'), serverRoom('r2'), serverRoom('r3')];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverListResponse(serverRooms))),
    );

    const client = makeClient();
    const result = await client.listRooms();

    expect(result.rooms).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);

    // Verify the RoomSummary shape maps correctly from wire DTO.
    expect(result.rooms[0].roomId).toBe('r1');
    expect(result.rooms[0].createdBy).toBe('user1');
    // RoomSummary has no `members` field — call getRoom(roomId) for full member list.
    expect(result.rooms[0]).not.toHaveProperty('members');
  });

  it('multi-page: limit=2 hasMore=true; second call offset=2 returns rest', async () => {
    const serverRooms = [serverRoom('r1'), serverRoom('r2')];
    const serverRooms2 = [serverRoom('r3')];

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(serverListResponse(serverRooms, 2, 0, true)))
        .mockResolvedValueOnce(fakeResponse(serverListResponse(serverRooms2, 2, 2, false))),
    );

    const client = makeClient();

    const page1 = await client.listRooms({ limit: 2 });
    expect(page1.rooms).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.limit).toBe(2);

    const page2 = await client.listRooms({ limit: 2, offset: 2 });
    expect(page2.rooms).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('includeArchived=true → adds include_archived=true to URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverListResponse([]))),
    );

    const client = makeClient();
    await client.listRooms({ includeArchived: true });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('include_archived=true');
  });

  it('HTTP 403 → throws SDKChatError with forbidden code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 403)));

    const client = makeClient();
    await expect(client.listRooms()).rejects.toBeInstanceOf(SDKChatError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 403)));
    try {
      await client.listRooms();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SDKChatError);
      const sdkErr = err as SDKChatError;
      expect(sdkErr.code).toBe('forbidden');
      expect(sdkErr.statusCode).toBe(403);
    }
  });

  it('HTTP 500 → throws SDKChatError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 500)));

    const client = makeClient();
    await expect(client.listRooms()).rejects.toBeInstanceOf(SDKChatError);
  });

  it('URL construction: limit, offset, include_archived query params', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverListResponse([]))),
    );

    const client = makeClient();
    await client.listRooms({ limit: 10, offset: 20, includeArchived: true });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${BASE_URL}/api/sdk/rooms?limit=10&offset=20&include_archived=true`);
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBe(`Bearer ${JWT}`);
  });

  it('no opts → GET /api/sdk/rooms with no query string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverListResponse([]))),
    );

    const client = makeClient();
    await client.listRooms();

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/rooms`);
  });
});
