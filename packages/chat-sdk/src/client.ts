/**
 * SDKChatClient — standalone npm package implementation.
 *
 * This is a standalone copy of the HTTP client for use by third-party
 * integrations that import @oxpulse/chat-sdk directly.  The SvelteKit
 * front-end uses web/src/lib/api/sdkChat.ts (same semantics, same wire
 * protocol) — kept separate to avoid pulling in SvelteKit build tooling.
 *
 * W4 skeleton: full implementation mirrors web/src/lib/api/sdkChat.ts.
 * Publishing to npmjs.org is deferred to W8 (embed widget wave).
 */

import {
  ensureWireCodecReady,
  encodeHttpBody,
  decodeHttpBody,
  setDictLoader,
  setDictBaseUrl,
  asWireBytes,
} from '@oxpulse/wire-codec';
import type { DictName } from '@oxpulse/wire-codec';
import type {
  SDKChatClientOptions,
  SendArgs,
  CryptoProvider,
  CryptoMode,
  E2EEOptions,
  SealContext,
  ListArgs,
  ListResult,
  MessageRow,
  MutationEvent,
  ReactionEvent,
  ReactionsResponse,
  ProductMeta,
  SubscribeArgs,
  Room,
  RoomSummary,
  Member,
  CreateRoomArgs,
  UpdateRoomArgs,
  UpdateMessageArgs,
  PinnedMessage,
  PresenceUser,
  OptimisticHandle,
  BatchAppendItem,
  RoomVisibility,
} from './types.js';
import { SDKChatBatchError, SDKChatError } from './errors.js';
import { createSFrameProvider } from './sframe.js';
import { RoomDecryptChain } from './room-decrypt-chain.js';
import { ReplayError } from 'sframe-ratchet/chat';
import { enqueue, dequeue, pending } from './outbox.js';
import { sendFile as sendFileHelper, type SendFileArgs } from './attachments.js';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  httpStatusToCode,
  backoffMs,
  dispatchTransient,
} from './utils.js';

// ─── Wire DTOs (snake_case) ───────────────────────────────────────────────────

interface RoomDTO {
  app_id: string;
  room_id: string;
  title: string | null;
  product_ref: string | null;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  metadata: Record<string, unknown>;
  members: MemberDTO[];
  visibility?: RoomVisibility;  // optional: pre-open-rooms servers omit this field
}

interface MemberDTO {
  app_id: string;
  room_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  last_read_seq: number;
  active: boolean;
}

function dtoToRoom(dto: RoomDTO): Room {
  return {
    appId: dto.app_id,
    roomId: dto.room_id,
    title: dto.title,
    productRef: dto.product_ref,
    createdBy: dto.created_by,
    createdAt: dto.created_at,
    archivedAt: dto.archived_at,
    metadata: dto.metadata,
    members: dto.members.map(dtoToMember),
    // Server default is 'member'; pre-open-rooms servers omit visibility.
    visibility: dto.visibility ?? 'member',
  };
}

function dtoToMember(dto: MemberDTO): Member {
  return {
    appId: dto.app_id,
    roomId: dto.room_id,
    userId: dto.user_id,
    role: dto.role as Member['role'],
    joinedAt: dto.joined_at,
    lastReadSeq: dto.last_read_seq,
    active: dto.active,
  };
}

// ─── Shared row mapper (M5 DRY fix) ──────────────────────────────────────────

/**
 * Map a raw wire-DTO row (snake_case) to a `MessageRow` (camelCase).
 * Used by list(), thread list, and the SSE onmessage handler.
 * M5 fix: extracted from two duplicated sites to prevent mapper drift.
 */
function rowToMessageRow(row: {
  seq: number;
  msg_id: string;
  sender_uid: string;
  sealed_b64: string;
  created_at: string;
  thread_root_msg_id?: string | null;
  product_ref?: string | null;
  product_meta?: import('./types.js').ProductMeta | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  edit_count?: number | null;
}): MessageRow {
  return {
    seq: row.seq,
    msgId: row.msg_id,
    senderUid: row.sender_uid,
    sealed: base64ToArrayBuffer(row.sealed_b64),
    createdAt: row.created_at,
    threadRootMsgId: row.thread_root_msg_id ?? null,
    productRef: row.product_ref ?? null,
    productMeta: row.product_meta ?? null,
    editedAt: row.edited_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    editCount: row.edit_count ?? 0,
  };
}

// ─── E2EE helpers ────────────────────────────────────────────────────────────

/**
 * Classify an unseal failure into a stable error code.
 * Used by list() and subscribe() to populate MessageRow.unsealError.
 */
function classifyUnsealError(err: unknown): 'replay' | 'auth' | 'unknown' {
  if (err instanceof ReplayError) return 'replay';
  // AEADAuthError from sframe-ratchet has code 'AEAD_AUTH_FAIL'
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'AEAD_AUTH_FAIL') {
    return 'auth';
  }
  // WebCrypto throws DOMException with name 'OperationError' on AEAD failure
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'OperationError') {
    return 'auth';
  }
  return 'unknown';
}

// ─── Phase 2: crypto_mode helpers ────────────────────────────────────────────

/**
 * Validate a server-emitted crypto_mode against the client-configured expectation.
 * Returns the resolved mode to use for this session.
 *
 * SEC-CR-1695-03: validated cast — rejects unknown crypto_mode values fail-CLOSED.
 * SEC-CR-1695-02: calls onPoison() before throwing so the client can be poisoned
 *   before the error propagates (guarantees no subsequent sends).
 * SEC-CR-1694: downgrade defense — client's policy view is authoritative.
 *
 * @param configured    Client-configured expectation (null = auto-detect).
 * @param received      Raw string from server (undefined = not emitted).
 * @param activeCryptoMode Current cached mode for this session.
 * @param onPoison      Called (before throw) when mismatch or unknown value detected.
 */
function validateAndResolveCryptoMode(
  configured: CryptoMode | null,
  received: string | undefined,
  activeCryptoMode: CryptoMode | null,
  onPoison: () => void,
): CryptoMode | null {
  if (received === undefined) {
    // Server did not emit crypto_mode — preserve current active.
    return activeCryptoMode;
  }
  // SEC-CR-1695-03: validated cast — only known enum values accepted.
  if (received !== 'sframe-static' && received !== 'plaintext') {
    onPoison();
    console.error('[chat-sdk] crypto_mode_unknown', { received });
    throw new SDKChatError(
      'crypto_mode_mismatch',
      `unknown crypto_mode value from server: ${JSON.stringify(received)}`,
    );
  }
  const normalized: CryptoMode = received;
  if (configured !== null && configured !== normalized) {
    // SEC-CR-1695-02: poison BEFORE throw so no subsequent send can succeed.
    onPoison();
    console.error('[chat-sdk] crypto_mode_mismatch', { configured, received: normalized });
    throw new SDKChatError(
      'crypto_mode_mismatch',
      `crypto_mode mismatch: configured=${configured} received=${normalized}`,
    );
  }
  return normalized;
}

/**
 * Plaintext mode: server-side sealed_b64 carries UTF-8 bytes (per AD-5).
 * `rowToMessageRow` (upstream) already base64-decodes sealed_b64 into
 * `row.sealed: ArrayBuffer`, so we just alias bytes into the `plaintext`
 * field. The actual UTF-8 decode happens at the call site via TextDecoder.
 *
 * Invariant: `row.sealed` is ArrayBuffer at this point — assert defensively
 * to catch any future refactor of rowToMessageRow that keeps sealed as
 * base64 string (would silently corrupt plaintext field).
 *
 * NOTE: this is an ALIAS not a DECODE; the prior `aliasSealedAsPlaintext` name
 * was misleading and has been renamed.
 */
function aliasSealedAsPlaintext(row: MessageRow): MessageRow {
  if (!(row.sealed instanceof ArrayBuffer)) {
    throw new Error(
      'plaintext mode invariant violated: row.sealed must be ArrayBuffer ' +
      'after rowToMessageRow — refactor regression detected'
    );
  }
  return { ...row, plaintext: row.sealed };
}

// ─── Client ───────────────────────────────────────────────────────────────────

const DEFAULT_MIN_COMPRESS_BYTES = 256;

/**
 * Server-side maximum number of user_ids accepted in a single bulk
 * POST /api/sdk/rooms/{room_id}/members request.
 * Mirrors `BULK_ADD_MAX = 500` in crates/sdk/src/rooms.rs:78.
 */
export const BATCH_ADD_MEMBERS_CHUNK = 500;

export class SDKChatClient {
  readonly #baseUrl: string;
  readonly #jwt: string;
  readonly #compression: 'none' | 'auto' | 'dict';
  readonly #minCompressBytes: number;
  readonly #dictHint: DictName;
  #ready: Promise<void> | null = null;
  readonly #testNoSleep: boolean;
  /**
   * W6 E2EE: crypto provider instance (null when e2ee not configured).
   * Initialized eagerly in the constructor from opts.e2ee.
   */
  readonly #cryptoProvider: CryptoProvider | null;
  /**
   * W6 E2EE: per-room serial decrypt queue for subscribe(). Each onmessage
   * decrypt is appended onto the room's chain to preserve in-order unseal within
   * a room (the SFrame ratchet/replay window desyncs on out-of-order unseal).
   * Independent per room — one stuck unseal in roomA does NOT stall roomB.
   * Refcounted so multiple concurrent subscribers of one roomId (widget remount,
   * visibility re-subscribe, reconnect race) share one serial chain and teardown
   * of any single subscriber does not destroy it — see room-decrypt-chain.ts.
   */
  readonly #decryptChain: RoomDecryptChain = new RoomDecryptChain();
  /**
   * W6 E2EE: guard to warn once when sendOptimistic is called with e2ee configured.
   * Callers should use sendTextOptimistic instead.
   */
  #e2eeOptimisticWarnedOnce = false;

  /**
   * Phase 2: client-configured crypto_mode expectation (from constructor options).
   * When non-null, every server-emitted crypto_mode is validated against this value.
   * null = auto-detect from server (no validation).
   *
   * SEC-CR-001: when an e2ee provider is configured this defaults to 'sframe-static'
   * (never null) so downgrade protection is default-on — see the constructor.
   */
  readonly #cryptoMode: CryptoMode | null;

  /**
   * Phase 2 + SEC-CR-001: active (server-discovered) crypto_mode, PER ROOM.
   * Populated on the first list() or subscribe() prelude for a room that carries a
   * crypto_mode field. Absent key = not yet discovered for that room.
   *
   * Scoped per-roomId (not client-wide) so one room's discovery/mismatch cannot
   * change another room's mode. #cryptoMode (the configured expectation) stays
   * client-level; only the discovered mode is per-room.
   */
  readonly #activeCryptoModeByRoom = new Map<string, CryptoMode>();

  /**
   * SEC-CR-1695-02 + SEC-CR-001: set of roomIds poisoned by a crypto_mode_mismatch
   * or unknown crypto_mode. A poisoned room fails send/list/subscribe CLOSED; OTHER
   * rooms on the same client keep working. Scoped per-room (not a client-wide flag)
   * so a malicious server downgrading room A cannot brick legitimate sibling room B
   * (DoS-amplification defense). Callers recreate the client to retry a poisoned room.
   */
  readonly #poisonedRooms = new Set<string>();

  constructor(opts: SDKChatClientOptions) {
    if (opts.jwt.startsWith('Bearer ')) {
      throw new SDKChatError(
        'invalid_args',
        'jwt must not include the "Bearer " prefix',
      );
    }
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.#jwt = opts.jwt;
    this.#compression = opts.compression ?? 'none';
    this.#minCompressBytes = opts.minCompressBytes ?? DEFAULT_MIN_COMPRESS_BYTES;
    this.#dictHint = opts.dictHint ?? 'zstd-dict-ru-v1';
    this.#testNoSleep = opts._testNoSleep ?? false;

    // SEC-CR-001 (CWE-757 downgrade defense): an e2ee provider + an explicit
    // cryptoMode:'plaintext' is a contradictory config — an encryption provider
    // AND an explicit opt-out of encryption. Fail CLOSED at construct rather than
    // honor a downgrade a caller almost certainly did not intend.
    const hasE2ee = opts.e2ee !== undefined;
    if (hasE2ee && opts.cryptoMode === 'plaintext') {
      throw new SDKChatError(
        'invalid_args',
        'cryptoMode:"plaintext" is incompatible with a configured e2ee provider — ' +
        'omit cryptoMode (defaults to "sframe-static") or remove the e2ee option',
      );
    }
    // Phase 2 + SEC-CR-001: store the configured crypto_mode expectation.
    // Downgrade protection is DEFAULT-ON: with an e2ee provider present, default to
    // 'sframe-static' (NOT null) so a server-emitted crypto_mode:'plaintext' becomes a
    // poison-mismatch (throw + tear down + refuse to send) instead of an accepted
    // silent downgrade. Without an e2ee provider, plaintext is a valid intended mode
    // (null = auto-detect from server, no validation).
    this.#cryptoMode = opts.cryptoMode ?? (hasE2ee ? 'sframe-static' : null);

    // W6 E2EE: initialize crypto provider from e2ee option.
    if (opts.e2ee !== undefined) {
      const e2ee: E2EEOptions = opts.e2ee;
      if (e2ee.provider === 'sframe') {
        // Discriminated union guarantees e2ee.getKey is present here.
        this.#cryptoProvider = createSFrameProvider({ getKey: e2ee.getKey });
      } else if (typeof e2ee.provider === 'object' && 'seal' in e2ee.provider) {
        // Custom CryptoProvider instance supplied directly.
        this.#cryptoProvider = e2ee.provider;
      } else {
        throw new SDKChatError(
          'invalid_args',
          'e2ee.provider must be "sframe" or a CryptoProvider instance',
        );
      }
    } else {
      this.#cryptoProvider = null;
    }

    if (this.#compression !== 'none') {
      // Configure loader before ensureWireCodecReady so dicts are preloaded correctly.
      if (opts.dictLoader !== undefined) {
        setDictLoader(opts.dictLoader);
      } else if (opts.dictBaseUrl !== undefined) {
        setDictBaseUrl(opts.dictBaseUrl);
      }
      // Kick off zstd init + dict preload lazily. Awaited before first send.
      this.#ready = ensureWireCodecReady();
    }
  }

  /** Encode payload bytes for POST /api/sdk/messages per the configured compression mode.
   *  Returns a string for plain JSON (Content-Type: application/json) or
   *  Uint8Array for compressed frames (Content-Type: application/octet-stream). */
  async #encodeBody(payload: Record<string, unknown>): Promise<string | Uint8Array> {
    if (this.#compression === 'none') {
      return JSON.stringify(payload);
    }
    // Ensure zstd is ready before first compressed send.
    if (this.#ready !== null) {
      await this.#ready;
      this.#ready = null;
    }
    const jsonStr = JSON.stringify(payload);
    const enc = new TextEncoder();
    const jsonBytes = enc.encode(jsonStr);
    if (jsonBytes.length < this.#minCompressBytes) {
      // Below threshold — fall back to plain JSON regardless of mode.
      return jsonStr;
    }
    if (this.#compression === 'dict') {
      // encodeHttpBody falls back to dictless 0xC6 automatically if dict not loaded.
      return encodeHttpBody(jsonBytes, this.#dictHint);
    }
    // 'auto': dictless 0xC6
    return encodeHttpBody(jsonBytes);
  }

  /**
   * Encode a payload to the bytes that would be sent on the wire, without sending.
   * Mirrors the encoding _encodeBody applies to POST /api/sdk/messages.
   */
  async encodeEnvelope(payload: unknown): Promise<string | Uint8Array> {
    return this.#encodeBody(payload as Record<string, unknown>);
  }

  /**
   * Decode bytes received from the server back to the JSON payload.
   * Server responses are always plain JSON; this also handles wire-codec
   * compressed frames for completeness (round-trip with encodeEnvelope).
   *
   * Note: #compression governs OUTGOING encoding only. A server may send a
   * compressed frame (0xC6/0xC7) regardless of the client's compression setting.
   * decodeEnvelope checks the first byte directly and initializes zstd if needed.
   */
  async decodeEnvelope(bytes: Uint8Array | string): Promise<unknown> {
    if (typeof bytes === 'string') {
      return JSON.parse(bytes) as unknown;
    }
    if (bytes.length === 0) throw new SDKChatError('server_error', 'decodeEnvelope: empty input');
    const first = bytes[0];
    if (first === 0x7b || first === 0x5b) {
      // Plain JSON bytes — no zstd needed.
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }
    // Compressed frame (0xC6/0xC7): ensure zstd is ready regardless of #compression setting.
    // #compression controls outgoing encoding only; server may compress responses independently.
    if (first === 0xc6 || first === 0xc7) {
      if (this.#ready !== null) {
        await this.#ready;
        this.#ready = null;
      } else {
        // #compression is 'none' — zstd not pre-initialized; initialize on demand.
        await ensureWireCodecReady();
      }
    }
    return decodeHttpBody(asWireBytes(bytes));
  }

  // ── W4: Public getters for attachment helpers ──────────────────────────────
  /** Base URL without trailing slash. Used by attachment helpers. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** JWT (without Bearer prefix). Used by attachment helpers. */
  get jwt(): string {
    return this.#jwt;
  }

  // ── Phase 2 + SEC-CR-001: per-room crypto_mode helpers ─────────────────────

  /**
   * SEC-CR-001: fail CLOSED for a single poisoned room. A room poisoned by a prior
   * crypto_mode_mismatch refuses send/list/subscribe; sibling rooms are unaffected.
   */
  #assertRoomNotPoisoned(roomId: string): void {
    if (this.#poisonedRooms.has(roomId)) {
      throw new SDKChatError(
        'crypto_mode_poisoned',
        `room ${roomId} was poisoned by a prior crypto_mode_mismatch; recreate the client instance to retry this room`,
      );
    }
  }

  /**
   * SEC-CR-001: validate a server-emitted crypto_mode for ONE room against the
   * client-configured expectation (#cryptoMode) and cache the resolved mode for that
   * room. On mismatch/unknown, validateAndResolveCryptoMode poisons ONLY this room
   * (via the onPoison callback) and rethrows — so a downgrade signal for one room can
   * never brick a sibling room, while each room STILL rejects its own downgrade.
   * Returns the resolved mode (null = still undiscovered for this room).
   */
  #resolveRoomCryptoMode(roomId: string, received: string | undefined): CryptoMode | null {
    const resolved = validateAndResolveCryptoMode(
      this.#cryptoMode,
      received,
      this.#activeCryptoModeByRoom.get(roomId) ?? null,
      () => { this.#poisonedRooms.add(roomId); },
    );
    if (resolved !== null) {
      this.#activeCryptoModeByRoom.set(roomId, resolved);
    }
    return resolved;
  }

  /**
   * W6 E2EE: encrypt text and send as a sealed message.
   *
   * Requires e2ee to be configured in the constructor options.
   * Throws SDKChatError('unsupported') when e2ee is not configured.
   *
   * Internally: UTF-8 encodes text → seals via CryptoProvider → calls send().
   *
   * @param roomId   Target room.
   * @param args     senderUid + text string to encrypt and send.
   */
  async sendText(
    roomId: string,
    args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: unknown },
  ): Promise<{ seq: number; msgId: string }> {
    // SEC-CR-1695-02 + SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior mismatch.
    this.#assertRoomNotPoisoned(roomId);

    // AD-1 downgrade defense (fail-closed backstop): refuse to send if e2ee is
    // configured but no crypto_mode is known for this room. SEC-CR-001 makes #cryptoMode
    // default to 'sframe-static' whenever an e2ee provider is present, so in normal
    // operation knownMode is never null here — this guard remains as a defense-in-depth
    // invariant that a future refactor cannot silently seal-blind or downgrade past.
    const knownMode = this.#activeCryptoModeByRoom.get(roomId) ?? this.#cryptoMode;
    if (knownMode === null && this.#cryptoProvider !== null) {
      throw new SDKChatError(
        'crypto_mode_undiscovered',
        'send before discovering server crypto_mode is forbidden when e2ee is configured; ' +
        'call list() or subscribe() first OR set options.cryptoMode explicitly',
      );
    }

    const plainBytes = new TextEncoder().encode(args.text).buffer as ArrayBuffer;

    // Phase 2: plaintext mode — skip seal, send UTF-8 bytes directly.
    // Prefer this room's discovered mode over #cryptoMode (the configured expectation).
    const effectiveMode = this.#activeCryptoModeByRoom.get(roomId) ?? this.#cryptoMode;
    if (effectiveMode === 'plaintext') {
      return this.send(roomId, {
        senderUid: args.senderUid,
        sealed: plainBytes,
        msgId: args.msgId,
        threadRootMsgId: args.threadRootMsgId,
        productRef: args.productRef,
        productMeta: args.productMeta,
      });
    }

    if (this.#cryptoProvider === null) {
      throw new SDKChatError(
        'unsupported',
        'sendText requires e2ee config — pass e2ee option to SDKChatClient constructor',
      );
    }
    const ctx: SealContext = { roomId, senderUid: args.senderUid };
    const sealed = await this.#cryptoProvider.seal(plainBytes, ctx);
    return this.send(roomId, {
      senderUid: args.senderUid,
      sealed,
      msgId: args.msgId,
      threadRootMsgId: args.threadRootMsgId,
      productRef: args.productRef,
      productMeta: args.productMeta,
    });
  }

  async send(roomId: string, args: SendArgs): Promise<{ seq: number; msgId: string }> {
    // SEC-CR-1695-02 + SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior mismatch.
    this.#assertRoomNotPoisoned(roomId);
    const msgId = args.msgId ?? crypto.randomUUID();
    const payload: Record<string, unknown> = {
      room_id: roomId,
      msg_id: msgId,
      sender_uid: args.senderUid,
      sealed_b64: arrayBufferToBase64(args.sealed),
    };
    if (args.threadRootMsgId !== undefined) {
      payload['thread_root_msg_id'] = args.threadRootMsgId;
    }
    if (args.productRef !== undefined) {
      payload['product_ref'] = args.productRef;
    }
    if (args.productMeta !== undefined) {
      payload['product_meta'] = args.productMeta;
    }
    const body = await this.#encodeBody(payload);

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
          Authorization: `Bearer ${this.#jwt}`,
        },
        body: body as BodyInit,
      });
    } catch (err) {
      throw new SDKChatError('network', String(err));
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `send failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const json = (await resp.json()) as { seq: number; msg_id: string };
    return { seq: json.seq, msgId: json.msg_id };
  }

  /**
   * Fetch + parse + crypto_mode-validate a single page of rows WITHOUT unsealing.
   * Shared by list() (which then unseals / plaintext-aliases + builds pagination)
   * and the subscribe() reconnect-replay path (which appends each unseal onto the
   * room's serial decrypt chain — SEC-CR-14-01 — instead of unsealing off-chain).
   * Returns rows with `sealed` intact (no `plaintext` / `unsealError` set yet).
   *
   * Keeps the fail-closed poison check + crypto_mode validation + malformed-page
   * guard in ONE place so both the public list() and the reconnect replay validate
   * the server response identically.
   */
  async #fetchRows(
    roomId: string,
    args: ListArgs,
  ): Promise<{ rawItems: MessageRow[]; hasMore: boolean; nextCursor: number | null }> {
    // SEC-CR-1695-02 + SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior mismatch.
    this.#assertRoomNotPoisoned(roomId);
    const params = new URLSearchParams({
      room_id: roomId,
      after_seq: String(args.afterSeq ?? 0),
      limit: String(args.limit ?? 50),
    });
    if (args.beforeSeq !== undefined) {
      params.set('before_seq', String(args.beforeSeq));
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages?${params}`, {
        headers: { Authorization: `Bearer ${this.#jwt}` },
      });
    } catch (err) {
      throw new SDKChatError('network', String(err));
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `list failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const json = (await resp.json()) as {
      items: Array<{
        seq: number;
        msg_id: string;
        sender_uid: string;
        sealed_b64: string;
        created_at: string;
        thread_root_msg_id?: string | null;
        product_ref?: string | null;
        product_meta?: ProductMeta | null;
        edited_at?: string | null;
        deleted_at?: string | null;
        edit_count?: number;
      }>;
      has_more: boolean;
      next_cursor: number | null;
      /** Phase 2: server-emitted crypto_mode for this room. */
      crypto_mode?: string;
    };

    // Phase 2 + SEC-CR-001: validate and cache crypto_mode from list response, PER ROOM.
    // Throws SDKChatError('crypto_mode_mismatch') + poisons ONLY this room on mismatch/unknown.
    this.#resolveRoomCryptoMode(roomId, json.crypto_mode);

    if (json.has_more && json.next_cursor == null) {
      throw new SDKChatError(
        'server_error',
        'server returned has_more=true but next_cursor=null',
      );
    }

    return {
      rawItems: json.items.map(rowToMessageRow),
      hasMore: json.has_more,
      nextCursor: json.next_cursor,
    };
  }

  async list(roomId: string, args: ListArgs = {}): Promise<ListResult> {
    const { rawItems, hasMore, nextCursor } = await this.#fetchRows(roomId, args);

    // Phase 2 + W6 E2EE: dispatch based on active crypto_mode.
    // - plaintext: base64-decode → UTF-8 string in plaintext field (no unseal).
    // - sframe-static (or not yet discovered): use CryptoProvider if configured.
    let items: MessageRow[];
    if (this.#activeCryptoModeByRoom.get(roomId) === 'plaintext') {
      // Plaintext mode: sealed is raw UTF-8 bytes — just expose as plaintext.
      items = rawItems.map(aliasSealedAsPlaintext);
    } else if (this.#cryptoProvider !== null) {
      // W6 E2EE: post-decrypt rows when crypto provider is configured.
      // Failed decryptions are PRESERVED with unsealError set (not dropped) so
      // pagination counts remain accurate and callers can detect potential attacks.
      const provider = this.#cryptoProvider;
      const decrypted: MessageRow[] = [];
      for (const row of rawItems) {
        const ctx: SealContext = { roomId, senderUid: row.senderUid };
        try {
          const plaintext = await provider.unseal(row.sealed, ctx);
          decrypted.push({ ...row, plaintext });
        } catch (err) {
          // Preserve the row with unsealError — do NOT drop it (M2 fix).
          // Dropped rows break pagination (caller sees fewer items than server sent)
          // and mask attacks (tampered/replayed rows vanish silently).
          console.warn('[chat-sdk] list(): unseal failed for seq', row.seq, err);
          decrypted.push({ ...row, unsealError: classifyUnsealError(err) });
        }
      }
      items = decrypted;
    } else {
      items = rawItems;
    }

    const result: ListResult = { items, hasNext: hasMore };
    if (hasMore && nextCursor != null) {
      const cursor = nextCursor;
      // Direction-aware thunk: forward paging passes cursor as afterSeq;
      // backward paging passes cursor as beforeSeq.
      result.next =
        args.beforeSeq != null
          ? () => this.list(roomId, { ...args, beforeSeq: cursor })
          : () => this.list(roomId, { ...args, afterSeq: cursor });
    }
    return result;
  }

  /**
   * Append a per-room serial decrypt task onto the room's #decryptChain: unseal
   * `mappedRow` (5s timeout) then deliver via `onMessage`. The task NEVER rejects
   * (unseal failure → unsealError; a throwing onMessage is caught) so a link can't
   * poison the room's chain. Shared by the live subscribe() SSE stream AND the
   * reconnect replay path so BOTH serialize on the SAME queue — at most one unseal
   * per room is ever in flight, across the reconnect boundary too (SEC-CR-14-01).
   *
   * No-op unless a crypto provider is configured (callers already gate on this;
   * the guard keeps the method self-contained). RoomDecryptChain.append gates on a
   * live subscriber, so a task for a torn-down room is dropped, not run.
   */
  #appendDecryptTask(
    roomId: string,
    mappedRow: MessageRow,
    onMessage: (row: MessageRow) => void,
  ): void {
    const provider = this.#cryptoProvider;
    if (provider === null) return;
    this.#decryptChain.append(roomId, async () => {
      const ctx: SealContext = { roomId, senderUid: mappedRow.senderUid };
      const timeoutMs = 5000;
      const timeoutPromise = new Promise<ArrayBuffer>((_res, rej) =>
        setTimeout(() => rej(new Error('unseal timeout')), timeoutMs),
      );
      let out: MessageRow;
      try {
        const plaintext = await Promise.race([
          provider.unseal(mappedRow.sealed, ctx),
          timeoutPromise,
        ]);
        out = { ...mappedRow, plaintext };
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'unseal timeout';
        console.warn('[chat-sdk] decrypt task: unseal failed for seq', mappedRow.seq, err);
        out = { ...mappedRow, unsealError: isTimeout ? 'unknown' : classifyUnsealError(err), plaintext: undefined };
      }
      // Deliver exactly once, AFTER the try/catch, so a throwing caller callback
      // neither re-delivers the row as an unseal error nor rejects the link (which
      // would wedge the room's serial chain).
      try {
        onMessage(out);
      } catch (cbErr) {
        console.warn('[chat-sdk] decrypt task: onMessage threw for seq', mappedRow.seq, cbErr);
      }
    });
  }

  async #fetchSubscribeTicket(roomId: string, afterSeq: number): Promise<string> {
    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages/subscribe-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#jwt}`,
        },
        body: JSON.stringify({ room_id: roomId, after_seq: afterSeq }),
      });
    } catch (err) {
      throw new SDKChatError('network', `subscribe-ticket fetch failed: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `subscribe-ticket HTTP ${resp.status}`,
        resp.status,
      );
    }
    const body = (await resp.json()) as { ticket: string };
    return body.ticket;
  }

  subscribe(roomId: string, args: SubscribeArgs): () => void {
    // SEC-CR-1695-02 + SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior mismatch.
    this.#assertRoomNotPoisoned(roomId);
    let destroyed = false;
    let lastSeq = 0;
    let es: EventSource | null = null;

    // W6 E2EE: register this subscriber on the room's shared serial decrypt
    // chain. Refcounted so a co-subscriber (widget remount / reconnect race)
    // sharing this roomId keeps the chain alive until the LAST teardown.
    // Gated on cryptoProvider (readonly) so acquire/release stay balanced and
    // plaintext rooms never touch the chain (matching prior behaviour).
    // chainReleased makes teardown idempotent: a double-invoked unsubscribe must
    // release this subscriber's refcount at most once (else it would decrement a
    // co-subscriber's share and prematurely destroy the shared chain).
    let chainReleased = false;
    if (this.#cryptoProvider !== null) {
      this.#decryptChain.acquire(roomId);
    }

    const attach = (ticket: string) => {
      if (destroyed) return;
      const url = `${this.#baseUrl}/api/sdk/messages/subscribe?ticket=${encodeURIComponent(ticket)}&after_seq=${lastSeq}`;
      es = new EventSource(url);

      // Phase 2: parse `event: connected` prelude emitted by server (Wave 3.2).
      // Carries crypto_mode for the room. Validate against configured option and
      // cache for the session. Mismatch → throw + destroy stream (SEC-CR-1694).
      es.addEventListener('connected', (ev: Event) => {
        // Consistent with onmessage/onerror/shutdown: ignore a late prelude after
        // teardown so a torn-down subscription cannot write this room's
        // #activeCryptoModeByRoom entry (which subsequent list()/send() would read).
        if (destroyed) return;
        const msgEv = ev as MessageEvent;
        try {
          const data = JSON.parse(msgEv.data as string) as { crypto_mode?: string };
          // SEC-CR-001: resolve + cache PER ROOM; mismatch poisons ONLY this room.
          this.#resolveRoomCryptoMode(roomId, data.crypto_mode);
        } catch (err) {
          // crypto_mode_mismatch — surface to caller, then fully tear down THIS
          // subscription (closes the stream AND releases the decrypt-chain
          // refcount, so the mismatch does not leak the room's chain entry).
          if (!destroyed) reportError(err);
          teardownSubscriber();
        }
      });

      es.onmessage = (ev) => {
        // Consistent with onerror/shutdown: ignore frames after teardown so a
        // queued message dispatched post-close cannot append a decrypt onto a
        // released subscriber's chain.
        if (destroyed) return;
        try {
          const data = JSON.parse(ev.data) as {
            type?: string;
            seq: number;
            msg_id: string;
            sender_uid: string;
            sealed_b64: string;
            created_at: string;
            thread_root_msg_id?: string | null;
            product_ref?: string | null;
            product_meta?: ProductMeta | null;
            edited_at?: string | null;
            deleted_at?: string | null;
            edit_count?: number | null;
          };
          // W6: dispatch transient events that arrive on the default channel.
          if (data.type && data.type !== 'message') {
            // T18: roster invalidation signal — carries no data, just a re-fetch trigger.
            if (data.type === 'roster') {
              args.onRosterSignal?.();
              return;
            }
            dispatchTransient(data.type, data as unknown as Record<string, unknown>, args);
            return;
          }
          lastSeq = data.seq;
          const mappedRow = rowToMessageRow(data);
          // Phase 2: plaintext mode — deliver directly with UTF-8 decode.
          if (this.#activeCryptoModeByRoom.get(roomId) === 'plaintext') {
            args.onMessage(aliasSealedAsPlaintext(mappedRow));
            return;
          }
          // W6 E2EE: async decrypt for subscribe — per-room serial chain to
          // preserve message order within a room while not stalling other rooms.
          // 5s timeout prevents a single stuck unseal from blocking all subsequent
          // messages. Shared with the reconnect replay path (SEC-CR-14-01) so live
          // and replayed frames serialize on ONE queue.
          if (this.#cryptoProvider !== null) {
            this.#appendDecryptTask(roomId, mappedRow, args.onMessage);
          } else {
            args.onMessage(mappedRow);
          }
        } catch {
          // Malformed frame — ignore.
        }
      };

      // W6: named SSE events for transient channel.
      const transientTypes = ['typing', 'presence', 'read_receipt'] as const;
      for (const evType of transientTypes) {
        es.addEventListener(evType, (ev: Event) => {
          const msgEv = ev as MessageEvent;
          try {
            const data = JSON.parse(msgEv.data as string) as Record<string, unknown>;
            dispatchTransient(evType, data, args);
          } catch {
            // Malformed frame — ignore.
          }
        });
      }

      // W2 fix-pass + W3: mutation events (edit/delete/pin/unpin/reaction_add/reaction_remove)
      // arrive as named SSE events on the `sdk_message_log_mutation` channel.
      if (args.onMutation || args.onReaction) {
        es.addEventListener('mutation', (ev: Event) => {
          const msgEv = ev as MessageEvent;
          try {
            const data = JSON.parse(msgEv.data as string) as {
              app_id: string;
              room_id: string;
              msg_id: string;
              op: string;
              edited_at?: string;
              edit_count?: number;
              deleted_at?: string;
              pinned_by?: string;
              reaction?: string;
              user_id?: string;
            };
            // W3: dispatch reaction events to onReaction if registered.
            if (
              args.onReaction &&
              (data.op === 'reaction_add' || data.op === 'reaction_remove') &&
              data.reaction !== undefined &&
              data.user_id !== undefined
            ) {
              const reactionEv: ReactionEvent = {
                appId: data.app_id,
                roomId: data.room_id,
                msgId: data.msg_id,
                op: data.op,
                reaction: data.reaction,
                userId: data.user_id,
              };
              args.onReaction(reactionEv);
              return;
            }
            // W2: dispatch non-reaction mutations to onMutation.
            if (args.onMutation) {
              const mutation: MutationEvent = {
                appId: data.app_id,
                roomId: data.room_id,
                msgId: data.msg_id,
                op: data.op,
                editedAt: data.edited_at,
                editCount: data.edit_count,
                deletedAt: data.deleted_at,
                pinnedBy: data.pinned_by,
              };
              args.onMutation(mutation);
            }
          } catch {
            // Malformed frame — ignore.
          }
        });
      }

      // MAJOR #5: server graceful shutdown — stream.rs Phase-2 emits
      // `event: shutdown\ndata: server_restart` before closing the stream.
      // Contract: client reconnects immediately (no backoff) and replays from
      // lastSeq so no messages are lost across graceful server restarts.
      // Without this handler the stream close fires onerror with a 800-1200ms
      // exponential-backoff delay; with it we skip the delay.
      es.addEventListener('shutdown', () => {
        es?.close();
        es = null;
        if (destroyed) return;
        // Immediate reconnect: replay from lastSeq then re-attach.
        reconnectImmediate();
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (destroyed) return;
        reconnect(0);
      };
    };

    // dispatchTransient imported from utils.ts — single source of truth
    // shared with web/src/lib/api/sdkChat.ts. See packages/chat-sdk/src/utils.ts.

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const reportError = (err: unknown) => {
      if (!args.onError) return;
      const sdkErr =
        err instanceof SDKChatError
          ? err
          : new SDKChatError('network', `subscribe internal error: ${String(err)}`);
      args.onError(sdkErr);
    };

    // Replay messages missed while the stream was down, then advance lastSeq.
    // SEC-CR-14-01: when e2ee is active the replay unseal is routed through the
    // room's #decryptChain (the SAME serial queue as the live stream) so it can
    // never run concurrently with a streamed unseal still in flight from before
    // the stream closed — the ratchet / replay-window desync the chain exists to
    // prevent. Mirrors list()'s crypto_mode dispatch exactly (plaintext-alias /
    // unseal / raw); plaintext + no-e2ee rooms have no chain and deliver directly
    // (unchanged). Shared by reconnectImmediate() and reconnect() so both fix the
    // bypass identically.
    const replayMissed = async () => {
      try {
        const { rawItems } = await this.#fetchRows(roomId, { afterSeq: lastSeq });
        // Teardown may have raced the replay fetch: a torn-down subscriber must
        // deliver nothing AND must not append onto a co-subscriber's still-live
        // chain (append gates on refCount, which a surviving co-subscriber keeps
        // > 0). Mirrors the live-stream guard in the onmessage handler.
        if (destroyed) return;
        if (this.#activeCryptoModeByRoom.get(roomId) === 'plaintext') {
          for (const row of rawItems) {
            lastSeq = row.seq;
            args.onMessage(aliasSealedAsPlaintext(row));
          }
        } else if (this.#cryptoProvider !== null) {
          // Route each replay unseal through the room's serial chain: it queues
          // behind any still-in-flight streamed unseal (never concurrent), and
          // frames from the re-attached stream append AFTER these, preserving
          // replay-before-live order. lastSeq advances synchronously from row.seq
          // (independent of when the deferred unseal runs) so the follow-up ticket
          // fetch + re-attach resume from the correct cursor with no gap/dup.
          for (const row of rawItems) {
            lastSeq = row.seq;
            this.#appendDecryptTask(roomId, row, args.onMessage);
          }
        } else {
          for (const row of rawItems) {
            lastSeq = row.seq;
            args.onMessage(row);
          }
        }
      } catch (err) {
        // Surface replay failures to caller; the reconnect flow still re-attaches.
        reportError(err);
      }
    };

    // MAJOR #5: immediate reconnect for graceful shutdown — same replay logic as
    // reconnect() but fires in the next microtask instead of after backoff delay.
    const reconnectImmediate = () => {
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (destroyed) return;
        await replayMissed();
        if (destroyed) return;
        let ticket: string;
        try {
          ticket = await this.#fetchSubscribeTicket(roomId, lastSeq);
        } catch (err) {
          reportError(err);
          reconnect(0);
          return;
        }
        attach(ticket);
      }, 0);
    };

    const reconnect = (attempt: number) => {
      const delay = backoffMs(attempt);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (destroyed) return;
        await replayMissed();
        if (destroyed) return;
        let ticket: string;
        try {
          ticket = await this.#fetchSubscribeTicket(roomId, lastSeq);
        } catch (err) {
          // Retry with backoff on ticket failure; surface error.
          reportError(err);
          reconnect(attempt + 1);
          return;
        }
        attach(ticket);
      }, delay);
    };

    // Full teardown of THIS subscription. Idempotent (destroyed + chainReleased
    // guards). Called from BOTH the returned unsubscribe handle AND the
    // crypto_mode_mismatch abort path, so every destroyed=true balances its
    // acquire() with exactly one release() — a mismatch no longer leaks the
    // room's chain refcount for the client's lifetime.
    const teardownSubscriber = () => {
      destroyed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      es?.close();
      es = null;
      // Deregister this subscriber from the room's shared serial decrypt chain.
      // The chain entry is removed only when the LAST subscriber releases
      // (refCount → 0), so a co-subscriber sharing this roomId keeps decrypting
      // in order — teardown of one no longer destroys the shared chain.
      if (this.#cryptoProvider !== null && !chainReleased) {
        chainReleased = true;
        this.#decryptChain.release(roomId);
      }
    };

    // Initial connection: fetch ticket then open EventSource.
    (async () => {
      if (destroyed) return;
      let ticket: string;
      try {
        ticket = await this.#fetchSubscribeTicket(roomId, lastSeq);
      } catch (err) {
        reportError(err);
        reconnect(0);
        return;
      }
      attach(ticket);
    })();

    return teardownSubscriber;
  }

  // ── W6: Typing / Presence / Read receipts ─────────────────────────────────

  /**
   * Broadcast a typing indicator for roomId.
   * Wire-contract: POST /api/sdk/rooms/:room_id/typing
   * Body: { ttl_secs? }
   */
  async sendTyping(roomId: string, ttlSecs?: number): Promise<void> {
    const body: Record<string, unknown> = {};
    if (ttlSecs !== undefined) body['ttl_secs'] = ttlSecs;

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/typing`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#jwt}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `sendTyping failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `sendTyping failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * Send a presence heartbeat for roomId.
   * Wire-contract: POST /api/sdk/rooms/:room_id/presence
   * Body: {}
   */
  async sendPresence(roomId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/presence`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#jwt}`,
          },
          body: JSON.stringify({}),
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `sendPresence failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `sendPresence failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * Fetch presence snapshot for roomId.
   * Wire-contract: GET /api/sdk/rooms/:room_id/presence
   * Returns: Array<PresenceUser>
   */
  async getPresence(roomId: string): Promise<PresenceUser[]> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/presence`,
        {
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `getPresence failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `getPresence failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const arr = (await resp.json()) as Array<{ user_id: string; last_seen_at: string }>;
    // Wire-contract assertion: each entry must have user_id.
    return arr.map((entry) => {
      if (!Object.prototype.hasOwnProperty.call(entry, 'user_id')) {
        throw new SDKChatError('server_error', 'getPresence: entry missing user_id');
      }
      return { userId: entry.user_id, lastSeenAt: entry.last_seen_at };
    });
  }

  /**
   * Mark messages up to seq as read (monotonic — cannot regress).
   * Wire-contract: POST /api/sdk/rooms/:room_id/read?seq=N
   */
  async markRead(roomId: string, seq: number): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/read?seq=${seq}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `markRead failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `markRead failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  // ── W5: Room management ────────────────────────────────────────────────────

  /**
   * Create a room. Idempotent per roomId.
   * Wire-contract: POST /api/sdk/rooms
   */
  async createRoom(args: CreateRoomArgs = {}): Promise<Room> {
    const body: Record<string, unknown> = {};
    if (args.roomId !== undefined) body['room_id'] = args.roomId;
    if (args.title !== undefined) body['title'] = args.title;
    if (args.productRef !== undefined) body['product_ref'] = args.productRef;
    if (args.metadata !== undefined) body['metadata'] = args.metadata;
    if (args.initialMembers !== undefined) {
      body['initial_members'] = args.initialMembers.map((m) => ({
        user_id: m.userId,
        role: m.role,
      }));
    }
    if (args.visibility !== undefined) body['visibility'] = args.visibility;

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#jwt}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SDKChatError('network', `createRoom failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `createRoom failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const dto = (await resp.json()) as RoomDTO;
    // Wire-contract assertion: room_id must be present.
    if (!Object.prototype.hasOwnProperty.call(dto, 'room_id')) {
      throw new SDKChatError('server_error', 'createRoom: response missing room_id');
    }
    return dtoToRoom(dto);
  }

  /**
   * Fetch room metadata + active members.
   * Wire-contract: GET /api/sdk/rooms/:room_id
   */
  async getRoom(roomId: string): Promise<Room> {
    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}`, {
        headers: { Authorization: `Bearer ${this.#jwt}` },
      });
    } catch (err) {
      throw new SDKChatError('network', `getRoom failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `getRoom failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const dto = (await resp.json()) as RoomDTO;
    if (!Object.prototype.hasOwnProperty.call(dto, 'room_id')) {
      throw new SDKChatError('server_error', 'getRoom: response missing room_id');
    }
    return dtoToRoom(dto);
  }

  /**
   * Update room title / metadata. Owner-only.
   * Wire-contract: PATCH /api/sdk/rooms/:room_id
   */
  async updateRoom(roomId: string, args: UpdateRoomArgs): Promise<Room> {
    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#jwt}`,
        },
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new SDKChatError('network', `updateRoom failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `updateRoom failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const dto = (await resp.json()) as RoomDTO;
    if (!Object.prototype.hasOwnProperty.call(dto, 'room_id')) {
      throw new SDKChatError('server_error', 'updateRoom: response missing room_id');
    }
    return dtoToRoom(dto);
  }

  /**
   * List active members of a room (fetches room and returns members).
   */
  async listMembers(roomId: string): Promise<Member[]> {
    const room = await this.getRoom(roomId);
    return room.members;
  }

  /**
   * List rooms in the calling app where the user is an active member.
   * Ordered by `created_at` DESC.
   *
   * @param opts.limit          Default 50, clamped server-side to 1..=200.
   * @param opts.offset         Pagination offset, default 0.
   * @param opts.includeArchived Include rooms with non-NULL archived_at.
   *                              Default false (active deals only).
   * @returns                   `rooms` array (typed as `RoomSummary[]`) + `limit` + `offset` + `hasMore`.
   *                            `RoomSummary` has no `members` field — call `getRoom(roomId)` for the
   *                            full member list of a specific room.
   */
  async listRooms(
    opts: {
      limit?: number;
      offset?: number;
      includeArchived?: boolean;
    } = {},
  ): Promise<{
    rooms: RoomSummary[];
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts.includeArchived) params.set('include_archived', 'true');

    const qs = params.toString();
    const url = `${this.#baseUrl}/api/sdk/rooms${qs ? '?' + qs : ''}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.#jwt}` },
      });
    } catch (err) {
      throw new SDKChatError('network', `listRooms() fetch failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `listRooms() HTTP ${resp.status}`,
        resp.status,
      );
    }

    const body = (await resp.json()) as {
      rooms: Array<{
        app_id: string;
        room_id: string;
        title: string | null;
        product_ref: string | null;
        created_by: string;
        created_at: string;
        archived_at: string | null;
        metadata: Record<string, unknown>;
        visibility?: RoomVisibility;  // RoomListItem does not yet emit this field (pre-open-rooms server)
      }>;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    return {
      rooms: body.rooms.map((r) => ({
        roomId: r.room_id,
        title: r.title,
        productRef: r.product_ref,
        createdBy: r.created_by,
        createdAt: r.created_at,
        archivedAt: r.archived_at,
        metadata: r.metadata,
        // RoomListItem omits visibility on pre-open-rooms servers; default to 'member'.
        visibility: r.visibility ?? 'member',
      })),
      limit: body.limit,
      offset: body.offset,
      hasMore: body.has_more,
    };
  }

  /**
   * Add a user to a room.
   * Wire-contract: POST /api/sdk/rooms/:room_id/members
   * Body: { user_id, role? }
   */
  async addMember(roomId: string, userId: string, role = 'member'): Promise<Member> {
    const body = { user_id: userId, role };

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/members`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#jwt}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `addMember failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `addMember failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const dto = (await resp.json()) as MemberDTO;
    // Wire-contract assertion: user_id must be present.
    if (!Object.prototype.hasOwnProperty.call(dto, 'user_id')) {
      throw new SDKChatError('server_error', 'addMember: response missing user_id');
    }
    return dtoToMember(dto);
  }

  /**
   * Remove a user from a room (soft-delete).
   * Wire-contract: DELETE /api/sdk/rooms/:room_id/members/:user_id
   */
  async removeMember(roomId: string, userId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `removeMember failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `removeMember failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  // ── W7: Thread view ────────────────────────────────────────────────────────

  /**
   * Fetch all reply messages in a thread.
   * Wire-contract: GET /api/sdk/rooms/:room_id/threads/:root_msg_id
   * Returns: Array<MessageRow> sorted by seq ascending (server-side ORDER BY seq).
   * Requires scope: chat:read:<room_id>.
   */
  async getThread(roomId: string, rootMsgId: string): Promise<MessageRow[]> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(rootMsgId)}`,
        {
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `getThread failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `getThread failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const json = (await resp.json()) as Array<{
      seq: number;
      msg_id: string;
      sender_uid: string;
      sealed_b64: string;
      created_at: string;
      thread_root_msg_id?: string | null;
      product_ref?: string | null;
      product_meta?: ProductMeta | null;
    }>;

    return json.map(rowToMessageRow);
  }

  // ── W2: Edit / delete / pin ────────────────────────────────────────────────

  /**
   * Edit a message (only the original sender may edit).
   * Wire-contract: PATCH /api/sdk/messages/:room_id/:msg_id
   * Body: { sealed_b64 }
   * Scope: chat:write:<room_id>.
   */
  async updateMessage(roomId: string, msgId: string, args: UpdateMessageArgs): Promise<void> {
    const body = {
      sealed_b64: arrayBufferToBase64(args.sealed),
    };

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#jwt}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `updateMessage failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `updateMessage failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * Soft-delete a message (only the original sender may delete).
   * Wire-contract: DELETE /api/sdk/messages/:room_id/:msg_id
   * Returns void on 204.
   * Scope: chat:write:<room_id>.
   */
  async deleteMessage(roomId: string, msgId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `deleteMessage failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `deleteMessage failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * Pin a message in a room. Idempotent.
   * Wire-contract: POST /api/sdk/rooms/:room_id/pins/:msg_id
   * Scope: chat:write:<room_id>.
   */
  async pinMessage(roomId: string, msgId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/pins/${encodeURIComponent(msgId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `pinMessage failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `pinMessage failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * Unpin a message in a room. No-op if not pinned.
   * Wire-contract: DELETE /api/sdk/rooms/:room_id/pins/:msg_id
   * Scope: chat:write:<room_id>.
   */
  async unpinMessage(roomId: string, msgId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/pins/${encodeURIComponent(msgId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `unpinMessage failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `unpinMessage failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * List pinned messages in a room, ordered by pinned_at descending.
   * Wire-contract: GET /api/sdk/rooms/:room_id/pins
   * Scope: chat:read:<room_id>.
   */
  async listPins(roomId: string): Promise<PinnedMessage[]> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/pins`,
        {
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `listPins failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `listPins failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const arr = (await resp.json()) as Array<{
      app_id: string;
      room_id: string;
      msg_id: string;
      pinned_by: string;
      pinned_at: string;
    }>;

    return arr.map((p) => ({
      appId: p.app_id,
      roomId: p.room_id,
      msgId: p.msg_id,
      pinnedBy: p.pinned_by,
      pinnedAt: p.pinned_at,
    }));
  }

  // ── W3: Reactions ────────────────────────────────────────────────────────

  /**
   * W3: Add a reaction emoji to a message. Idempotent per (user, emoji).
   * Wire-contract: POST /api/sdk/messages/:room_id/:msg_id/reactions
   * Scope: chat:write:<room_id>.
   *
   * @param reaction - Emoji / reaction string. Must be 1–32 Unicode code points
   *   (`[...reaction].length`). The server enforces the same limit via
   *   `character_length(reaction) BETWEEN 1 AND 32` (PG code-point count).
   *   Throws `invalid_args` if the validation fails before the network call.
   */
  async sendReaction(roomId: string, msgId: string, reaction: string): Promise<void> {
    if (!reaction || [...reaction].length > 32) {
      throw new SDKChatError(
        'invalid_args',
        `reaction must be 1-32 Unicode code points, got ${[...reaction].length}`,
      );
    }

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}/reactions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reaction }),
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `sendReaction failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `sendReaction failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * W3: Remove own reaction from a message. No-op if never added.
   * Wire-contract: DELETE /api/sdk/messages/:room_id/:msg_id/reactions/:reaction
   * Scope: chat:write:<room_id>.
   *
   * The reaction string is percent-encoded in the path to support emoji.
   *
   * @param reaction - Emoji / reaction string. Must be 1–32 Unicode code points
   *   (`[...reaction].length`). The server enforces the same limit via
   *   `character_length(reaction) BETWEEN 1 AND 32` (PG code-point count).
   *   Throws `invalid_args` if the validation fails before the network call.
   */
  async removeReaction(roomId: string, msgId: string, reaction: string): Promise<void> {
    if (!reaction || [...reaction].length > 32) {
      throw new SDKChatError(
        'invalid_args',
        `reaction must be 1-32 Unicode code points, got ${[...reaction].length}`,
      );
    }

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}/reactions/${encodeURIComponent(reaction)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `removeReaction failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `removeReaction failed: HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  /**
   * W3: Fetch aggregated reaction counts + user lists for a message.
   * Wire-contract: GET /api/sdk/messages/:room_id/:msg_id/reactions
   * Scope: chat:read:<room_id>.
   */
  async getReactions(roomId: string, msgId: string): Promise<ReactionsResponse> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}/reactions`,
        {
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `getReactions failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `getReactions failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    return (await resp.json()) as ReactionsResponse;
  }

  /**
   * W4: Upload a file attachment and send a sealed reference in the room.
   *
   * Flow: presign → PUT blob → send sealed message.
   * Client-side size guard: rejects blobs > 50 MB before network call.
   *
   * @param roomId  Room to post the attachment message to.
   * @param blob    The (encrypted) blob to upload.
   * @param args    senderUid + sealed payload + sha256.
   */
  // Semgrep `express-res-sendfile` rule matches the method NAME `sendFile`,
  // not the Express semantics: this SDK method takes a browser Blob and
  // delegates to sendFileHelper which POSTs the bytes to /api/sdk/files.
  // No filesystem path, no Express server, no user-controlled file path,
  // no path-traversal risk.
  async sendFile(
    roomId: string,
    blob: Blob,
    args: SendFileArgs,
  ): Promise<{ seq: number; msgId: string }> {
    // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
    return sendFileHelper(this, roomId, blob, args);
  }

  // -- W6 outbox: optimistic send -------------------------------------------

  /**
   * MAX_RETRIES for network errors in sendOptimistic retry loop.
   * Non-network errors (4xx, invalid args) fail immediately.
   */
  static readonly MAX_RETRIES = 5;

  /**
   * Send a message optimistically with Sendbird-style callbacks.
   *
   * Flow:
   *   1. Fires onPending callbacks (after microtask gap so callers can register them).
   *   2. Enqueues to idb-keyval (persists across page reload).
   *   3. Attempts send(); on network error retries up to MAX_RETRIES with backoff.
   *   4. Non-network errors (4xx) fail immediately — no retry, outbox cleared.
   *   5. On success, dequeues from idb-keyval, fires onSucceeded.
   *   6. On MAX_RETRIES exhaustion, fires onFailed with code='network'.
   *
   * The returned handle.done Promise resolves on success or rejects on failure.
   * Always attach onFailed or .catch to avoid unhandled rejections.
   */
  sendOptimistic(roomId: string, args: SendArgs): OptimisticHandle {
    // W6 E2EE guard: warn once if called with e2ee configured.
    // Callers should use sendTextOptimistic() so plaintext is never stored in the outbox.
    if (this.#cryptoProvider !== null && !this.#e2eeOptimisticWarnedOnce) {
      this.#e2eeOptimisticWarnedOnce = true;
      console.warn(
        '[chat-sdk] sendOptimistic() called with e2ee configured.',
        'Use sendTextOptimistic() to ensure plaintext is sealed before outbox storage.',
        'sendOptimistic() assumes args.sealed is already ciphertext — no re-seal is performed.',
      );
    }

    const msgId = args.msgId ?? crypto.randomUUID();
    const pendingCbs: Array<() => void> = [];
    const okCbs: Array<(result: { seq: number; msgId: string }) => void> = [];
    const failCbs: Array<(err: SDKChatError) => void> = [];

    const sleep = (ms: number): Promise<void> =>
      this.#testNoSleep ? Promise.resolve() : new Promise((res) => setTimeout(res, ms));

    const done = (async () => {
      // Microtask gap: lets caller register onPending/onSucceeded/onFailed before we fire.
      await Promise.resolve();

      pendingCbs.forEach((cb) => cb());

      await enqueue(roomId, {
        msgId,
        roomId,
        senderUid: args.senderUid,
        sealedB64: arrayBufferToBase64(args.sealed),
        threadRootMsgId: args.threadRootMsgId,
        attempts: 0,
        enqueuedAt: Date.now(),
      });

      for (let attempt = 0; attempt < SDKChatClient.MAX_RETRIES; attempt++) {
        try {
          const result = await this.send(roomId, { ...args, msgId });
          await dequeue(roomId, msgId);
          okCbs.forEach((cb) => cb(result));
          return result;
        } catch (e) {
          const err = e instanceof SDKChatError ? e : new SDKChatError('network', String(e));
          // Non-network errors (4xx) fail immediately — no retry.
          if (err.code !== 'network') {
            await dequeue(roomId, msgId);
            failCbs.forEach((cb) => cb(err));
            throw err;
          }
          if (attempt < SDKChatClient.MAX_RETRIES - 1) {
            await sleep(Math.min(100 * Math.pow(2, attempt), 30_000));
          }
        }
      }

      // MAX_RETRIES exhausted — leave in outbox for flushOutbox, fire onFailed.
      const finalErr = new SDKChatError('network', 'sendOptimistic: max retries exceeded');
      failCbs.forEach((cb) => cb(finalErr));
      throw finalErr;
    })();

    const handle: OptimisticHandle = {
      msgId,
      done,
      onPending: (cb) => {
        pendingCbs.push(cb);
        return handle;
      },
      onSucceeded: (cb) => {
        okCbs.push(cb);
        return handle;
      },
      onFailed: (cb) => {
        failCbs.push(cb);
        return handle;
      },
    };
    return handle;
  }

  /**
   * Retry all queued messages for a room (e.g. on reconnect after page reload).
   * Messages that succeed are dequeued. Messages that fail are left in the outbox.
   * Errors are silently swallowed — caller can retry again later.
   */
  async flushOutbox(roomId: string): Promise<void> {
    for (const m of await pending(roomId)) {
      try {
        await this.send(roomId, {
          senderUid: m.senderUid,
          // sealedB64 is already ciphertext (pre-sealed at enqueue time by sendTextOptimistic).
          // No re-seal on retry — same nonce/CTR is fine because the server never ACK'd the original.
          sealed: base64ToArrayBuffer(m.sealedB64),
          msgId: m.msgId,
          threadRootMsgId: m.threadRootMsgId,
        });
        await dequeue(roomId, m.msgId);
      } catch {
        // Leave queued for next flush attempt.
      }
    }
  }

  /**
   * Send a text message optimistically with automatic E2EE sealing.
   *
   * Unlike sendOptimistic() which requires pre-sealed bytes, this method
   * UTF-8 encodes the text, seals it via the configured CryptoProvider,
   * then enqueues the ciphertext. The outbox never stores plaintext.
   *
   * Requires e2ee to be configured in the constructor. Throws SDKChatError
   * with code 'unsupported' if e2ee is not configured.
   *
   * @param roomId   Target room.
   * @param args     senderUid + text to seal and send optimistically.
   */
  sendTextOptimistic(
    roomId: string,
    args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: unknown },
  ): OptimisticHandle {
    if (this.#cryptoProvider === null) {
      // Return a handle that immediately fails — cannot seal without provider.
      const err = new SDKChatError(
        'unsupported',
        'sendTextOptimistic requires e2ee config — pass e2ee option to SDKChatClient constructor',
      );
      const failCbs: Array<(e: SDKChatError) => void> = [];
      const done = Promise.reject(err);
      // Suppress unhandled rejection until caller attaches .catch / onFailed.
      done.catch(() => {});
      const handle: OptimisticHandle = {
        msgId: args.msgId ?? crypto.randomUUID(),
        done,
        onPending: (_cb) => handle,
        onSucceeded: (_cb) => handle,
        onFailed: (cb) => { failCbs.push(cb); done.catch(cb); return handle; },
      };
      return handle;
    }

    const provider = this.#cryptoProvider;
    const msgId = args.msgId ?? crypto.randomUUID();
    const ctx: SealContext = { roomId, senderUid: args.senderUid };

    // Seal the text first, then delegate to sendOptimistic with pre-sealed bytes.
    // This prevents plaintext from ever entering the outbox.
    const sealedPromise = provider.seal(
      new TextEncoder().encode(args.text).buffer as ArrayBuffer,
      ctx,
    );

    const pendingCbs: Array<() => void> = [];
    const okCbs: Array<(result: { seq: number; msgId: string }) => void> = [];
    const failCbs: Array<(err: SDKChatError) => void> = [];

    const sleep = (ms: number): Promise<void> =>
      this.#testNoSleep ? Promise.resolve() : new Promise((res) => setTimeout(res, ms));

    const done = (async () => {
      // Microtask gap: lets caller register callbacks before we fire.
      await Promise.resolve();

      pendingCbs.forEach((cb) => cb());

      let sealed: ArrayBuffer;
      try {
        sealed = await sealedPromise;
      } catch (e) {
        const err = new SDKChatError('unsupported', `sendTextOptimistic: seal failed: ${String(e)}`);
        failCbs.forEach((cb) => cb(err));
        throw err;
      }

      await enqueue(roomId, {
        msgId,
        roomId,
        senderUid: args.senderUid,
        sealedB64: arrayBufferToBase64(sealed),
        threadRootMsgId: args.threadRootMsgId,
        attempts: 0,
        enqueuedAt: Date.now(),
      });

      for (let attempt = 0; attempt < SDKChatClient.MAX_RETRIES; attempt++) {
        try {
          const result = await this.send(roomId, {
            senderUid: args.senderUid,
            sealed,
            msgId,
            threadRootMsgId: args.threadRootMsgId,
            productRef: args.productRef,
            productMeta: args.productMeta,
          });
          await dequeue(roomId, msgId);
          okCbs.forEach((cb) => cb(result));
          return result;
        } catch (e) {
          const err = e instanceof SDKChatError ? e : new SDKChatError('network', String(e));
          if (err.code !== 'network') {
            await dequeue(roomId, msgId);
            failCbs.forEach((cb) => cb(err));
            throw err;
          }
          if (attempt < SDKChatClient.MAX_RETRIES - 1) {
            await sleep(Math.min(100 * Math.pow(2, attempt), 30_000));
          }
        }
      }

      const finalErr = new SDKChatError('network', 'sendTextOptimistic: max retries exceeded');
      failCbs.forEach((cb) => cb(finalErr));
      throw finalErr;
    })();

    const handle: OptimisticHandle = {
      msgId,
      done,
      onPending: (cb) => { pendingCbs.push(cb); return handle; },
      onSucceeded: (cb) => { okCbs.push(cb); return handle; },
      onFailed: (cb) => { failCbs.push(cb); return handle; },
    };
    return handle;
  }

  /**
   * Send multiple messages in a single transaction.
   *
   * Wire-contract: POST /api/sdk/messages/batch
   * Scope required: chat:write:<room_id>
   *
   * Items must be pre-sealed — batchAppend does NOT auto-seal (use sendText /
   * sendTextOptimistic for auto-seal). Pass sealed ciphertext as ArrayBuffer;
   * wire DTO conversion (base64, snake_case) happens internally.
   *
   * room_id is injected automatically; created_at is set server-side.
   */
  async batchAppend(roomId: string, items: BatchAppendItem[]): Promise<void> {
    // SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior crypto_mode mismatch —
    // gate-consistency with send/sendText/#fetchRows/subscribe (a poisoned room refuses
    // ALL sends). batchAppend carries pre-sealed bytes, so this is completeness, not a
    // cleartext leak, but a room with a proven-tampered crypto_mode must still refuse.
    this.#assertRoomNotPoisoned(roomId);
    const payload = items.map((item) => ({
      room_id: roomId,
      msg_id: item.msgId,
      sealed_b64: item.sealed != null ? arrayBufferToBase64(item.sealed) : null,
      thread_root_msg_id: item.threadRootMsgId ?? null,
      product_ref: item.productRef ?? null,
      product_meta: item.productMeta ?? null,
    }));

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages/batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new SDKChatError('network', `batchAppend() fetch failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `batchAppend() HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

  // ── W9 T4: Product-card helpers ───────────────────────────────────────────

  /**
   * Send a product card message — a variant of `send()` that attaches a
   * `product_ref` and `product_meta` payload for marketplace integrations.
   *
   * `sealedBody` is optional; omitting it sends an unsealed product-card
   * (plaintext productMeta only, no E2EE content).
   *
   * Wire-contract: POST /api/sdk/messages with `product_ref` + `product_meta`.
   */
  async sendProductCard(
    roomId: string,
    opts: {
      productRef: string;
      productMeta: ProductMeta;
      sealedBody?: ArrayBuffer;
      msgId?: string;
      senderUid: string;
    },
  ): Promise<MessageRow> {
    // SEC-CR-001: fail-CLOSED if THIS room was poisoned by a prior crypto_mode mismatch
    // (gate-consistency with the other send entrypoints).
    this.#assertRoomNotPoisoned(roomId);
    const body: Record<string, unknown> = {
      room_id: roomId,
      msg_id: opts.msgId ?? crypto.randomUUID(),
      sender_uid: opts.senderUid,
      product_ref: opts.productRef,
      product_meta: opts.productMeta,
    };
    if (opts.sealedBody !== undefined) {
      body['sealed_b64'] = arrayBufferToBase64(opts.sealedBody);
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#jwt}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SDKChatError('network', `sendProductCard() fetch failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `sendProductCard() HTTP ${resp.status}`,
        resp.status,
      );
    }

    const dto = (await resp.json()) as Parameters<typeof rowToMessageRow>[0];
    return rowToMessageRow(dto);
  }

  /**
   * Search for messages tagged with a specific product_ref.
   *
   * When `roomId` is provided, restricts to that room.
   * Without `roomId`, searches cross-room within the app.
   *
   * Wire-contract: GET /api/sdk/messages?product_ref=X[&room_id=Y][&limit=N]
   */
  async searchByProductRef(
    productRef: string,
    opts?: { roomId?: string; limit?: number },
  ): Promise<MessageRow[]> {
    const params = new URLSearchParams({ product_ref: productRef });
    if (opts?.roomId) params.set('room_id', opts.roomId);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages?${params.toString()}`, {
        headers: { Authorization: `Bearer ${this.#jwt}` },
      });
    } catch (err) {
      throw new SDKChatError('network', `searchByProductRef() fetch failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `searchByProductRef() HTTP ${resp.status}`,
        resp.status,
      );
    }

    const rows = (await resp.json()) as Array<Parameters<typeof rowToMessageRow>[0]>;
    return rows.map(rowToMessageRow);
  }

  // ── W8: Mass-chat methods (v1.2.0) ────────────────────────────────────────

  /**
   * Add multiple users to a room in chunks. Wraps the bulk `user_ids` shape of
   * POST /api/sdk/rooms/{room_id}/members. Server caps at 500 user_ids per call,
   * so this method chunks the input array into 500-sized batches and issues
   * sequential requests, aggregating the `added` / `updated` results.
   *
   * For mass-chat use cases (5K+ buyers added to a marketplace room), this is
   * the correct method — calling addMember() in a loop will hit the
   * sdk_rooms_write rate limiter (default 30/min with burst 15) after ~15 single
   * calls and trigger 429 storms. With batchAddMembers(), 5000 users go in 10
   * chunks of 500 — well below burst.
   *
   * @param roomId  Room to add to
   * @param userIds Array of user IDs. Empty array is rejected; otherwise no
   *                client-side limit (chunked transparently).
   * @param role    'owner' | 'member' (default 'member'). Same role applies to
   *                every user_id in the batch.
   * @returns       Aggregated `{ added: string[], updated: string[] }` across all
   *                chunks. `added` = newly inserted members; `updated` =
   *                re-activated or role-updated members.
   * @throws {SDKChatBatchError} On mid-bulk failure (chunk N of M fails). Carries
   *   `{ partial, failedAtIndex, failedChunk, remaining }` so the caller can
   *   compute the residual to retry.
   */
  async batchAddMembers(
    roomId: string,
    userIds: string[],
    role: 'owner' | 'member' = 'member',
  ): Promise<{ added: string[]; updated: string[] }> {
    if (userIds.length === 0) {
      throw new SDKChatError('invalid_args', 'batchAddMembers requires at least one user_id');
    }

    const added: string[] = [];
    const updated: string[] = [];

    for (let offset = 0; offset < userIds.length; offset += BATCH_ADD_MEMBERS_CHUNK) {
      const chunk = userIds.slice(offset, offset + BATCH_ADD_MEMBERS_CHUNK);
      const remaining = userIds.slice(offset + BATCH_ADD_MEMBERS_CHUNK);

      let resp: Response;
      try {
        resp = await fetch(
          `${this.#baseUrl}/api/sdk/rooms/${encodeURIComponent(roomId)}/members`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.#jwt}`,
            },
            body: JSON.stringify({ user_ids: chunk, role }),
          },
        );
      } catch (err) {
        throw new SDKChatBatchError(
          'network',
          `batchAddMembers() fetch failed: ${String(err)}`,
          { partial: { added: [...added], updated: [...updated] }, failedAtIndex: offset, failedChunk: chunk, remaining, cause: err },
        );
      }

      if (!resp.ok) {
        throw new SDKChatBatchError(
          httpStatusToCode(resp.status),
          `batchAddMembers() HTTP ${resp.status}`,
          { partial: { added: [...added], updated: [...updated] }, failedAtIndex: offset, failedChunk: chunk, remaining, cause: new SDKChatError(httpStatusToCode(resp.status), `HTTP ${resp.status}`, resp.status) },
          resp.status,
        );
      }

      const body = (await resp.json()) as { added?: string[]; updated?: string[] };
      if (
        !Object.prototype.hasOwnProperty.call(body, 'added') ||
        !Object.prototype.hasOwnProperty.call(body, 'updated')
      ) {
        throw new SDKChatError('server_error', 'batchAddMembers: malformed server response');
      }
      added.push(...(body.added ?? []));
      updated.push(...(body.updated ?? []));
    }

    return { added, updated };
  }

  /**
   * Delete an entire room's message history. Wraps DELETE /api/sdk/messages/{room_id}.
   *
   * Note: this is destructive — all messages in the room are gone. Use to close
   * out a deal / mark a buyer-seller flow complete. Does NOT delete the room
   * metadata or memberships (those are managed via the rooms endpoints).
   *
   * @param roomId  Room to clear
   */
  async deleteRoom(roomId: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.#jwt}` },
        },
      );
    } catch (err) {
      throw new SDKChatError('network', `deleteRoom() fetch failed: ${String(err)}`);
    }

    if (!resp.ok) {
      throw new SDKChatError(
        httpStatusToCode(resp.status),
        `deleteRoom() HTTP ${resp.status}`,
        resp.status,
      );
    }
  }

}
