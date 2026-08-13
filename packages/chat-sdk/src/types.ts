/**
 * Public types for @oxpulse/chat-sdk.
 */

import type { SDKChatError } from './errors.js';

// ── Phase 2: crypto_mode types ────────────────────────────────────────────────

/**
 * Server-negotiated crypto mode for a room.
 *
 * - 'sframe-static': messages are E2EE-sealed via sframe-ratchet (default).
 * - 'plaintext': messages are UTF-8 encoded but NOT encrypted server-side;
 *   the client skips seal/unseal and delivers plaintext directly.
 *
 * Emitted by the server in:
 *   - GET /api/sdk/messages response envelope (crypto_mode field)
 *   - SSE `event: connected` prelude data (crypto_mode field)
 */
export type CryptoMode = 'sframe-static' | 'plaintext';

// ── W6: E2EE types ────────────────────────────────────────────────────────────

/**
 * Context passed to CryptoProvider.seal / unseal identifying sender and room.
 */
export interface SealContext {
  roomId: string;
  senderUid: string;
}

/**
 * E2EE crypto backend for SDKChatClient.
 * Implement this interface to supply a custom encryption scheme.
 * The built-in 'sframe' provider uses sframe-ratchet v0.5 chat-mode.
 */
export interface CryptoProvider {
  /**
   * Encrypt plaintext bytes. Returns ciphertext as ArrayBuffer.
   * Called by sendText() before sending to the server.
   */
  seal(plaintext: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer>;

  /**
   * Decrypt ciphertext bytes. Returns plaintext as ArrayBuffer.
   * Called by list() and subscribe() on each received row.
   * Should throw on auth failure or replay (row will be skipped with a warn log).
   *
   * `signal` (OPTIONAL, backward-compatible) is aborted by the SDK when the per-row
   * unseal deadline is exceeded. Honoring it lets a stuck unseal reject PROMPTLY so the
   * room's serial decrypt chain advances at the deadline (strict one-in-flight) rather
   * than waiting the SDK's force-drain grace. A cancel-capable provider (worker /
   * streaming / KMS-with-abort) SHOULD honor it and reject; a provider that ignores it
   * is still correct — the SDK BOUNDS it with a force-drain at deadline+grace (that one
   * row is delivered as an unseal error and the chain drains, so a hung provider never
   * black-holes the room). NOTE: the built-in WebCrypto AES-GCM decrypt is atomic and
   * takes no AbortSignal — it cannot be cancelled mid-flight — so the built-in provider
   * honors the signal only at its await boundaries (before the decrypt); that is why
   * the parameter is optional and advisory, not a guaranteed cancel for every provider.
   */
  unseal(sealed: ArrayBuffer, ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer>;

  /** Release any resources held by the provider. */
  dispose?(): void;
}

/**
 * E2EE configuration for SDKChatClient.
 *
 * When present, sendText() / sendTextOptimistic() encrypts before sending and
 * list()/subscribe() transparently decrypt each row. Rows that fail to decrypt
 * are preserved with unsealError set rather than silently dropped.
 *
 * Two shapes (discriminated union):
 * - provider: 'sframe' — use the built-in sframe-ratchet v0.5 chat provider; requires getKey.
 * - provider: CryptoProvider — supply a custom CryptoProvider instance; getKey is not used.
 */
export type E2EEOptions =
  | {
      /**
       * Built-in sframe-ratchet v0.5 chat provider.
       * Requires getKey to return an HKDF base-key.
       */
      provider: 'sframe';
      /**
       * Key factory called by the built-in sframe provider.
       * MUST return a CryptoKey with usages ['deriveKey','deriveBits'] (HKDF base-key).
       * Do NOT pass an AES-GCM key — sframe-ratchet derives its own AES-128-GCM key
       * via HKDF internally.
       *
       * @example
       * ```ts
       * const sharedHkdfKey = await crypto.subtle.importKey(
       *   'raw', sharedSecret32Bytes, 'HKDF', false, ['deriveKey', 'deriveBits']
       * );
       * getKey: async (_roomId) => sharedHkdfKey
       * ```
       */
      getKey: (roomId: string) => Promise<CryptoKey>;

      /**
       * CTR allocation strategy for sframe-ratchet. Default `'random-64'`.
       * `'monotonic-idb'` persists the SENDER's counter (requires `ctrKeyspace`) and avoids
       * the random-64 birthday bound; it does NOT by itself protect the receiver across
       * reloads — that is `durableReplay` (SEC-CR-003).
       */
      ctrStrategy?: 'random-64' | 'monotonic-idb';
      /** Required when `ctrStrategy` is `'monotonic-idb'`; namespaces sframe-ratchet's CTR store. */
      ctrKeyspace?: string;
      /** In-memory replay window size for sframe-ratchet (session-scoped). Default 1024; `0` disables it. */
      replayWindow?: number;
      /**
       * SEC-CR-003: durable, cross-reload receiver-side anti-replay. Default ON when IndexedDB is
       * available, graceful no-op (one-time warn) when it is not. Set `false` to opt out.
       */
      durableReplay?: boolean;
      /**
       * Namespace for the durable replay IDB store. Defaults to the client's `appId` (falling back
       * to `'default'`), so distinct tenants on the same origin do not share a replay window.
       */
      durableReplayNamespace?: string;
      /** Durable replay window size (distinct recent CTRs per sender per room). Default 1024; `0` disables it. */
      durableReplayWindow?: number;
    }
  | {
      /**
       * Custom CryptoProvider instance.
       * getKey is not applicable when using a custom provider.
       */
      provider: CryptoProvider;
    };

export interface SDKChatClientOptions {
  /** Base URL of the OxPulse server (no trailing slash). */
  baseUrl: string;
  /**
   * Bearer JWT obtained from POST /api/sdk/tokens.
   * Must NOT include the "Bearer " prefix.
   */
  jwt: string;
  /**
   * Compression mode for outgoing POST /api/sdk/messages requests.
   *
   * - 'none' (default): plain JSON body — byte-identical to existing behaviour.
   * - 'auto': zstd dictless (magic byte 0xC6) when the payload is at least
   *           `minCompressBytes` bytes; falls back to plain JSON for smaller payloads.
   * - 'dict': zstd with shared dict (magic byte 0xC7, u16 BE dict-id) using
   *           `dictHint` or the RU dict by default; falls back to 'auto' behaviour
   *           if the dict is not yet loaded.
   */
  compression?: 'none' | 'auto' | 'dict';
  /**
   * Payload size threshold (in bytes) below which 'auto'/'dict' fall back to
   * plain JSON. Default: 256.
   */
  minCompressBytes?: number;
  /**
   * Custom dict loader for 'dict' mode. Module-global: last construction wins.
   * Mutually exclusive with dictBaseUrl (loader takes precedence).
   * See @oxpulse/wire-codec DictLoader for the function signature.
   * Module-global state: constructing multiple SDKChatClient instances with different loaders
   * produces non-deterministic dict loading. Use one client instance per application.
   */
  dictLoader?: import('@oxpulse/wire-codec').DictLoader;
  /**
   * Base URL from which shared dicts are fetched (e.g. '/dicts').
   * Used only when dictLoader is not provided. Module-global: last construction wins.
   */
  dictBaseUrl?: string;
  /**
   * Hint for which shared dict to use in 'dict' mode.
   * Defaults to 'zstd-dict-ru-v1' if not specified.
   */
  dictHint?: import('@oxpulse/wire-codec').DictName;
  /**
   * W6 outbox: test-only flag — disables exponential backoff sleep so retry tests run
   * without wall-clock delays. Never set in production code.
   * @internal
   */
  _testNoSleep?: boolean;

  /**
   * Application namespace identifier — matches the JWT `aud` claim and
   * scopes messages to a multi-tenant application bucket on the server
   * (e.g. `demo_marketplace`, partner integrations). The client passes
   * it through but does NOT enforce it locally; server-side scope check
   * is authoritative. Optional for backwards compatibility: when omitted
   * the server falls back to the JWT `aud` claim alone.
   */
  appId?: string;

  /**
   * W6: optional E2EE configuration.
   * When present, sendText() encrypts and list()/subscribe() auto-decrypt.
   */
  e2ee?: E2EEOptions;

  /**
   * Phase 2: override the expected server-emitted crypto_mode.
   *
   * When set, the client validates that the server-emitted crypto_mode matches
   * this value on every list() response and subscribe() prelude. A mismatch
   * throws SDKChatError('crypto_mode_mismatch') and aborts the operation.
   *
   * When unset (default), the client auto-detects the crypto_mode from the
   * first server emission and caches it for the session.
   *
   * Rationale (SEC-CR-1694): a compromised signaling-server could downgrade a
   * client compiled for 'sframe-static' by emitting 'plaintext'. Silent
   * acceptance = downgrade attack. This option makes the client's expectation
   * explicit and non-bypassable.
   */
  cryptoMode?: CryptoMode;
}

export interface SendArgs {
  /** Caller-assigned stable user identifier. */
  senderUid: string;
  /**
   * E2EE sealed ciphertext as an ArrayBuffer.
   * Never decrypted server-side.
   */
  sealed: ArrayBuffer;
  /**
   * Optional client-generated idempotency key (UUID v4).
   * If omitted, the client generates one automatically.
   * Duplicate sends with the same msgId are silently deduplicated.
   */
  msgId?: string;
  /**
   * W7: thread reply — UUID of the root message this reply belongs to.
   * Non-sensitive (stored in clear alongside msg_id).
   * Omit for top-level / flat messages.
   */
  threadRootMsgId?: string;
  /**
   * W9: marketplace product reference (non-sensitive SKU / UUID).
   * Stored in clear alongside sealed content — server can index without
   * decrypting (E2EE invariant preserved).
   */
  productRef?: string;
  /**
   * W9: opaque marketplace display metadata (title, price, currency, etc.).
   * Non-sensitive catalog info — server stores and returns as-is.
   * Capped at 8 KiB server-side.
   */
  productMeta?: unknown;
}

export interface ListArgs {
  /** Return messages with seq > afterSeq (exclusive). Defaults to 0. */
  afterSeq?: number;
  /** W1: Return messages with seq < beforeSeq (exclusive) — reverse paging cursor. */
  beforeSeq?: number;
  /** Maximum rows returned. Defaults to 50, server-capped at 200. */
  limit?: number;
}

/**
 * W1: Paginated result from list().
 *
 * Direction-aware: `next` is a thunk that calls list() with the correct
 * cursor argument for the current paging direction.
 * - Forward (afterSeq query): thunk passes next_cursor as `afterSeq`.
 * - Backward (beforeSeq query): thunk passes next_cursor as `beforeSeq`.
 */
export interface ListResult {
  /** Current page of messages, ordered by seq ascending. */
  items: MessageRow[];
  /** True when more messages exist in the current paging direction. */
  hasNext: boolean;
  /**
   * Thunk that fetches the next page in the same direction.
   * Present only when hasNext is true.
   */
  next?: () => Promise<ListResult>;
}

/** W9: Marketplace product display metadata. Non-sensitive catalog info. */
export interface ProductMeta {
  title: string;
  /**
   * Raw numeric price amount (e.g. 19.99, 1200). The server requires a
   * non-negative JSON number — NOT a pre-formatted display string. Callers
   * (widget / host UI) own locale-aware formatting (Intl.NumberFormat) at
   * render time; `currency` is carried separately.
   *
   * #207: was `string` (host-pre-formatted display text); now `number` to
   * match the finalized server contract and enable future numeric
   * price filter/sort.
   */
  price: number;
  currency: string;
  imageUrl: string;
  productUrl: string;
}

export interface MessageRow {
  seq: number;
  msgId: string;
  senderUid: string;
  /** E2EE ciphertext bytes — decoded server-side base64url → ArrayBuffer.
   *  W7 M4 unification: matches web/src/lib/api/sdkChat.ts MessageRow.sealed type. */
  sealed: ArrayBuffer;
  /**
   * W6 E2EE: decrypted plaintext bytes, present when e2ee is configured on the client
   * and unseal() succeeded.
   * Absent (undefined) when e2ee is not configured, or when unseal fails.
   */
  plaintext?: ArrayBuffer;
  /**
   * W6 E2EE: set when the row was received but unseal() failed.
   * The row is preserved in list()/subscribe() results so callers can account for it
   * in pagination and detect potential attacks.
   *
   * - 'replay': duplicate CTR detected (possible replay attack)
   * - 'auth': AEAD authentication failure (tampered, wrong key, or corrupted frame)
   * - 'unknown': any other unseal failure (timeout, key fetch error, etc.)
   *
   * When unsealError is set, plaintext is undefined.
   */
  unsealError?: 'replay' | 'auth' | 'unknown';
  createdAt: string;
  /**
   * W7: present when this message is a thread reply.
   * UUID of the root message. null for top-level messages.
   */
  threadRootMsgId: string | null;
  /**
   * W9: marketplace product reference (non-sensitive SKU / UUID).
   * null for plain chat messages. Server can index + search without
   * decrypting sealed content (E2EE invariant preserved).
   */
  productRef: string | null;
  /**
   * W9 fix-round: marketplace display metadata (title, price, currency,
   * imageUrl, productUrl). Present when productRef is set, null otherwise.
   * Non-sensitive catalog info — server stores and returns without E2EE decryption.
   */
  productMeta: ProductMeta | null;
  /**
   * W2: RFC 3339 timestamp of the last edit. undefined when never edited.
   */
  editedAt?: string;
  /**
   * W2: RFC 3339 timestamp of soft-delete. undefined when not deleted.
   */
  deletedAt?: string;
  /**
   * W2: number of times the message has been edited. 0 when never edited.
   */
  editCount?: number;
}

// ── W2: Edit / delete / pin types ─────────────────────────────────────────────

/** W2: Arguments for editing a message (only the sender may edit). */
export interface UpdateMessageArgs {
  /** New sealed ciphertext — replaces the existing payload. */
  sealed: ArrayBuffer;
}

/** W2: A pinned-message entry returned by listPins(). */
export interface PinnedMessage {
  appId: string;
  roomId: string;
  msgId: string;
  pinnedBy: string;
  pinnedAt: string;
}

// ── W6: Transient event types ─────────────────────────────────────────────────

export interface TypingEvent {
  userId: string;
  ttlSecs?: number;
}

export interface PresenceEvent {
  userId: string;
  lastSeenAt: string;
}

export interface ReadReceiptEvent {
  userId: string;
  lastSeq: number;
}

export interface PresenceUser {
  userId: string;
  lastSeenAt: string;
}

/**
 * W2 fix-pass: a mutation event received from the `sdk_message_log_mutation`
 * SSE channel. Carries metadata for edit / delete / pin / unpin operations.
 * The sealed ciphertext is NOT re-transmitted — re-fetch if needed.
 */
export interface MutationEvent {
  appId: string;
  roomId: string;
  msgId: string;
  /** "edit" | "delete" | "pin" | "unpin" */
  op: string;
  /** RFC 3339 — present on op="edit". */
  editedAt?: string;
  /** Present on op="edit". */
  editCount?: number;
  /** RFC 3339 — present on op="delete". */
  deletedAt?: string;
  /** Present on op="pin". */
  pinnedBy?: string;
}

// ── W3: Reaction types ────────────────────────────────────────────────────────

/**
 * W3: A reaction event received from the mutation SSE channel.
 * Fired for op "reaction_add" | "reaction_remove".
 */
export interface ReactionEvent {
  appId: string;
  roomId: string;
  msgId: string;
  /** Discriminated literal — narrows to exactly the two reaction ops. */
  op: 'reaction_add' | 'reaction_remove';
  /** The emoji / reaction string. */
  reaction: string;
  /** The user who reacted. */
  userId: string;
}

/**
 * W3: Aggregated reaction response from GET /api/sdk/messages/:room/:msg/reactions.
 */
export interface ReactionsResponse {
  /** Map from reaction string to total count of users who reacted with it. Always exact. */
  counts: Record<string, number>;
  /**
   * Map from reaction string to list of user_ids who reacted with it.
   * Capped at 100 entries per emoji. Check `truncated` to detect when the list
   * is incomplete; use `counts` for the accurate total.
   */
  users: Record<string, string[]>;
  /**
   * True when at least one emoji's user list was truncated to 100 entries.
   * Exact counts are always preserved in `counts` regardless of truncation.
   */
  truncated: boolean;
}

export interface SubscribeArgs {
  /** Called for each new message received via SSE. */
  onMessage: (row: MessageRow) => void;
  /** Called when the SSE stream encounters an unrecoverable error. */
  onError?: (err: Error) => void;
  /** W6: called when a typing indicator is received via SSE. */
  onTyping?: (event: TypingEvent) => void;
  /** W6: called when a presence heartbeat is received via SSE. */
  onPresence?: (event: PresenceEvent) => void;
  /** W6: called when a read receipt is received via SSE. */
  onReadReceipt?: (event: ReadReceiptEvent) => void;
  /**
   * W2 fix-pass: called when a mutation event arrives on the SSE stream.
   * Fired for edit / delete / pin / unpin. Clients should update local
   * state (cache invalidation / UI refresh) on receipt.
   */
  onMutation?: (event: MutationEvent) => void;
  /**
   * W3: called when a reaction mutation event arrives on the SSE stream.
   * Fired for op "reaction_add" | "reaction_remove".
   * Clients should update local reaction state on receipt.
   */
  onReaction?: (event: ReactionEvent) => void;
  /**
   * T18: called when a `type:"roster"` invalidation signal arrives on the SSE stream.
   * The event carries NO data — clients must re-fetch GET /api/sdk/roster to get the
   * updated map.  This is an intentional signal-only design (no data in the event).
   */
  onRosterSignal?: () => void;
}

// SDKChatErrorCode lives in errors.ts since 2026-06-05 (cycle break). We
// re-export here so existing consumers' `import { SDKChatErrorCode } from
// './types'` (and the index.ts re-export below) keep working unchanged.
export type { SDKChatErrorCode } from './errors.js';

// ── Visibility ───────────────────────────────────────────────────────────────

/**
 * Room access model.
 *
 * - "member": default; only explicit members may send/read.
 * - "open": any authenticated app-user may append/read; moderation via banned role.
 *
 * Wire field: visibility (string). Server default: "member".
 */
export type RoomVisibility = "member" | "open";

// ── W5: Room + Member types ───────────────────────────────────────────────────

export interface Room {
  appId: string;
  roomId: string;
  title: string | null;
  productRef: string | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
  members: Member[];
  /** Room access model. Server default: "member". */
  visibility: RoomVisibility;
}

/**
 * Lite room shape returned by `listRooms()`. Same fields as `Room` minus
 * `members` and `appId` — call `getRoom(roomId)` to fetch the full member
 * list when needed. `appId` is omitted because the request is JWT-scoped
 * to a single app.
 *
 * Distinct from `Room` to make the type system reflect that membership
 * is NOT populated in the list response.
 */
export interface RoomSummary {
  roomId: string;
  title: string | null;
  productRef: string | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
  /** Room access model. Server default: "member". */
  visibility: RoomVisibility;
}

export interface Member {
  appId: string;
  roomId: string;
  userId: string;
  role: 'owner' | 'member' | 'viewer';
  joinedAt: string;
  lastReadSeq: number;
  active: boolean;
}

export interface CreateRoomArgs {
  roomId?: string;
  title?: string;
  productRef?: string;
  metadata?: Record<string, unknown>;
  initialMembers?: Array<{ userId: string; role?: string }>;
  /**
   * Room access model. Omit to use the server default ("member").
   * Pass "open" to create a room any authenticated app-user can join.
   */
  visibility?: RoomVisibility;
}

export interface UpdateRoomArgs {
  title?: string;
  metadata?: Record<string, unknown>;
  archived?: boolean;
}

// ── #292: Share-link mint + join-by-link ──────────────────────────────────────

/**
 * #292: A minted share link for a room.
 *
 * Returned by `mintShareLink()`. Wire fields (snake_case on the server) are
 * mapped to camelCase here, following the Room/Member convention.
 *
 * `url` is RELATIVE (e.g. `"/s/xA3kP"`) — the caller resolves it against the
 * server base URL or their own share-link landing route.
 */
export interface ShareLink {
  /** Short alias / capability string (e.g. `"xA3kP"`). */
  alias: string;
  /** The room this link grants access to. */
  roomId: string;
  /** RFC 3339 expiry timestamp. */
  expiresAt: string;
  /** Relative URL path (e.g. `"/s/xA3kP"`). */
  url: string;
}

/**
 * #292: Result of joining a room by share link.
 *
 * Returned by `joinByLink()`. `joined: false` means the caller was ALREADY a
 * member — this is the idempotent success path, NOT an error.
 */
export interface JoinResult {
  roomId: string;
  userId: string;
  role: string;
  /** `true` = newly joined; `false` = was already a member (idempotent success). */
  joined: boolean;
}

// -- W6 (outbox): Optimistic send types ---------------------------------------

/**
 * W6 outbox: handle returned by sendOptimistic().
 * Sendbird-style callback chain: onPending / onSucceeded / onFailed.
 * Methods return the same handle for optional chaining.
 */
export interface OptimisticHandle {
  /** Client-generated stable message id used for dedup. */
  readonly msgId: string;
  /**
   * Promise that resolves with {seq, msgId} on success, or rejects
   * with SDKChatError on final failure (MAX_RETRIES exceeded or non-network error).
   * Always attach a .catch() or use onFailed to avoid unhandled rejection.
   */
  readonly done: Promise<{ seq: number; msgId: string }>;
  /** Register a callback fired when the message is queued locally (before first send attempt). */
  onPending(cb: () => void): OptimisticHandle;
  /** Register a callback fired on successful server acknowledgement. */
  onSucceeded(cb: (result: { seq: number; msgId: string }) => void): OptimisticHandle;
  /** Register a callback fired on terminal failure (max retries or non-network error). */
  onFailed(cb: (err: SDKChatError) => void): OptimisticHandle;
}

// -- W7 (batchAppend): Batch message append types ----------------------------

/**
 * Item descriptor for batch send.
 *
 * Public surface uses camelCase. Internal conversion to wire DTO happens in batchAppend().
 * `room_id` is injected by `batchAppend()`; callers provide only these fields.
 * `created_at` is set server-side and MUST NOT be sent by the client.
 *
 * `sealed` must be pre-sealed ciphertext — batchAppend does NOT auto-seal.
 * Use `sendText` / `sendTextOptimistic` for auto-seal.
 */
export interface BatchAppendItem {
  /** UUID identifying the message (serde: string → Uuid on server). */
  msgId: string;
  /** Sealed ciphertext as ArrayBuffer. Absent/null for placeholder rows. Wire encodes as base64. */
  sealed?: ArrayBuffer | null;
  /** Thread root UUID for threaded messages. Absent/null for flat messages. */
  threadRootMsgId?: string | null;
  /** Marketplace product ref. Absent/null for non-product messages. */
  productRef?: string | null;
  /** Marketplace display metadata. Absent/null for non-product messages. */
  productMeta?: unknown;
}

/** @internal Wire DTO for POST /api/sdk/messages/batch — NOT exported from index.ts. */
interface BatchAppendItemDTO {
  msg_id: string;
  sealed_b64?: string | null;
  thread_root_msg_id?: string | null;
  product_ref?: string | null;
  product_meta?: unknown;
}

// ── #294: Room history export types ───────────────────────────────────────────

/**
 * #294: Options for {@link SDKChatClient.exportRoom} / {@link exportRoomHistory}.
 *
 * Export is client-side by construction: the server cannot read `sframe-static`
 * content, so export walks `list()` (which already decrypts every row) and
 * serialises the decrypted rows. No server endpoint is involved.
 */
export interface ExportRoomOptions {
  /** Output format. `'json'` (default) is canonical; `'text'` is human-readable. */
  format?: 'json' | 'text';
  /** Page size passed to each `list()` call. Defaults to 200 (server max). */
  limit?: number;
  /** Honoured between pages — a large room's export is cancellable. */
  signal?: AbortSignal;
}

/**
 * #294: A single row in the export output.
 *
 * A row that failed to unseal is exported as an explicit error entry carrying
 * its `seq`, `msgId` and `unsealError` — `body` is `null`. It is NEVER skipped:
 * silent omission makes a lossy export indistinguishable from a complete one.
 */
export interface ExportMessageRow {
  seq: number;
  msgId: string;
  senderUid: string;
  /** RFC 3339 timestamp (MessageRow.createdAt). */
  ts: string;
  /** Decrypted plaintext body as a UTF-8 string. `null` when `unsealError` is set. */
  body: string | null;
  /**
   * Present when the row could not be exported as plaintext. Three sources, and
   * all three count toward {@link ExportResult.failedRows}:
   * `replay` / `auth` / `unknown` come from a failed `unseal()`; `not-decrypted`
   * means the row arrived with no plaintext and no unseal attempt at all, which
   * is what `list()` returns when no crypto provider is configured for the room.
   */
  unsealError?: 'replay' | 'auth' | 'unknown' | 'not-decrypted';
  /** UUID of the root message for thread replies. `null` for top-level messages. */
  threadRootMsgId?: string | null;
  /** RFC 3339 timestamp of the last edit, when present. */
  editedAt?: string;
  /** RFC 3339 timestamp of soft-delete, when present. */
  deletedAt?: string;
  /** Number of times the message was edited. */
  editCount?: number;
}

/**
 * #294: Result of {@link SDKChatClient.exportRoom} / {@link exportRoomHistory}.
 *
 * Counts let a caller tell a clean export from a lossy one without diffing the
 * output: `failedRows > 0` means some rows could not be decrypted and appear as
 * error entries in the content.
 */
export interface ExportResult {
  /** The format used for `content`. */
  format: 'json' | 'text';
  /** Serialised export output. */
  content: string;
  /** Total rows walked from `list()`. */
  totalRows: number;
  /** Rows successfully decrypted and serialised with a body. */
  exportedRows: number;
  /** Rows that failed to unseal and appear as error entries. */
  failedRows: number;
}


