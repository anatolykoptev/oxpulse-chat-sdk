/**
 * export-integration.test.ts — PR #311 review finding 2 (MEDIUM).
 *
 * The 11 tests in `export.test.ts` all call `exportRoomHistory(mockClient, …)`
 * with a hand-built `ExportClient`. None of them calls `SDKChatClient#exportRoom`,
 * so the production wiring was ungated: the reviewer replaced the delegator body
 * with `throw new Error("AMPUTATED")` and all 11 still passed.
 *
 * This file closes that hole by driving the REAL client against the REAL `list()`
 * — real pagination thunk, real crypto_mode resolution, real plaintext aliasing —
 * with only `fetch` stubbed.
 *
 * F5 mutation gate: in `client.ts`, replace the body of `exportRoom` with
 * `throw new Error('AMPUTATED')` (or drop `opts` from the delegated call) →
 * this suite must go RED. `export.test.ts` alone stays green, which is the whole
 * point of this file existing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { TEST_BASE_URL, TEST_JWT, TEST_SENDER_UID } from './helpers.js';

const ROOM = 'room-export-integration';

/** UTF-8 → base64 (the wire's `sealed_b64`; in plaintext mode these ARE the body bytes). */
function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** One page of the `GET /api/sdk/messages` wire envelope. */
function page(
  rows: Array<{ seq: number; body: string }>,
  hasMore: boolean,
): Response {
  return new Response(
    JSON.stringify({
      items: rows.map((r) => ({
        seq: r.seq,
        msg_id: `msg-${r.seq}`,
        sender_uid: TEST_SENDER_UID,
        sealed_b64: b64(r.body),
        created_at: `2026-08-12T00:00:0${r.seq}Z`,
        thread_root_msg_id: null,
        product_ref: null,
        product_meta: null,
      })),
      has_more: hasMore,
      next_cursor: hasMore ? (rows[rows.length - 1]?.seq ?? null) : null,
      crypto_mode: 'plaintext',
    }),
    { status: 200 },
  );
}

describe('SDKChatClient#exportRoom — production wiring (PR #311 finding 2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the real delegator exports every row across real pagination', async () => {
    const client = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'plaintext',
    });

    // Two pages — a single-page fixture could not detect a delegator that drops
    // pagination, for the same reason F1 in export.test.ts needs two pages.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([{ seq: 1, body: 'первое' }, { seq: 2, body: 'second' }], true))
      .mockResolvedValueOnce(page([{ seq: 3, body: 'третье' }], false));

    const result = await client.exportRoom(ROOM);

    expect(result.totalRows).toBe(3);
    expect(result.exportedRows).toBe(3);
    expect(result.failedRows).toBe(0);

    const parsed = JSON.parse(result.content) as {
      roomId: string;
      rows: Array<{ seq: number; body: string | null }>;
      counts: { total: number; exported: number; failed: number };
    };
    expect(parsed.roomId).toBe(ROOM);
    expect(parsed.counts).toEqual({ total: 3, exported: 3, failed: 0 });
    expect(parsed.rows.map((r) => r.body)).toEqual(['первое', 'second', 'третье']);
  });

  it('opts reach the real list() call — a custom limit appears on the wire', async () => {
    const client = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'plaintext',
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([{ seq: 1, body: 'x' }], false));

    await client.exportRoom(ROOM, { limit: 7 });

    // A delegator that drops `opts` would send the 200 default instead of 7.
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('limit=7');
  });

  it('text format carries the summary line through the real delegator', async () => {
    const client = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'plaintext',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      page([{ seq: 1, body: 'hello' }], false),
    );

    const result = await client.exportRoom(ROOM, { format: 'text' });

    expect(result.format).toBe('text');
    expect(result.content).toContain('hello');
    // Finding 3: the text content itself must expose loss, not only ExportResult.
    expect(result.content).toContain('# Exported 1/1 rows (0 failed)');
  });
});
