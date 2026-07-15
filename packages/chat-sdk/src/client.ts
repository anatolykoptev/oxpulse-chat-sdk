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
  decode,
  setDictLoader,
  setDictBaseUrl,
  asHttpWireBytes,
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
import { SDKChatBatchError, SDKChatError, type SDKChatErrorCode } from './errors.js';
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
  generateUUID,
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
 * #117: Validate + normalize a raw `product_meta` payload at the SDK receive
 * boundary. Mirrors the widget's `normalizeProductMeta` render-gate guard so
 * `MessageRow.productMeta: ProductMeta | null` is honest for all SDK consumers.
 *
 * Rules:
 *   - Non-object → null.
 *   - Core fields (title, price, currency) must be non-empty strings → else null.
 *   - Length caps: title 200, price 40, currency 16, urls 2048 (truncated).
 *   - Non-string / oversized URLs coerced to '' (never garbage).
 */
function normalizeProductMeta(raw: unknown): ProductMeta | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const title = typeof obj['title'] === 'string' ? obj['title'] : '';
  const price = typeof obj['price'] === 'string' ? obj['price'] : '';
  const currency = typeof obj['currency'] === 'string' ? obj['currency'] : '';

  // Core fields must be non-empty strings.
  if (title.length === 0 || price.length === 0 || currency.length === 0) return null;

  const capUrl = (v: unknown): string => {
    if (typeof v !== 'string') return '';
    return v.length > 2048 ? v.slice(0, 2048) : v;
  };

  return {
    title: title.length > 200 ? title.slice(0, 200) : title,
    price: price.length > 40 ? price.slice(0, 40) : price,
    currency: currency.length > 16 ? currency.slice(0, 16) : currency,
    imageUrl: capUrl(obj['imageUrl']),
    productUrl: capUrl(obj['productUrl']),
  };
}

/**
 * Map a raw wire-DTO row (snake_case) to a `MessageRow` (camelCase).
 * Used by list(), thread list, and the SSE onmessage handler.
 * M5 fix: extracted from two duplicated sites to prevent mapper drift.
 * #117: product_meta is normalized at this receive boundary — never garbage.
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
    productMeta: normalizeProductMeta(row.product_meta),
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

/**
 * Per-row unseal ABORT deadline (ms). At this point the chain fires an AbortController
 * passed to provider.unseal so a signal-honoring provider settles promptly and the room
 * advances. The built-in WebCrypto decrypt is sub-ms and never reaches this.
 */
const DECRYPT_DEADLINE_MS = 5000;
/**
 * Grace after the abort deadline before the chain FORCE-DRAINS a still-unsettled unseal
 * (a provider that both ignores the AbortSignal and hangs). At `DECRYPT_DEADLINE_MS +
 * DECRYPT_FORCE_DRAIN_GRACE_MS` the row is bailed as unsealError so the room's chain
 * drains (bounded) instead of black-holing. The grace lets a slow-but-eventually-settling
 * provider (e.g. a KMS round-trip) deliver its real plaintext rather than being dropped.
 */
const DECRYPT_FORCE_DRAIN_GRACE_MS = 5000;

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
 * SEC-CR-17-01 (availability): upper bound on the number of per-room discovered
 * crypto-mode entries retained on the list()-only path. A client paging history
 * across many distinct rooms via list() (no live subscription, so no
 * teardownSubscriber eviction) would otherwise accumulate one #activeCryptoModeByRoom
 * entry per room forever. When the map exceeds this cap, the OLDEST entry whose room
 * has NO live subscription (decrypt-chain refCount 0) is evicted; live rooms and
 * #poisonedRooms are never touched.
 */
const ACTIVE_CRYPTO_MODE_MAP_CAP = 256;

/**
 * CR17-C-01: outbox failure codes that are PERMANENT — a later flushOutbox retry can
 * never succeed, so the entry is scrubbed instead of retried forever. Everything NOT in
 * this set — network / unauthorized (refreshable token) / rate_limited (429) /
 * server_error (5xx, e.g. a deploy) — is TRANSIENT and stays queued for the next flush.
 * flushOutbox is a background, last-resort durability path with no caller notification, so
 * this is fail-SAFE by design: an ambiguous failure keeps the ciphertext queued (a queued
 * message can be re-flushed; a dropped one is silent E2EE message loss).
 */
const PERMANENT_OUTBOX_FAILURE_CODES: ReadonlySet<SDKChatErrorCode> = new Set<SDKChatErrorCode>([
  'crypto_mode_poisoned',
  'crypto_mode_mismatch',
  // Inert on the current outbox paths (flushOutbox / sendOptimistic / sendTextOptimistic all
  // call send() directly, and the only `crypto_mode_undiscovered` throw is in sendText, which
  // they never call) — listed as shared-Set defense-in-depth so it classifies as PERMANENT if a
  // future refactor routes an outbox write through a path that can raise it.
  'crypto_mode_undiscovered',
  'invalid_args',
  'unsupported',
  'forbidden',
  'not_found',
]);

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
        // Discriminated union guarantees e2ee.getKey is present here. Forward the anti-replay
        // config surface (SEC-CR-003); default the durable namespace to the client's appId so
        // distinct tenants on one origin do not share a replay window.
        this.#cryptoProvider = createSFrameProvider({
          getKey: e2ee.getKey,
          ...(e2ee.ctrStrategy !== undefined ? { ctrStrategy: e2ee.ctrStrategy } : {}),
          ...(e2ee.ctrKeyspace !== undefined ? { ctrKeyspace: e2ee.ctrKeyspace } : {}),
          ...(e2ee.replayWindow !== undefined ? { replayWindow: e2ee.replayWindow } : {}),
          ...(e2ee.durableReplay !== undefined ? { durableReplay: e2ee.durableReplay } : {}),
          ...(e2ee.durableReplayWindow !== undefined
            ? { durableReplayWindow: e2ee.durableReplayWindow }
            : {}),
          durableReplayNamespace: e2ee.durableReplayNamespace ?? opts.appId,
        });
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
  async #encodeBody(payload: unknown): Promise<string | Uint8Array> {
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
    return this.#encodeBody(payload);
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
    // Compressed frame (0xC6/0xC7/0xC8): ensure zstd is ready regardless of #compression setting.
    // #compression controls outgoing encoding only; server may compress responses independently.
    if (first === 0xc6 || first === 0xc7 || first === 0xc8) {
      if (this.#ready !== null) {
        await this.#ready;
        this.#ready = null;
      } else {
        // #compression is 'none' — zstd not pre-initialized; initialize on demand.
        await ensureWireCodecReady();
      }
    }
    // 0xC8 is the peer envelope-v2 format (CBOR/zstd), not the HTTP JSON format; route to decode().
    if (first === 0xc8) {
      return decode(asWireBytes(bytes));
    }
    return decodeHttpBody(asHttpWireBytes(bytes));
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
   *
   * Gate class = MESSAGE-CONTENT reads/writes (anything carrying or returning sealed_b64
   * whose interpretation crypto_mode governs): send / sendText / sendFile / sendProductCard /
   * updateMessage / batchAppend / #fetchRows (list) / subscribe / getThread. A proven
   * downgrade must fail these closed.
   *
   * EXEMPT tier = INTERACTION-METADATA, cleartext by wire contract and NOT governed by
   * crypto_mode: sendReaction / removeReaction / sendTyping / sendPresence / markRead /
   * pinMessage / unpinMessage / listPins. Intentionally NOT gated — a poisoned room's
   * sealed content is refused, but its cleartext metadata channel is not message content.
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
      this.#boundActiveCryptoModeMap(roomId);
    }
    return resolved;
  }

  /**
   * SEC-CR-17-01 (availability): keep #activeCryptoModeByRoom bounded on the
   * list()-only path (subscribe()'s teardownSubscriber only evicts LIVE rooms at
   * chain refCount 0). Evicts the OLDEST entries whose room has NO live subscription
   * until the map is within ACTIVE_CRYPTO_MODE_MAP_CAP.
   *
   * Eviction is bounded FIFO / insertion-order, NOT LRU: #resolveRoomCryptoMode sets
   * unconditionally and Map.set on an existing key does not reorder, so a re-listed room does
   * not move to the back. For the page-once-per-room access pattern this equals LRU and is
   * simpler; a genuinely hot room is not specially protected (acceptable — it re-resolves on
   * its next list()).
   *
   * Never evicts:
   *   - the room just resolved (justResolvedRoomId) — it is the freshest read;
   *   - a room with a LIVE subscription (decrypt-chain refCount > 0) — its cached
   *     mode is load-bearing for streamed-frame dispatch and is released by teardown;
   *   - #poisonedRooms — a SEPARATE authoritative set: evicting a mode entry can never
   *     un-poison a room (#assertRoomNotPoisoned reads #poisonedRooms alone, and a
   *     poisoned room can never re-resolve — the fetch is refused first).
   */
  #boundActiveCryptoModeMap(justResolvedRoomId: string): void {
    while (this.#activeCryptoModeByRoom.size > ACTIVE_CRYPTO_MODE_MAP_CAP) {
      let evicted = false;
      // Map iteration is insertion-order → the first eligible key is the oldest.
      for (const roomId of this.#activeCryptoModeByRoom.keys()) {
        if (roomId === justResolvedRoomId) continue;
        if (this.#decryptChain.refCountOf(roomId) > 0) continue;
        this.#activeCryptoModeByRoom.delete(roomId);
        evicted = true;
        break;
      }
      // All remaining entries are live subscriptions — legitimately bounded by the
      // live-subscription count (teardownSubscriber releases them), so stop.
      if (!evicted) break;
    }
  }

  /**
   * @internal test-only: current sizes of the per-room crypto-state collections.
   * Lets tests assert eviction (discovered-mode entries released on last teardown)
   * and poison stickiness without exposing the private fields. Not exported/stable.
   */
  _roomCryptoStateSize(): { modes: number; poisoned: number } {
    return { modes: this.#activeCryptoModeByRoom.size, poisoned: this.#poisonedRooms.size };
  }

  /**
   * @internal test-only: number of live per-room decrypt-chain entries. Lets tests
   * assert the chain DRAINS + its entry is cleaned up after a force-drain (no Map leak)
   * without exposing the private field. Not exported/stable.
   */
  _decryptChainSize(): number {
    return this.#decryptChain.entryCount();
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
    const msgId = args.msgId ?? generateUUID();
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

    // Phase 2 + W6 E2EE + W7/W9 (pr-review-council MED-3): dispatch through the
    // shared helper so list() resolves plaintext/E2EE/on-chain-vs-off-chain
    // identically to getThread() and searchByProductRef() — see
    // #unsealFetchedRows for the plaintext/E2EE/decrypt-chain rationale.
    const items = await this.#unsealFetchedRows(roomId, rawItems);

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
   * `mappedRow`, deliver via `onMessage`, exactly once. The task NEVER rejects
   * (unseal failure → unsealError; a throwing onMessage is caught) so a link can't
   * poison the room's chain. Shared by the live subscribe() SSE stream, the
   * reconnect replay path (SEC-CR-14-01), and list() scrollback (SEC-CR-14-02) so
   * all three serialize on the SAME queue.
   *
   * Two bounds (fix/e2ee-unseal-cancel), reconciling one-in-flight with bounded-drain:
   *   1. **Abort deadline (`DEADLINE_MS`)** — an AbortController fired at the deadline
   *      and passed to `provider.unseal`. A signal-honoring provider (a future worker /
   *      streaming / KMS-with-abort backend, or the built-in provider at its await
   *      boundaries) rejects promptly, so the chain advances at the deadline without
   *      waiting the full grace. The task AWAITS the unseal's REAL settle (no
   *      Promise.race that abandons the loser), so a healthy provider gives strictly
   *      **at most one unseal in flight per room** — the built-in WebCrypto decrypt is
   *      atomic + non-cancellable but sub-ms, so it never even reaches the deadline.
   *   2. **Force-drain bound (`DEADLINE_MS + GRACE_MS`)** — if the unseal has STILL not
   *      settled by deadline+grace (a provider that both ignores the AbortSignal AND
   *      hangs), this ONE row is bailed as `unsealError` so the chain **drains**: the
   *      next unseal runs, `list()`/`Promise.all` resolves, `RoomDecryptChain`'s entry
   *      is cleaned up (no Map leak / no room-wide black-hole). The stuck unseal is
   *      orphaned; the `settled` guard drops its late result so it can neither
   *      re-deliver nor advance the chain / room ratchet-observable state.
   *
   * So: healthy provider (incl. built-in) → strict one-in-flight, real plaintext in
   * order; genuinely-stuck non-honoring provider → that one row lost as `unsealError`,
   * chain bounded-drains after grace, contained per-room (rooms are independent). The
   * ONLY inherent residual is that JS cannot cancel a still-pending promise, so a
   * hang-forever provider leaks its own orphaned unseal continuation (one per
   * force-drained row) until IT settles — honoring the signal is what releases it.
   * Each timer boundary emits a distinct warn (repo rule: a decrypt failure must log
   * or bump a metric; the SDK has no metric seam, so a warn in the existing idiom).
   *
   * NOTE on the deadline timer: a manual `AbortController` + `setTimeout` is used
   * rather than `AbortSignal.timeout()` because the latter is NOT controllable by the
   * test harness's fake timers (empirically: `vi.advanceTimersByTimeAsync` does not
   * fire it, and `toFake: ['AbortSignal']` does not bridge it), and a manual
   * force-drain `setTimeout` is required regardless (there is no stdlib
   * "resolve-after-timeout"). The stdlib `signal.throwIfAborted()` IS reused inside
   * the built-in provider (`sframe.ts`), where it is timer-independent.
   *
   * `source` tags the log line (e.g. 'decrypt task' for the stream, 'list()
   * scrollback' for pagination) so a failure's origin is legible in triage.
   *
   * No-op unless a crypto provider is configured (callers already gate on this;
   * the guard keeps the method self-contained). RoomDecryptChain.append gates on a
   * live subscriber, so a task for a torn-down room is dropped, not run.
   */
  #appendDecryptTask(
    roomId: string,
    mappedRow: MessageRow,
    onMessage: (row: MessageRow) => void,
    source = 'decrypt task',
  ): void {
    const provider = this.#cryptoProvider;
    if (provider === null) return;
    const deadlineMs = DECRYPT_DEADLINE_MS;
    const forceDrainMs = deadlineMs + DECRYPT_FORCE_DRAIN_GRACE_MS;
    this.#decryptChain.append(roomId, async () => {
      const ctx: SealContext = { roomId, senderUid: mappedRow.senderUid };

      // The row is delivered exactly once, by whichever fires first: the real unseal
      // settle, or the force-drain bound. `settled` gates every delivery site so a
      // late orphaned unseal (a hung non-honoring provider) can neither re-deliver nor
      // advance the chain.
      let settled = false;
      let out: MessageRow | null = null;
      const settleWith = (row: MessageRow): boolean => {
        if (settled) return false;
        settled = true;
        out = row;
        return true;
      };

      // (1) Abort deadline: ask the provider to stop. A signal-honoring provider
      // rejects promptly so the chain advances at the deadline; the built-in provider
      // honors it at its await boundaries. Manual AbortController (not
      // AbortSignal.timeout) so the test harness's fake timers can drive it.
      const controller = new AbortController();
      const deadlineTimer = setTimeout(() => {
        controller.abort(new DOMException(`unseal deadline exceeded (${deadlineMs}ms)`, 'TimeoutError'));
        console.warn(
          `[chat-sdk] ${source}: unseal exceeded ${deadlineMs}ms deadline; signalling abort (delivers normally if it still settles within the force-drain grace) for seq`,
          mappedRow.seq,
        );
      }, deadlineMs);

      // (2) Force-drain bound: if the unseal has STILL not settled by deadline+grace,
      // bail this ONE row as unsealError so the chain DRAINS (bounded) instead of
      // black-holing the room for the client's lifetime. The stuck unseal is orphaned
      // (JS cannot cancel a pending promise); the `settled` guard drops its late result.
      let forceDrainTimer: ReturnType<typeof setTimeout> | undefined;
      const forceDrain = new Promise<void>((resolve) => {
        forceDrainTimer = setTimeout(() => {
          if (settleWith({ ...mappedRow, unsealError: 'unknown', plaintext: undefined })) {
            console.warn(
              `[chat-sdk] ${source}: unseal did not settle within ${forceDrainMs}ms; force-draining the room chain (row lost as unsealError, stuck unseal orphaned) for seq`,
              mappedRow.seq,
            );
          }
          resolve();
        }, forceDrainMs);
      });

      // Run the unseal; it delivers only if the force-drain has not already claimed
      // this row (the `settled` guard). It catches internally so a hung, later-settling
      // provider never surfaces an unhandled rejection.
      const runUnseal = (async (): Promise<void> => {
        try {
          const plaintext = await provider.unseal(mappedRow.sealed, ctx, controller.signal);
          settleWith({ ...mappedRow, plaintext });
        } catch (err) {
          if (settled) return; // force-drain already delivered this row → drop the late error
          // Suppress the generic warn only for OUR abort (identified by its own reason),
          // NOT by elapsed time: a genuine AEAD/replay error — even one surfacing after
          // the deadline — keeps its logged detail and its own classification.
          if (err !== controller.signal.reason) {
            console.warn(`[chat-sdk] ${source}: unseal failed for seq`, mappedRow.seq, err);
          }
          settleWith({ ...mappedRow, unsealError: classifyUnsealError(err), plaintext: undefined });
        }
      })();

      // Advance when the FIRST of (unseal settles | force-drain fires) delivers. For a
      // hung provider `runUnseal` never resolves, so the force-drain arm is what lets
      // the chain drain.
      try {
        await Promise.race([runUnseal, forceDrain]);
      } finally {
        // On the healthy path both timers are cleared so no deadline/force-drain timer
        // (and its captured closure) lingers; clearTimeout on an already-fired timer is a
        // safe no-op.
        clearTimeout(deadlineTimer);
        clearTimeout(forceDrainTimer);
      }

      // Deliver exactly once, AFTER the race, so a throwing caller callback neither
      // re-delivers the row as an unseal error nor rejects the link (which would wedge
      // the room's serial chain). `out` is always set — the race resolves only via a
      // settleWith() call.
      try {
        onMessage(out!);
      } catch (cbErr) {
        console.warn(`[chat-sdk] ${source}: onMessage threw for seq`, mappedRow.seq, cbErr);
      }
    });
  }

  /**
   * Unseal a fetched page of rows THROUGH the room's serial #decryptChain and
   * return them decrypted, IN SERVER ORDER. Used by list() ONLY when the room has
   * a live subscription (refCountOf > 0) so scrollback / pagination unseal
   * serializes with the streamed + reconnect-replay unseal on the SAME queue — at
   * most one unseal in flight per room (SEC-CR-14-02).
   *
   * Reuses #appendDecryptTask (5s timeout, never-rejects, refCount-gated) so
   * on-chain scrollback obeys the SAME chain-drain contract as the live stream;
   * each task's onMessage resolves that row's slot, so we collect the ordered
   * result via Promise.all (which preserves input-array order regardless of
   * settle order).
   *
   * Appends run in ONE synchronous burst — each Promise executor runs
   * #appendDecryptTask synchronously during the map — so no teardown / subscribe
   * interleaves between the caller's refCount check and these appends: the whole
   * page is queued atomically while refCount is still > 0, so no append no-ops
   * (a no-op would drop a row and hang this Promise.all). Already-queued tasks
   * still drain even if the subscription tears down afterward — release() defers
   * entry removal until the chain drains — so the returned promise always settles.
   */
  #unsealRowsOnChain(roomId: string, rawItems: MessageRow[]): Promise<MessageRow[]> {
    return Promise.all(
      rawItems.map(
        (row) =>
          new Promise<MessageRow>((resolve) => {
            this.#appendDecryptTask(roomId, row, resolve, 'list() scrollback');
          }),
      ),
    );
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
        let cursor = lastSeq;
        while (true) {
          // Teardown may have raced the replay fetch: a torn-down subscriber must
          // deliver nothing AND must not append onto a co-subscriber's still-live
          // chain (append gates on refCount, which a surviving co-subscriber keeps
          // > 0). Mirrors the live-stream guard in the onmessage handler.
          if (destroyed) return;
          const { rawItems, hasMore, nextCursor } = await this.#fetchRows(roomId, { afterSeq: cursor });
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
          if (!hasMore) break;
          // Server is UNTRUSTED (E2EE threat model): a has_more=true page whose
          // next_cursor does not strictly advance past the current cursor would
          // spin this loop forever re-fetching the same page. Mirrors #fetchRows'
          // has_more/next_cursor==null guard above (~line 805) in convention.
          if (nextCursor == null || nextCursor <= cursor) {
            throw new SDKChatError(
              'server_error',
              'replay: non-monotonic pagination cursor from server',
            );
          }
          cursor = nextCursor;
        }
      } catch (err) {
        // Surface replay failures to the caller; the reconnect flow still re-attaches for
        // transient (network / server) failures.
        reportError(err);
        // #43 + SEC-CR-17-G-02: a crypto_mode enforcement failure during replay is not a
        // transient error — either #resolveRoomCryptoMode just poisoned this room
        // (crypto_mode_mismatch), or the room was ALREADY poisoned by a sibling
        // co-subscriber (#fetchRows → #assertRoomNotPoisoned throws crypto_mode_poisoned).
        // Tear THIS subscription down immediately (mirror the connected handler's contract)
        // instead of re-attaching — a re-attach would only re-throw poisoned on the next
        // replay, an endless reconnect loop against a bricked room.
        if (
          err instanceof SDKChatError &&
          (err.code === 'crypto_mode_mismatch' || err.code === 'crypto_mode_poisoned')
        ) {
          teardownSubscriber();
        }
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
        // SEC-CR-001 memory hygiene: when the LAST subscriber for this room tears down
        // (chain refCount hit 0), evict the room's DISCOVERED crypto-mode so the per-room
        // Map is bounded to live rooms (reuses the decrypt-chain refcount as the
        // last-subscriber signal). #poisonedRooms is intentionally NOT evicted — a
        // poisoned room stays fail-closed for the client's lifetime ("recreate the client
        // to retry"), and it only ever grows under an ACTIVE downgrade attack, never in
        // normal operation, so its growth is bounded by the attack surface, not room count.
        if (this.#decryptChain.refCountOf(roomId) === 0) {
          this.#activeCryptoModeByRoom.delete(roomId);
        }
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
   *
   * SEC-CR-17-02: fails CLOSED for a poisoned room — a thread is message content, so it
   * belongs to the same gate class as list()/#fetchRows (a room proven to have a
   * downgraded/tampered crypto_mode must not keep serving its content). Unlike list(),
   * getThread does NOT resolve crypto_mode: the threads endpoint returns a BARE JSON array
   * with no per-response crypto_mode field (crates/sdk/src/messages/dtos.rs — only list()'s
   * page wrapper carries it), and getThread returns rows with `sealed` intact (the caller
   * unseals), so there is no plaintext-vs-sframe dispatch that would need the mode. The
   * poison gate is the relevant boundary here.
   */
  async getThread(roomId: string, rootMsgId: string): Promise<MessageRow[]> {
    this.#assertRoomNotPoisoned(roomId);
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

    const rawItems = json.map(rowToMessageRow);
    return this.#unsealFetchedRows(roomId, rawItems);
  }

  /**
   * W7 + W9: unseal/decrypt a list of fetched rows, preserving the same
   * plaintext / E2EE / poison semantics as list() and subscribe().
   * Used by list(), getThread() and searchByProductRef() — all three now
   * dispatch through this single implementation (pr-review-council MED-3:
   * list() previously kept a divergent inline copy that skipped the
   * #cryptoMode fallback below).
   */
  async #unsealFetchedRows(roomId: string, rawItems: MessageRow[]): Promise<MessageRow[]> {
    // Prefer the per-room discovered mode, then the configured expectation.
    // This matches the fallback used by send() / sendText() (#effectiveMode) —
    // a room whose crypto_mode has not yet been discovered (server omitted the
    // envelope field) still resolves against the client's own configured intent
    // instead of silently skipping the plaintext/E2EE dispatch.
    const mode = this.#activeCryptoModeByRoom.get(roomId) ?? this.#cryptoMode;

    if (mode === 'plaintext') {
      // Plaintext mode: sealed is raw UTF-8 bytes — just expose as plaintext.
      return rawItems.map(aliasSealedAsPlaintext);
    }

    if (this.#cryptoProvider !== null) {
      // W6 E2EE: post-decrypt rows when a crypto provider is configured. Failed
      // decryptions are PRESERVED with unsealError set (not dropped) so
      // pagination counts remain accurate and callers can detect potential attacks.
      //
      // SEC-CR-14-02: if THIS room has a LIVE subscription, its per-room
      // #decryptChain owns the SFrame ratchet — unsealing this fetched page
      // off-chain would run a SECOND unseal on that ratchet while a streamed /
      // reconnect-replay unseal is still in flight, desyncing the ratchet /
      // replay window (the class #14 closed on the stream and #15 on reconnect).
      // Route the unseal through the SAME serial chain so scrollback / pagination
      // can never run concurrently with the live stream for that room. If the
      // room has NO live subscription (refCount 0) there is no chain entry —
      // appending would no-op and DROP every row — AND no streamed unseal can
      // race, so unseal directly off-chain.
      //
      // The refCount check and the on-chain appends run in ONE synchronous burst
      // (#unsealRowsOnChain appends before its first await), so no subscribe /
      // teardown interleaves between the check and the dispatch: the whole page
      // is queued atomically while refCount is still > 0. The common case (a
      // stable subscription during scrollback) is thus always serialized.
      //
      // Two documented residual off-chain windows remain, both requiring
      // refCount == 0 at dispatch, both strictly rarer than and no-worse than
      // main (which unseals list() off-chain UNCONDITIONALLY, racing even at
      // refCount > 0). Neither can be closed by on-chaining a chainless room —
      // append() no-ops at refCount 0 and would DROP the rows (the footgun #14/#15
      // scoped around):
      //   (1) a subscription that APPEARS after a refCount-0 dispatch runs its
      //       first streamed unseal concurrently with this one-shot fetch;
      //   (2) a fetch issued during release()'s deferred-delete DRAIN window —
      //       the entry lingers at refCount 0 while a torn-down subscriber's last
      //       streamed unseal is still draining (see RoomDecryptChain.release) —
      //       runs off-chain concurrently with that draining unseal.
      //
      // Timeout ASYMMETRY (by design, same call, different failure semantics by
      // subscription state): the on-chain path (refCount > 0) inherits
      // #appendDecryptTask's abort-deadline + force-drain bound — a stuck row is
      // aborted at the deadline and, if it still hasn't settled, bailed as an
      // unsealError at deadline+grace so the chain drains (bounded) — whereas the
      // off-chain path (refCount 0) awaits provider.unseal with NO bound and hangs
      // the fetch indefinitely on a stuck row. See the changeset for the
      // caller-facing note.
      if (this.#decryptChain.refCountOf(roomId) > 0) {
        return this.#unsealRowsOnChain(roomId, rawItems);
      }

      // No live subscription: unseal directly off-chain.
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
          console.warn('[chat-sdk] unseal failed for seq', row.seq, err);
          decrypted.push({ ...row, unsealError: classifyUnsealError(err) });
        }
      }
      return decrypted;
    }

    return rawItems;
  }

  // ── W2: Edit / delete / pin ────────────────────────────────────────────────

  /**
   * Edit a message (only the original sender may edit).
   * Wire-contract: PATCH /api/sdk/messages/:room_id/:msg_id
   * Body: { sealed_b64 }
   * Scope: chat:write:<room_id>.
   */
  async updateMessage(roomId: string, msgId: string, args: UpdateMessageArgs): Promise<void> {
    // SEC-CR-001: fail-CLOSED — updateMessage transmits new sealed_b64 CONTENT to the
    // room, so a room with a proven-tampered crypto_mode must refuse edits too.
    this.#assertRoomNotPoisoned(roomId);
    const payload = {
      sealed_b64: arrayBufferToBase64(args.sealed),
    };
    const body = await this.#encodeBody(payload);

    let resp: Response;
    try {
      resp = await fetch(
        `${this.#baseUrl}/api/sdk/messages/${encodeURIComponent(roomId)}/${encodeURIComponent(msgId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
            Authorization: `Bearer ${this.#jwt}`,
          },
          body: body as BodyInit,
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
    // SEC-CR-001: fail-CLOSED — sendFile presigns + uploads a file BODY for the room
    // (sendFileHelper → presign POST + PUT + send()); a proven-tampered room must refuse
    // it. Gate here in the wrapper so the presign never fires for a poisoned room.
    this.#assertRoomNotPoisoned(roomId);
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

    const msgId = args.msgId ?? generateUUID();
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
        productRef: args.productRef,
        productMeta: args.productMeta,
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
          // CR17-C-01: ONE outbox permanence doctrine across all three write paths — the same
          // PERMANENT_OUTBOX_FAILURE_CODES authority flushOutbox uses. A PERMANENT failure
          // (4xx / crypto_mode_*) can never succeed → scrub the durable entry, notify, give up.
          // A TRANSIENT failure (network / 401 / 429 / 5xx) is retriable → keep the ciphertext
          // queued (do NOT dequeue) and retry with backoff; after MAX_RETRIES it is left queued
          // for flushOutbox and onFailed fires. Never drop a refreshable-401 / rate-limited /
          // 5xx entry on the foreground path (the exact codes CR17-C-01 protects).
          if (PERMANENT_OUTBOX_FAILURE_CODES.has(err.code)) {
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
   * Messages that succeed are dequeued. A message that fails with a PERMANENT error
   * (crypto_mode_poisoned / 4xx client error — see PERMANENT_OUTBOX_FAILURE_CODES) is
   * also dequeued, so a truly-undeliverable entry does not retry forever (CR17 Item C).
   * A TRANSIENT failure (network / 401 / 429 / 5xx) stays queued for the next flush —
   * this is a background durability path with no caller notification, so dropping a
   * retriable ciphertext message would be silent E2EE message loss (CR17-C-01).
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
          productRef: m.productRef,
          productMeta: m.productMeta,
        });
        await dequeue(roomId, m.msgId);
      } catch (e) {
        const err = e instanceof SDKChatError ? e : new SDKChatError('network', String(e));
        // Scrub ONLY a permanently-failed entry; keep transient failures queued (fail-safe).
        if (PERMANENT_OUTBOX_FAILURE_CODES.has(err.code)) {
          await dequeue(roomId, m.msgId);
        }
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
        msgId: args.msgId ?? generateUUID(),
        done,
        onPending: (_cb) => handle,
        onSucceeded: (_cb) => handle,
        onFailed: (cb) => { failCbs.push(cb); done.catch(cb); return handle; },
      };
      return handle;
    }

    const provider = this.#cryptoProvider;
    const msgId = args.msgId ?? generateUUID();
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
        productRef: args.productRef,
        productMeta: args.productMeta,
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
          // CR17-C-01: same unified outbox permanence doctrine as sendOptimistic — dequeue only
          // on a PERMANENT code; keep a transient (network / 401 / 429 / 5xx) entry queued for
          // flushOutbox rather than dropping a retriable ciphertext message.
          if (PERMANENT_OUTBOX_FAILURE_CODES.has(err.code)) {
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
    const body = await this.#encodeBody(payload);

    let resp: Response;
    try {
      resp = await fetch(`${this.#baseUrl}/api/sdk/messages/batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#jwt}`,
          'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
        },
        body: body as BodyInit,
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
   *
   * API role (#114): this is the PUBLIC external-integrator convenience API for
   * sending a product-card message in a single call. The in-house
   * `@oxpulse/chat-widget` composer deliberately does NOT call this method —
   * it routes cards through `sendText()` with `productRef`/`productMeta` args
   * (see Composer.setProductCard in packages/chat-widget/src/ui/composer.ts)
   * so the card travels the same send path as the caption text. Both paths
   * produce the same wire payload; the split is an integrator-convenience vs.
   * in-house-routing decision, not a behavioral difference. Do NOT reroute the
   * widget to use this method — the composer's send-enable logic, error-chip
   * retry, and attachment-fallback paths all depend on the shared `sendText`
   * entrypoint.
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
    const payload: Record<string, unknown> = {
      room_id: roomId,
      msg_id: opts.msgId ?? generateUUID(),
      sender_uid: opts.senderUid,
      product_ref: opts.productRef,
      product_meta: opts.productMeta,
    };
    if (opts.sealedBody !== undefined) {
      payload['sealed_b64'] = arrayBufferToBase64(opts.sealedBody);
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
    // SEC-CR-17-B-01: searchByProductRef returns sealed message-content rows (same gate
    // class as getThread / list()). When scoped to a single room, fail CLOSED if that room
    // was poisoned by a prior crypto_mode_mismatch. The cross-room variant (no roomId) is
    // rejected by the SERVER today (GET /api/sdk/messages?product_ref requires room_id and
    // returns 400 — cross-room search is deferred until a `platform:search:*` scope ships,
    // see the server's handle_product_search), so no rows are returned and there is nothing
    // to gate. IF cross-room search later ships, revisit this: results could span a poisoned
    // room, needing a per-row #poisonedRooms filter here (rows come back sealed, so a tampered
    // row still fails AEAD on unseal — a completeness gap, not a plaintext leak).
    if (opts?.roomId) {
      this.#assertRoomNotPoisoned(opts.roomId);
    }
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
    const rawItems = rows.map(rowToMessageRow);
    const roomId = opts?.roomId ?? '';
    return this.#unsealFetchedRows(roomId, rawItems);
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
