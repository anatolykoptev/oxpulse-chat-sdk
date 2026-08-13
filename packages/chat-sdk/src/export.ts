/**
 * export.ts — #294: Room history export, client-side and E2EE-native.
 *
 * The server cannot read `sframe-static` content, so export is not a server
 * feature. The client already decrypts every row through `list()`; this module
 * walks `list()` forward from the beginning of the room to exhaustion and
 * serialises the decrypted rows.
 *
 * Invariants:
 *   - A row that failed to unseal is exported as an explicit error entry
 *     carrying its `seq`, `msgId` and `unsealError` — NEVER skipped. Silent
 *     omission makes a lossy export indistinguishable from a complete one.
 *   - Pagination is followed to the end. A partial export is never returned as
 *     a complete one.
 *   - An AbortSignal is honoured BETWEEN PAGES only. It cannot interrupt a
 *     page already in flight: `ListArgs` carries no signal, so nothing reaches
 *     `list()`'s unseal loop, and on the path export almost always takes (no
 *     live subscription for the room) that loop is unbounded — it awaits
 *     `provider.unseal` per row with no deadline. A custom provider that hangs
 *     therefore hangs the export, and aborting does not free it. Do not read
 *     "cancellable" as stronger than this. See #312 for threading the signal
 *     through `list()`, which is the real fix and a public-API change.
 *   - Attachments are exported as the reference/URL embedded in the plaintext
 *     body, not the bytes.
 */

import type {
  ListArgs,
  ListResult,
  MessageRow,
  ExportRoomOptions,
  ExportMessageRow,
  ExportResult,
} from './types.js';

/**
 * Minimal client interface satisfied by {@link SDKChatClient}.
 * Export only needs `list()` — the client handles unseal, crypto_mode, and
 * on-chain/off-chain dispatch internally.
 */
export interface ExportClient {
  list(roomId: string, args?: ListArgs): Promise<ListResult>;
}

/**
 * Default page size for `list()` calls — this is the server's DEFAULT, not its
 * maximum. `LIST_DEFAULT_LIMIT = 200` / `LIST_MAX_LIMIT = 1_000` in the server's
 * `crates/sdk/src/messages/constants.rs`; the handler clamps at 1000. Raising
 * this to 1000 is legal and fewer round trips; 200 is kept as the conservative
 * default. (A comment claiming 200 was the cap is how the next person picks the
 * wrong number.)
 */
const DEFAULT_EXPORT_LIMIT = 200;

/**
 * Decode an ArrayBuffer to a UTF-8 string, or `null` when the bytes are absent.
 *
 * `fatal: false` is deliberate — one row of malformed plaintext must not abort a
 * whole export. The cost is that invalid byte sequences become U+FFFD rather
 * than raising, so a row that unsealed successfully but carries non-UTF-8 bytes
 * exports as replacement characters with NO `unsealError` and counts as
 * exported. That is the one lossiness this module does not flag; the wire
 * contract assumes UTF-8 text bodies, and a provider returning binary breaks
 * that assumption upstream of here.
 *
 * There is deliberately no try/catch: under `fatal: false` decode does not
 * throw, so a catch block would be dead code that reads like a guard.
 */
function decodeBody(buf: ArrayBuffer | undefined): string | null {
  if (buf === undefined) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/**
 * Map a {@link MessageRow} to an {@link ExportMessageRow}.
 *
 * A row with `unsealError` set (unseal failed) becomes an error entry:
 * `body` is `null`, `unsealError` is carried through. The row is NEVER skipped.
 */
function toExportRow(row: MessageRow): ExportMessageRow {
  // A row has THREE possible states, not two. Besides "decrypted" and "unseal
  // failed", `list()` can deliver a row with `plaintext` undefined and NO
  // `unsealError` — that is its no-crypto-provider path, where nothing ever
  // attempted a decrypt. Folding that into the decrypted branch exports
  // `body: null` and counts it as exported, so a client with no provider gets
  // `{ total: N, exported: N, failed: 0 }` and N empty bodies: a lossy export
  // indistinguishable from a complete one, which is the failure this export
  // exists to make impossible.
  const undecrypted: ExportMessageRow['unsealError'] =
    row.unsealError !== undefined
      ? row.unsealError
      : row.plaintext === undefined
        ? 'not-decrypted'
        : undefined;
  if (undecrypted !== undefined) {
    return {
      seq: row.seq,
      msgId: row.msgId,
      senderUid: row.senderUid,
      ts: row.createdAt,
      body: null,
      unsealError: undecrypted,
      threadRootMsgId: row.threadRootMsgId,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      editCount: row.editCount,
    };
  }
  return {
    seq: row.seq,
    msgId: row.msgId,
    senderUid: row.senderUid,
    ts: row.createdAt,
    body: decodeBody(row.plaintext),
    threadRootMsgId: row.threadRootMsgId,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    editCount: row.editCount,
  };
}

/**
 * Serialise export rows as canonical JSON.
 *
 * The JSON envelope carries the room id, the rows (each with `seq`, `msgId`,
 * `senderUid`, `ts`, `body`, and `unsealError` where present), and the counts.
 */
function toJSON(roomId: string, rows: ExportMessageRow[], counts: {
  total: number;
  exported: number;
  failed: number;
}): string {
  return JSON.stringify(
    {
      roomId,
      rows,
      counts,
    },
    null,
    2,
  );
}

/**
 * Serialise export rows as human-readable text.
 *
 * Each row is rendered as a header line (`[seq] senderUid @ ts`) followed by
 * the body, or an `[unseal error: …]` marker for undecryptable rows.
 *
 * The trailing summary line is load-bearing, not decoration: a caller that
 * writes `result.content` to a file and never reads `result.failedRows` would
 * otherwise have to scan every row and count error markers to notice the export
 * was lossy. The JSON envelope carries `counts` for the same reason.
 */
function toText(
  roomId: string,
  rows: ExportMessageRow[],
  counts: { total: number; exported: number; failed: number },
): string {
  const lines: string[] = [`# Room export: ${roomId}`, ''];
  for (const row of rows) {
    lines.push(`[${row.seq}] ${row.senderUid} @ ${row.ts}`);
    if (row.unsealError !== undefined) {
      lines.push(`  [unseal error: ${row.unsealError}]`);
    } else if (row.body !== null) {
      lines.push(`  ${row.body}`);
    } else {
      lines.push('  [empty]');
    }
    if (row.editedAt) lines.push(`  (edited ${row.editedAt})`);
    if (row.deletedAt) lines.push(`  (deleted ${row.deletedAt})`);
    lines.push('');
  }
  lines.push(
    `# Exported ${counts.exported}/${counts.total} rows (${counts.failed} failed)`,
  );
  return lines.join('\n');
}

/**
 * #294: Export a room's full history, client-side.
 *
 * Walks `client.list()` forward from the beginning of the room (`afterSeq: 0`)
 * to exhaustion, following the `next` thunk on each page. Every row — including
 * rows that failed to unseal — is serialised. An `AbortSignal` is honoured
 * between pages.
 *
 * @param client  Object satisfying {@link ExportClient} (e.g. {@link SDKChatClient}).
 * @param roomId  The room to export.
 * @param opts    Format, page size, and/or AbortSignal.
 * @returns       {@link ExportResult} with serialised content and row counts.
 * @throws        `DOMException` (name `'AbortError'`) if the signal is aborted
 *                between pages. Throws any `SDKChatError` from `list()`.
 */
export async function exportRoomHistory(
  client: ExportClient,
  roomId: string,
  opts?: ExportRoomOptions,
): Promise<ExportResult> {
  const format = opts?.format ?? 'json';
  const limit = opts?.limit ?? DEFAULT_EXPORT_LIMIT;
  const signal = opts?.signal;

  const rows: ExportMessageRow[] = [];
  let exportedRows = 0;
  let failedRows = 0;

  let result = await client.list(roomId, { afterSeq: 0, limit });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const row of result.items) {
      const exportRow = toExportRow(row);
      rows.push(exportRow);
      if (exportRow.unsealError !== undefined) {
        failedRows++;
      } else {
        exportedRows++;
      }
    }

    if (!result.hasNext || result.next === undefined) break;

    // Honour AbortSignal between pages — a large room's export is cancellable.
    if (signal?.aborted) {
      throw new DOMException('export aborted', 'AbortError');
    }

    result = await result.next();
  }

  const totalRows = rows.length;
  const counts = { total: totalRows, exported: exportedRows, failed: failedRows };

  const content =
    format === 'text'
      ? toText(roomId, rows, counts)
      : toJSON(roomId, rows, counts);

  return { format, content, totalRows, exportedRows, failedRows };
}
