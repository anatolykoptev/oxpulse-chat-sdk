/**
 * export.test.ts — #294: Room history export tests.
 *
 * Tests the OUTPUT CONTRACT (parse the JSON, check shape + counts), not
 * substrings. The three falsification guards (F1/F2/F3) are documented inline
 * and verified separately by mutation.
 */

import { describe, it, expect, vi } from 'vitest';
import { exportRoomHistory } from '../export.js';
import type { ExportClient } from '../export.js';
import type { ListArgs, ListResult, MessageRow } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** UTF-8 encode a string to ArrayBuffer (matches how list() delivers plaintext). */
function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/** Ciphertext bytes distinct from any plaintext (so F2 can detect the swap). */
function encSealed(n: number): ArrayBuffer {
  // 0xFF bytes — invalid UTF-8, guaranteed different from any plaintext body.
  const buf = new Uint8Array(8);
  buf.fill(0xff);
  buf[0] = n; // distinguish rows
  return buf.buffer as ArrayBuffer;
}

/** Build a decrypted MessageRow (plaintext present, no unsealError). */
function decryptedRow(seq: number, body: string, senderUid = 'u1'): MessageRow {
  return {
    seq,
    msgId: `msg-${seq}`,
    senderUid,
    sealed: encSealed(seq),
    plaintext: enc(body),
    createdAt: `2026-08-12T00:00:${String(seq).padStart(2, '0')}Z`,
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    editCount: 0,
  };
}

/** Build an undecryptable MessageRow (unsealError set, plaintext undefined). */
function failedRow(seq: number, unsealError: 'replay' | 'auth' | 'unknown' = 'auth'): MessageRow {
  return {
    seq,
    msgId: `msg-${seq}`,
    senderUid: 'u1',
    sealed: encSealed(seq),
    unsealError,
    createdAt: `2026-08-12T00:00:${String(seq).padStart(2, '0')}Z`,
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    editCount: 0,
  };
}

/**
 * Build a MessageRow that was never decrypted: no `plaintext` AND no
 * `unsealError`. This is what `list()` delivers when the client has no crypto
 * provider configured for the room — neither of the other two builders produces
 * it, which is why the original three mutation guards could not detect it being
 * mishandled.
 */
function neverDecryptedRow(seq: number): MessageRow {
  return {
    seq,
    msgId: `msg-${seq}`,
    senderUid: 'u1',
    sealed: encSealed(seq),
    createdAt: `2026-08-12T00:00:${String(seq).padStart(2, '0')}Z`,
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    editCount: 0,
  };
}

/**
 * Build a mock ExportClient from an array of pages (each page = MessageRow[]).
 * Pages are returned in order; the last page has hasNext=false. Intermediate
 * pages have hasNext=true and a `next` thunk that fetches the next page.
 */
function mockClient(pages: MessageRow[][]): ExportClient & { listMock: ReturnType<typeof vi.fn> } {
  const listMock = vi.fn(async (roomId: string, _args?: ListArgs): Promise<ListResult> => {
    const callIndex = listMock.mock.calls.length - 1;
    const page = pages[callIndex] ?? [];
    const isLast = callIndex >= pages.length - 1;
    const result: ListResult = { items: page, hasNext: !isLast };
    if (!isLast) {
      result.next = async () => listMock(roomId);
    }
    return result;
  });
  return { list: listMock, listMock };
}

// ── Contract tests ────────────────────────────────────────────────────────────

describe('exportRoomHistory — contract', () => {
  it('walks all pages to exhaustion and reports correct counts (multi-page)', async () => {
    // Fixture sized PAST the page boundary: 3 rows on page 1, 2 on page 2.
    const client = mockClient([
      [decryptedRow(1, 'hello'), decryptedRow(2, 'world'), decryptedRow(3, 'foo')],
      [decryptedRow(4, 'bar'), decryptedRow(5, 'baz')],
    ]);

    const result = await exportRoomHistory(client, 'room-1');

    expect(result.format).toBe('json');
    expect(result.totalRows).toBe(5);
    expect(result.exportedRows).toBe(5);
    expect(result.failedRows).toBe(0);

    // Parse the JSON — assert the CONTRACT, not a substring.
    const parsed = JSON.parse(result.content) as {
      roomId: string;
      rows: Array<{ seq: number; msgId: string; senderUid: string; ts: string; body: string | null }>;
      counts: { total: number; exported: number; failed: number };
    };
    expect(parsed.roomId).toBe('room-1');
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[0]).toMatchObject({ seq: 1, msgId: 'msg-1', body: 'hello' });
    expect(parsed.rows[4]).toMatchObject({ seq: 5, body: 'baz' });
    expect(parsed.counts).toEqual({ total: 5, exported: 5, failed: 0 });

    // list() was called twice (two pages).
    expect(client.listMock).toHaveBeenCalledTimes(2);
  });

  it('exports an undecryptable row as an explicit error entry (never skipped)', async () => {
    const client = mockClient([
      [decryptedRow(1, 'ok'), failedRow(2, 'auth'), decryptedRow(3, 'also-ok')],
    ]);

    const result = await exportRoomHistory(client, 'room-2');

    expect(result.totalRows).toBe(3);
    expect(result.exportedRows).toBe(2);
    expect(result.failedRows).toBe(1);

    const parsed = JSON.parse(result.content) as {
      rows: Array<{ seq: number; body: string | null; unsealError?: string }>;
    };
    // The error row is present at index 1, with body=null and unsealError set.
    expect(parsed.rows[1]).toMatchObject({ seq: 2, body: null, unsealError: 'auth' });
    // Decrypted rows have bodies.
    expect(parsed.rows[0]).toMatchObject({ seq: 1, body: 'ok' });
    expect(parsed.rows[2]).toMatchObject({ seq: 3, body: 'also-ok' });
  });

  it('text format produces human-readable output', async () => {
    const client = mockClient([
      [decryptedRow(1, 'hello'), failedRow(2, 'replay')],
    ]);

    const result = await exportRoomHistory(client, 'room-3', { format: 'text' });

    expect(result.format).toBe('text');
    expect(result.totalRows).toBe(2);
    expect(result.exportedRows).toBe(1);
    expect(result.failedRows).toBe(1);
    expect(result.content).toContain('[1] u1 @');
    expect(result.content).toContain('hello');
    expect(result.content).toContain('[unseal error: replay]');
  });

  it('honours AbortSignal between pages', async () => {
    const client = mockClient([
      [decryptedRow(1, 'page-1')],
      [decryptedRow(2, 'page-2')],
    ]);

    const controller = new AbortController();
    // Abort after the first page is fetched (before the second page call).
    const originalList = client.list;
    client.list = vi.fn(async (roomId: string, args?: ListArgs) => {
      const res = await originalList(roomId, args);
      // Abort right after the first page returns, before the loop calls next().
      if (!res.hasNext) {
        controller.abort();
      } else {
        controller.abort();
      }
      return res;
    }) as ExportClient['list'];

    await expect(
      exportRoomHistory(client, 'room-abort', { signal: controller.signal }),
    ).rejects.toThrow('export aborted');
  });

  it('passes afterSeq=0 and limit to the first list() call', async () => {
    const client = mockClient([[decryptedRow(1, 'x')]]);

    await exportRoomHistory(client, 'room-args', { limit: 50 });

    expect(client.listMock).toHaveBeenCalledTimes(1);
    const args = client.listMock.mock.calls[0]![1] as ListArgs;
    expect(args.afterSeq).toBe(0);
    expect(args.limit).toBe(50);
  });

  it('defaults to limit=200 when not specified', async () => {
    const client = mockClient([[decryptedRow(1, 'x')]]);

    await exportRoomHistory(client, 'room-default-limit');

    const args = client.listMock.mock.calls[0]![1] as ListArgs;
    expect(args.limit).toBe(200);
  });
});

// ── Falsification guards (F1/F2/F3) ───────────────────────────────────────────
//
// Each test below is structured so that a specific mutation in export.ts makes
// it go RED. The mutations are documented in the report; these tests are the
// guard that the production code does NOT contain them.

describe('exportRoomHistory — falsification guards', () => {
  // F1: remove pagination continuation → loop stops after first page.
  // Fixture has 2 pages (3 + 2 rows). If the loop breaks after page 1,
  // totalRows=3 instead of 5 → RED.
  it('F1: a room with more rows than one page exports ALL pages', async () => {
    const client = mockClient([
      [decryptedRow(1, 'a'), decryptedRow(2, 'b'), decryptedRow(3, 'c')],
      [decryptedRow(4, 'd'), decryptedRow(5, 'e')],
    ]);

    const result = await exportRoomHistory(client, 'room-f1');

    expect(result.totalRows).toBe(5);
    expect(result.exportedRows).toBe(5);
    const parsed = JSON.parse(result.content) as { rows: Array<{ seq: number }> };
    expect(parsed.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  // F2: emit sealed bytes instead of decrypted body.
  // The plaintext body is 'hello'; sealed is 0xFF bytes. If export emits
  // sealed instead of plaintext, the body will be garbage, not 'hello' → RED.
  it('F2: exported body is the DECRYPTED plaintext, not sealed ciphertext', async () => {
    const client = mockClient([[decryptedRow(1, 'hello-world')]]);

    const result = await exportRoomHistory(client, 'room-f2');

    const parsed = JSON.parse(result.content) as { rows: Array<{ body: string | null }> };
    expect(parsed.rows[0]!.body).toBe('hello-world');
    // The body must NOT be the sealed bytes (which are 0xFF — invalid UTF-8
    // replacement chars, not the plaintext).
    expect(parsed.rows[0]!.body).not.toContain('\uFFFD');
  });

  // F3: replace undecryptable-row branch with bare `continue`.
  // A room with one unsealError row: if the branch is `continue`, the row is
  // skipped → no error entry AND failedRows=0 → RED on both.
  it('F3: an undecryptable row produces an error entry AND increments failedRows', async () => {
    const client = mockClient([
      [decryptedRow(1, 'ok'), failedRow(2, 'auth'), decryptedRow(3, 'ok2')],
    ]);

    const result = await exportRoomHistory(client, 'room-f3');

    // failedRows must be 1 (not 0 — `continue` would make it 0).
    expect(result.failedRows).toBe(1);
    expect(result.totalRows).toBe(3);

    const parsed = JSON.parse(result.content) as {
      rows: Array<{ seq: number; body: string | null; unsealError?: string }>;
    };
    // The error entry must be present at index 1 (not skipped by `continue`).
    const errorRow = parsed.rows.find((r) => r.seq === 2);
    expect(errorRow).toBeDefined();
    expect(errorRow!.body).toBeNull();
    expect(errorRow!.unsealError).toBe('auth');
  });
});

// ── F4: a row that was never decrypted must not count as exported ────────────
//
// Regression guard for the defect found in review: `plaintext` undefined with
// NO `unsealError` fell through to the decrypted branch, producing `body: null`
// counted as EXPORTED. A caller checking `failedRows === 0` then reads a lossy
// export as a clean one.
//
// F4 mutation: in export.ts `toExportRow`, drop the `row.plaintext === undefined`
// arm of the `undecrypted` ternary (leaving only `row.unsealError`) -> this
// suite must go RED on both the count and the row's `unsealError`.
describe('exportRoomHistory — never-decrypted rows (F4)', () => {
  it('counts a row with no plaintext and no unsealError as FAILED, not exported', async () => {
    const client = mockClient([[decryptedRow(1, 'hello'), neverDecryptedRow(2)]]);

    const result = await exportRoomHistory(client, 'r1');

    expect(result.totalRows).toBe(2);
    expect(result.exportedRows).toBe(1);
    expect(result.failedRows).toBe(1);

    const parsed = JSON.parse(result.content) as {
      rows: Array<{ seq: number; body: string | null; unsealError?: string }>;
      counts: { total: number; exported: number; failed: number };
    };
    expect(parsed.counts).toEqual({ total: 2, exported: 1, failed: 1 });

    const row2 = parsed.rows.find((r) => r.seq === 2);
    expect(row2).toBeDefined();
    expect(row2?.body).toBeNull();
    expect(row2?.unsealError).toBe('not-decrypted');
  });

  it('a whole room with no crypto provider reports zero exported, not a clean export', async () => {
    const client = mockClient([[neverDecryptedRow(1), neverDecryptedRow(2), neverDecryptedRow(3)]]);

    const result = await exportRoomHistory(client, 'r1');

    expect(result.totalRows).toBe(3);
    expect(result.exportedRows).toBe(0);
    expect(result.failedRows).toBe(3);
  });
});
