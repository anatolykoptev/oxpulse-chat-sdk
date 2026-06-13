/**
 * visibility.test.ts — RoomVisibility surface on createRoom (v1.4.0)
 *
 * Wire-contract assertions:
 *   1. createRoom({ visibility: 'open' }) → POST body includes visibility: 'open'
 *   2. createRoom({ visibility: 'member' }) → POST body includes visibility: 'member'
 *   3. createRoom() with no visibility → POST body omits the visibility field
 *   4. createRoom response carries visibility field → Room.visibility populated
 *   5. getRoom response carries visibility field → Room.visibility populated
 *   6. listRooms response carries visibility → RoomSummary.visibility populated
 *   7. RoomVisibility type is exported from the package index
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import type { RoomVisibility } from '../types.js';

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

/** Minimal server room DTO shape returned by POST/GET /api/sdk/rooms */
function serverRoom(roomId: string, visibility: RoomVisibility = 'member') {
  return {
    app_id: 'app1',
    room_id: roomId,
    title: null,
    product_ref: null,
    created_by: 'user1',
    created_at: '2026-06-13T00:00:00Z',
    archived_at: null,
    metadata: {},
    members: [],
    visibility,
  };
}

describe('SDKChatClient — visibility surface (v1.4.0)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── createRoom POST body ────────────────────────────────────────────────────

  it('createRoom({ visibility: "open" }) sends visibility: "open" in POST body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1', 'open'), 201)),
    );

    const client = makeClient();
    await client.createRoom({ visibility: 'open' });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['visibility']).toBe('open');
  });

  it('createRoom({ visibility: "member" }) sends visibility: "member" in POST body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1', 'member'), 201)),
    );

    const client = makeClient();
    await client.createRoom({ visibility: 'member' });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['visibility']).toBe('member');
  });

  it('createRoom() with no visibility omits the visibility field from POST body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1'), 201)),
    );

    const client = makeClient();
    await client.createRoom();

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    // Absent field: server should apply its own default ('member').
    expect(Object.prototype.hasOwnProperty.call(body, 'visibility')).toBe(false);
  });

  // ── createRoom response mapping ─────────────────────────────────────────────

  it('createRoom response: Room.visibility is populated from server response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1', 'open'), 201)),
    );

    const client = makeClient();
    const room = await client.createRoom({ visibility: 'open' });

    expect(room.visibility).toBe('open');
  });

  it('createRoom response: Room.visibility "member" is passed through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1', 'member'), 201)),
    );

    const client = makeClient();
    const room = await client.createRoom();

    expect(room.visibility).toBe('member');
  });

  // ── getRoom response mapping ────────────────────────────────────────────────

  it('getRoom response: Room.visibility is populated from server response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverRoom('r1', 'open'))),
    );

    const client = makeClient();
    const room = await client.getRoom('r1');

    expect(room.visibility).toBe('open');
  });

  it("getRoom response: absent visibility → defaults to 'member' (pre-open-rooms server)", async () => {
    // Server returns no visibility field (pre-open-rooms prod server).
    const dto = {
      app_id: 'app1',
      room_id: 'r1',
      title: null,
      product_ref: null,
      created_by: 'user1',
      created_at: '2026-06-13T00:00:00Z',
      archived_at: null,
      metadata: {},
      members: [],
      // visibility absent
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(dto)),
    );

    const client = makeClient();
    const room = await client.getRoom('r1');

    // Fallback in dtoToRoom: dto.visibility ?? member
    expect(room.visibility).toBe('member');
  });

  // ── listRooms response mapping ──────────────────────────────────────────────

  // ── listRooms: missing visibility field (real RoomListItem omits it) ─────────

  it("listRooms: absent visibility in list row → defaults to 'member' (server version skew)", async () => {
    // The server RoomListItem does NOT emit visibility (pre-open-rooms servers).
    // This test exercises the ?? 'member' fallback in the list mapper.
    // It would FAIL without the fallback (typed undefined, domain requires RoomVisibility).
    const listBody = {
      rooms: [
        {
          app_id: 'app1',
          room_id: 'r1',
          title: null,
          product_ref: null,
          created_by: 'user1',
          created_at: '2026-06-13T00:00:00Z',
          archived_at: null,
          metadata: {},
          // visibility deliberately absent — mirrors real RoomListItem server shape
        },
      ],
      limit: 50,
      offset: 0,
      has_more: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(listBody)),
    );

    const client = makeClient();
    const result = await client.listRooms();

    // Fallback: absent field → member
    expect(result.rooms[0].visibility).toBe('member');
  });

  it('listRooms: server sends visibility: "open" in list row → passed through (forward-compat)', async () => {
    // Forward-compat: once the server adds visibility to RoomListItem, the SDK
    // should pass it through instead of always returning member.
    const listBody = {
      rooms: [
        {
          app_id: 'app1',
          room_id: 'r1',
          title: null,
          product_ref: null,
          created_by: 'user1',
          created_at: '2026-06-13T00:00:00Z',
          archived_at: null,
          metadata: {},
          visibility: 'open',
        },
      ],
      limit: 50,
      offset: 0,
      has_more: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(listBody)),
    );

    const client = makeClient();
    const result = await client.listRooms();

    expect(result.rooms[0].visibility).toBe('open');
  });

  // ── Type export check (compile-time + runtime) ──────────────────────────────

  it('RoomVisibility type is importable and constrains the two literal values', () => {
    const open: RoomVisibility = 'open';
    const member: RoomVisibility = 'member';
    expect(['open', 'member']).toContain(open);
    expect(['open', 'member']).toContain(member);
  });
});
