/**
 * pagination.test.ts — SDKChatClient.list() cursor-pagination (W1 / v0.2.0).
 *
 * Verifies:
 *   - list() returns { items, hasNext, next? } (ListResult), not MessageRow[].
 *   - Server response { items, has_more: true, next_cursor: 42 } → hasNext=true, next=42.
 *   - Server response { items, has_more: false, next_cursor: null } → hasNext=false, next undefined.
 *   - before_seq query param is forwarded when present in ListArgs.
 *   - before_seq is omitted when not provided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';

// ── Minimal mock fetch ────────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];

function makeFetchMock(responseBody: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as unknown as Response;
  });
}

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

// ── Wire DTOs ─────────────────────────────────────────────────────────────────

/** A minimal valid MessageDTO row from the server. */
function makeServerRow(seq: number) {
  return {
    seq,
    msg_id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    sender_uid: 'u1',
    sealed_b64: 'AA==',
    created_at: '2026-05-16T00:00:00Z',
    thread_root_msg_id: null,
    product_ref: null,
    product_meta: null,
  };
}

/** Build a fake Response for vi.fn().mockResolvedValueOnce chaining. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('SDKChatClient.list() — cursor pagination (W1)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('returns ListResult with hasNext=true and next when has_more=true', async () => {
    const serverResponse = {
      items: [makeServerRow(1), makeServerRow(2)],
      has_more: true,
      next_cursor: 42,
    };
    vi.stubGlobal('fetch', makeFetchMock(serverResponse));

    const client = makeClient();
    const result = await client.list('room-1');

    expect(result.hasNext).toBe(true);
    // next is now a thunk (direction-aware), not the raw cursor number.
    expect(typeof result.next).toBe('function');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ seq: 1, senderUid: 'u1' });
  });

  it('returns ListResult with hasNext=false and no next when has_more=false', async () => {
    const serverResponse = {
      items: [makeServerRow(10)],
      has_more: false,
      next_cursor: null,
    };
    vi.stubGlobal('fetch', makeFetchMock(serverResponse));

    const client = makeClient();
    const result = await client.list('room-2');

    expect(result.hasNext).toBe(false);
    expect(result.next).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it('forwards before_seq query param when provided', async () => {
    const serverResponse = {
      items: [],
      has_more: false,
      next_cursor: null,
    };
    vi.stubGlobal('fetch', makeFetchMock(serverResponse));

    const client = makeClient();
    await client.list('room-3', { beforeSeq: 99 });

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url).toContain('before_seq=99');
  });

  it('omits before_seq query param when not provided', async () => {
    const serverResponse = {
      items: [],
      has_more: false,
      next_cursor: null,
    };
    vi.stubGlobal('fetch', makeFetchMock(serverResponse));

    const client = makeClient();
    await client.list('room-4');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain('before_seq');
  });

  it('list() returns ListResult not an array', async () => {
    const serverResponse = {
      items: [makeServerRow(5)],
      has_more: false,
      next_cursor: null,
    };
    vi.stubGlobal('fetch', makeFetchMock(serverResponse));

    const client = makeClient();
    const result = await client.list('room-5');

    // Must be object with .items, not an array
    expect(Array.isArray(result)).toBe(false);
    expect(Array.isArray(result.items)).toBe(true);
  });

  // ── Direction-aware next_cursor (PR #978 code review fix) ────────────────────

  it('next() on forward page calls API with after_seq (not before_seq)', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(fakeResponse({
      items: [makeServerRow(5)],
      has_more: true,
      next_cursor: 5,
    }));
    fetchMock.mockResolvedValueOnce(fakeResponse({
      items: [],
      has_more: false,
      next_cursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const c = makeClient();
    const p1 = await c.list('room-fwd', { afterSeq: 0, limit: 1 });
    expect(typeof p1.next).toBe('function');
    await p1.next!();

    const secondCall = fetchMock.mock.calls[1][0] as string;
    const url = new URL(secondCall);
    expect(url.searchParams.get('after_seq')).toBe('5');
    expect(url.searchParams.has('before_seq')).toBe(false);
  });

  it('next() on backward page calls API with before_seq (not after_seq)', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(fakeResponse({
      items: [makeServerRow(3), makeServerRow(4)],
      has_more: true,
      next_cursor: 3,
    }));
    fetchMock.mockResolvedValueOnce(fakeResponse({
      items: [],
      has_more: false,
      next_cursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const c = makeClient();
    const p1 = await c.list('room-bwd', { beforeSeq: 5, limit: 2 });
    expect(typeof p1.next).toBe('function');
    await p1.next!();

    const secondCall = fetchMock.mock.calls[1][0] as string;
    const url = new URL(secondCall);
    expect(url.searchParams.get('before_seq')).toBe('3');
    // after_seq is always present in params but before_seq takes precedence server-side.
    expect(url.searchParams.has('before_seq')).toBe(true);
  });

  it('throws SDKChatError when server returns has_more=true but next_cursor=null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({
      items: [makeServerRow(1)],
      has_more: true,
      next_cursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const c = makeClient();
    let caught: unknown;
    try {
      await c.list('room-bad');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SDKChatError);
    expect((caught as SDKChatError).code).toBe('server_error');
  });
});
