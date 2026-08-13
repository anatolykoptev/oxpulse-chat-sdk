/**
 * share-link-join.test.ts — mintShareLink + joinByLink (#292)
 *
 * Tests (RED first, per TDD):
 *   mintShareLink:
 *     1. Happy path: POST /api/sdk/rooms/:room_id/shortlink, body {} when no ttl
 *     2. With ttlSeconds: body has ttl_seconds present as a number
 *     3. Without ttlSeconds: body does NOT have ttl_seconds key
 *     4. Response maps snake_case → camelCase (alias, roomId, expiresAt, url)
 *     5. HTTP 403 → SDKChatError forbidden
 *     6. HTTP 429 → SDKChatError rate_limited  (F2 mutation gate)
 *     7. HTTP 503 → SDKChatError server_error
 *     8. Wire-shape: missing alias → server_error
 *   joinByLink:
 *     9. Happy path (new member): POST /api/sdk/rooms/:room_id/join, body { alias }, joined:true
 *    10. Already-a-member: joined:false is SUCCESS, not an error  (F3 mutation gate)
 *    11. HTTP 403 → SDKChatError forbidden
 *    12. HTTP 404 → SDKChatError not_found
 *    13. Wire-shape: missing room_id → server_error
 *
 * F1 mutation gate: test #1 asserts the EXACT path /shortlink (not /shortlinks).
 * F2 mutation gate: test #6 asserts code === 'rate_limited' on a 429.
 * F3 mutation gate: test #10 asserts joined:false is returned, not thrown.
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

// ── Server wire shapes (snake_case) ──────────────────────────────────────────

/** POST /api/sdk/rooms/:room_id/shortlink 200 response (rooms.rs:1379) */
function serverShortlink(roomId = 'r1') {
  return {
    alias: 'xA3kP',
    room_id: roomId,
    expires_at: '2026-08-13T00:00:00Z',
    url: '/s/xA3kP',
  };
}

/** POST /api/sdk/rooms/:room_id/join 200 response (rooms.rs:1578) */
function serverJoinResult(roomId = 'r1', userId = 'u1', joined = true) {
  return {
    room_id: roomId,
    user_id: userId,
    role: 'member',
    joined,
  };
}

// ── mintShareLink ────────────────────────────────────────────────────────────

describe('SDKChatClient — mintShareLink (#292)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: POST /shortlink with empty body, maps to camelCase ShareLink', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverShortlink('r1'))));

    const client = makeClient();
    const result = await client.mintShareLink('r1');

    // F1 gate: exact URL — /shortlink NOT /shortlinks
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/rooms/r1/shortlink`);
    expect(init?.method).toBe('POST');

    // Body contract: empty object when ttlSeconds omitted
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({});

    // Response mapped snake_case → camelCase
    expect(result).toEqual({
      alias: 'xA3kP',
      roomId: 'r1',
      expiresAt: '2026-08-13T00:00:00Z',
      url: '/s/xA3kP',
    });
  });

  it('with ttlSeconds: body has ttl_seconds present as a number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverShortlink())));

    const client = makeClient();
    await client.mintShareLink('r1', { ttlSeconds: 3600 });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['ttl_seconds']).toBe(3600);
    expect(Object.keys(body)).toEqual(['ttl_seconds']);
  });

  it('without ttlSeconds: body does NOT have ttl_seconds key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverShortlink())));

    const client = makeClient();
    await client.mintShareLink('r1');

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('ttl_seconds');
  });

  it('HTTP 403 → SDKChatError forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 403)));

    const client = makeClient();
    const err = await client.mintShareLink('r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'forbidden', statusCode: 403 });
  });

  it('HTTP 429 → SDKChatError rate_limited  (F2 gate)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 429)));

    const client = makeClient();
    const err = await client.mintShareLink('r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    // F2: must be rate_limited, NOT a generic fall-through
    expect(err).toMatchObject({ code: 'rate_limited', statusCode: 429 });
  });

  it('HTTP 503 → SDKChatError server_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 503)));

    const client = makeClient();
    const err = await client.mintShareLink('r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'server_error', statusCode: 503 });
  });

  it('wire-shape: missing alias → SDKChatError server_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fakeResponse({ room_id: 'r1', expires_at: '...', url: '/s/x' }),
      ),
    );

    const client = makeClient();
    const err = await client.mintShareLink('r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'server_error' });
  });
});

// ── joinByLink ───────────────────────────────────────────────────────────────

describe('SDKChatClient — joinByLink (#292)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path (new member): POST /join with { alias }, joined:true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverJoinResult('r1', 'u1', true))));

    const client = makeClient();
    const result = await client.joinByLink('r1', 'xA3kP');

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/rooms/r1/join`);
    expect(init?.method).toBe('POST');

    // Body contract: { alias: "..." }
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ alias: 'xA3kP' });

    // Response mapped snake_case → camelCase
    expect(result).toEqual({
      roomId: 'r1',
      userId: 'u1',
      role: 'member',
      joined: true,
    });
  });

  it('already-a-member: joined:false is SUCCESS, not an error  (F3 gate)', async () => {
    // Server returns 200 with joined:false when the caller was already a member.
    // This is the idempotent success path — returning it as an error would be a bug.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse(serverJoinResult('r1', 'u1', false))));

    const client = makeClient();
    const result = await client.joinByLink('r1', 'xA3kP');

    // F3: must return joined:false, NOT throw
    expect(result).toEqual({
      roomId: 'r1',
      userId: 'u1',
      role: 'member',
      joined: false,
    });
  });

  it('HTTP 403 → SDKChatError forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 403)));

    const client = makeClient();
    const err = await client.joinByLink('r1', 'xA3kP').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'forbidden', statusCode: 403 });
  });

  it('HTTP 404 → SDKChatError not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fakeResponse({}, 404)));

    const client = makeClient();
    const err = await client.joinByLink('r1', 'xA3kP').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'not_found', statusCode: 404 });
  });

  it('wire-shape: missing room_id → SDKChatError server_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fakeResponse({ user_id: 'u1', role: 'member', joined: true }),
      ),
    );

    const client = makeClient();
    const err = await client.joinByLink('r1', 'xA3kP').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SDKChatError);
    expect(err).toMatchObject({ code: 'server_error' });
  });
});
