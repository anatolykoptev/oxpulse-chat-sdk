/**
 * @oxpulse/chat-widget — shared type definitions.
 *
 * All public-facing types are defined here and re-exported from index.ts.
 * Keep this file pure types — no runtime code.
 */

// ── Widget configuration ──────────────────────────────────────────────────────

/** Widget initialisation config. */
export interface WidgetConfig {
  /** OxPulse app ID (from the admin panel). */
  appId: string;
  /** Signed JWT from your backend (POST /api/sdk/tokens). */
  jwt: string;
  /** Room ID to open. */
  roomId: string;
  /** Render mode. 'inline' = shadow DOM in-page; 'iframe' = sandboxed iframe. Default: 'inline'. */
  mode?: 'inline' | 'iframe';
  /** Colour scheme. Default: 'auto' (follows prefers-color-scheme). */
  theme?: 'light' | 'dark' | 'auto';
  /** BCP 47 locale override. Defaults to document / browser locale. */
  lang?: string;
  /** Override the OxPulse API base URL. Default: 'https://oxpulse.chat'. */
  baseUrl?: string;
  /**
   * Called when the JWT expires (HTTP 401 from API).
   * Return a fresh JWT to automatically reconnect.
   */
  onTokenExpired?: () => Promise<string>;
  /** Called on unrecoverable widget errors. */
  onError?: (err: WidgetError) => void;
  /**
   * Failure-counter hook (issue #78): fires on EVERY write-op failure
   * (reaction add/remove, message send) — not just auth errors — so an
   * integrator can count silent write failures without parsing the
   * `oxpulse-chat:write-error` DOM event. Mirrors `onError`'s callback shape.
   */
  onWriteError?: (detail: WriteFailureDetail) => void;
  /**
   * Allow JWTs without aud_origins claim (pre-W1.1 issuers). Default false (deny — recommended).
   * Set to true only when migrating from a legacy token-minting service.
   */
  allowLegacyToken?: boolean;
  /**
   * UID of the currently authenticated user.
   * Used to determine which reaction chips are "own" (data-own=true).
   * TODO(slice 5): derive automatically from JWT sub claim once SDK is wired.
   * Passed via attribute self-uid or programmatic mount options.
   */
  selfUid?: string;
  // Reserved for v3.0 voice/video:
  // withVoice?: boolean;

  /**
   * Enable anonymous read-only mode.
   * When true and no `jwt` is provided, the widget mints a short-lived anon-read
   * token via POST /api/sdk/auth/anon-read-mint and mounts in read-only mode
   * (composer hidden). The token is re-minted automatically before expiry.
   */
  allowAnonRead?: boolean;

  /**
   * @internal — test-only mint override.
   * When provided, `element.ts` calls this instead of the real mintAnonReadToken.
   * Allows unit tests to inject a fake mint call without a network.
   * Never set in production code.
   */
  _mintAnonReadToken?: (opts: { baseUrl: string; appId: string; roomId: string }) => Promise<{
    token: string;
    userId: string;
    expiresAt: number;
  }>;

  /**
   * @internal — test-only factory override.
   * When provided, `element.ts` calls this instead of constructing a real SDKChatClient.
   * Allows unit tests to inject a mock client without a network.
   * Never set in production code.
   */
  _createClient?: (opts: { baseUrl: string; jwt: string; appId: string }) => {
    list(roomId: string, args: { limit: number }): Promise<{ items: import('./ui/message-list.js').MessageRow[]; hasNext: boolean }>;
    subscribe(roomId: string, args: {
      onMessage: (row: import('./ui/message-list.js').MessageRow) => void;
      onError?: (err: unknown) => void;
      onRosterSignal?: () => void;
      onMutation?: (event: { msgId: string; op: string; deletedAt?: string; editedAt?: string; [k: string]: unknown }) => void;
      onReaction?: (event: { msgId: string; op: 'reaction_add' | 'reaction_remove'; reaction: string; userId: string; [k: string]: unknown }) => void;
    }): () => void;
    sendText(roomId: string, args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: ProductMeta }): Promise<{ seq?: number; msgId: string }>;
    getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
    sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
    removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
  };

  // ── Named-write (allow-write) config ───────────────────────────────────────

  /**
   * Enable named-write (authed compose) mode.
   *
   * When true the widget renders a compose UI (input + send button). A write
   * token is obtained from `writeMintEndpoint` (server-side mint on the
   * embedding client's backend). When false (default) the widget is read-only.
   *
   * The write token is separate from the read `jwt` — it is minted with
   * named-identity write capability via the Phase B grant flow.
   *
   * **Supported modes:** `mode:'inline'` (shadow DOM) only. Setting `allowWrite:true`
   * with `mode:'iframe'` logs a console warning and the compose UI is not shown
   * (iframe named-write support is planned for W5).
   */
  allowWrite?: boolean;

  /**
   * URL of the embedding client's own named-write mint endpoint.
   *
   * Required when `allowWrite` is true. The widget POSTs `{ room_id }` to this
   * URL and expects `{ token }` in the JSON response (same contract as
   * `mintNamedWriteToken` in `@oxpulse/chat-sdk`).
   *
   * The backend should exchange the user's session for a named-write grant via
   * POST /api/sdk/auth/group-grant-mint and return the resulting SDK JWT.
   *
   * Example: `writeMintEndpoint: '/api/oxpulse-write-token'`
   */
  writeMintEndpoint?: string;

  /**
   * @internal — test-only mint override for named-write.
   * When provided, `element.ts` calls this instead of `mintNamedWriteToken`.
   * Allows unit tests to inject a fake mint without a network.
   * Never set in production code.
   */
  _mintNamedWriteToken?: (opts: { mintEndpoint: string; roomId: string }) => Promise<string>;

  // ── Roster role badge (P5) ────────────────────────────────────────────────

  /**
   * Label overrides for the roster role badge shown next to a privileged
   * member's name (e.g. `{ moderator: "Seller", owner: "Store owner" }`).
   *
   * Presentation only — a role with no override falls back to the built-in
   * i18n label ("mod" / "owner", localized per `lang`). Roles are sourced
   * from the server's roster response and are NOT client-side authorization:
   * do not use them to gate a privileged operation.
   */
  roleLabels?: Record<string, string>;

  /**
   * Enable/disable reaction UI. When false, the reaction add button and
   * reaction clusters are hidden and the widget does not subscribe to live
   * reaction events. Default: true.
   */
  reactionsEnabled?: boolean;
}

// ── Custom Element observed attributes (kebab-case mirror of WidgetConfig) ───

/** Attribute names observed by <oxpulse-chat>. */
export const OBSERVED_ATTRIBUTES = [
  'app-id',
  'jwt',
  'room-id',
  'mode',
  'theme',
  'lang',
  'self-uid',
  'base-url',
  'allow-anon-read',
  'allow-write',
  'write-mint-endpoint',
  'reactions-enabled',
] as const;

/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export type ObservedAttribute = (typeof OBSERVED_ATTRIBUTES)[number];

// ── Events ────────────────────────────────────────────────────────────────────

/** Map of event types dispatched on <oxpulse-chat> and the window in iframe mode. */
export interface WidgetEventMap {
  /** Fired when the widget has connected and passed origin check. */
  'oxpulse-chat:ready': CustomEvent<{ roomId: string }>;
  /** Fired on unrecoverable error (origin mismatch, bad JWT shape, etc). */
  'oxpulse-chat:error': CustomEvent<WidgetError>;
  /** Fired when the server returns 401; handler should call element.refreshToken(). */
  'oxpulse-chat:token-expired': CustomEvent<{ roomId: string }>;
  /** Fired after a named-write message is successfully sent. */
  'oxpulse-chat:message-sent': CustomEvent<{ roomId: string; msgId: string }>;
  /** Fired when a named-write send attempt fails (non-recoverable, after error chip shown). */
  'oxpulse-chat:write-error': CustomEvent<WidgetError>;
  /**
   * Review finding #4: fired when an attachment's authenticated hydration
   * reaches FINAL failure (after retries exhaust, or immediately for a
   * permanent HTTP 403/404/410). Dispatched from the host element, bubbling +
   * composed. Deduped to once per attachment per final failure (not per retry).
   */
  'oxpulse-chat:attachment-error': CustomEvent<{ msgId: string; attachmentId: string; reason: 'hydrate_failed' }>;
  /**
   * Observability: fired when a row carrying an `unsealError` (chat-sdk's
   * classifyUnsealError reason 'replay' | 'auth' | 'unknown') is rendered —
   * a replay-attack signature and a benign timeout are otherwise
   * indistinguishable to the host. Dispatched from the host element, bubbling +
   * composed. Deduped to once per msgId per widget lifetime (not per re-render).
   * The replay reason is the one that matters most on an untrusted server.
   */
  'oxpulse-chat:decrypt-error': CustomEvent<{ roomId: string; msgId: string; seq: number; reason: 'replay' | 'auth' | 'unknown' }>;
  /**
   * Observability: fired when the Reconnector exhausts all retry attempts
   * (MAX_ATTEMPTS=10) — a permanently-dead room is otherwise invisible to host
   * monitoring (contrast oxpulse-chat:token-expired which fires on auth
   * expiry). Dispatched from the host element, bubbling + composed.
   */
  'oxpulse-chat:reconnect-exhausted': CustomEvent<{ roomId: string; attempts: number }>;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type WidgetErrorCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'JWT_MALFORMED'
  | 'JWT_EXPIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'NETWORK_ERROR'
  | 'WRITE_MINT_FAILED'
  | 'WRITE_SEND_FAILED'
  | 'WRITE_REACTION_FAILED'
  | 'UNKNOWN';

export class WidgetError extends Error {
  readonly code: WidgetErrorCode;
  /** Present on write-failure events (issue #78) — which op failed. */
  readonly op?: WriteFailureOp;
  /** Present on write-failure events (issue #78) — coarse failure reason. */
  readonly reason?: WriteFailureReason;

  constructor(
    code: WidgetErrorCode,
    message: string,
    writeFailure?: { op: WriteFailureOp; reason: WriteFailureReason },
  ) {
    super(message);
    this.name = 'WidgetError';
    this.code = code;
    this.op = writeFailure?.op;
    this.reason = writeFailure?.reason;
  }
}

// ── Write-failure telemetry (issue #78) ─────────────────────────────────────
//
// A write op (sendReaction/removeReaction/sendText) failing with 401 used to
// roll back silently (console.warn only) — the host never learned the JWT
// had expired. These types back the failure-counter hook (onWriteError /
// oxpulse-chat:write-error) so an integrator can count silent write
// failures by class instead of only seeing a vanished optimistic update.

/** Which write operation failed. */
export type WriteFailureOp = 'reaction_add' | 'reaction_remove' | 'send';

/** Coarse failure-reason bucket for write-failure telemetry. */
export type WriteFailureReason = 'auth_expired' | 'network' | 'other';

/** Detail payload for the write-failure counter hook (config.onWriteError). */
export interface WriteFailureDetail {
  op: WriteFailureOp;
  reason: WriteFailureReason;
}

export class OriginNotAllowedError extends WidgetError {
  constructor(origin: string, allowed: string[]) {
    super(
      'ORIGIN_NOT_ALLOWED',
      `Origin "${origin}" is not in the allowed list: [${allowed.join(', ')}]`,
    );
    this.name = 'OriginNotAllowedError';
  }
}

// ── postMessage protocol ──────────────────────────────────────────────────────

/**
 * Messages sent FROM the parent page INTO the iframe (parent → iframe).
 */
export type ParentMessage =
  | { type: 'init'; config: WidgetConfig }
  | { type: 'refresh-token'; jwt: string }
  | { type: 'set-theme'; theme: 'light' | 'dark' | 'auto' };

/**
 * Messages sent FROM the iframe OUT to the parent page (iframe → parent).
 */
export type IframeMessage =
  | { type: 'ready'; roomId: string }
  | { type: 'error'; code: WidgetErrorCode; message: string }
  | { type: 'token-expired'; roomId: string }
  | { type: 'resize'; height: number }
  | { type: 'user-action'; event: 'send' | 'reaction' | 'typing' };

// ── Origin check ──────────────────────────────────────────────────────────────

export interface OriginCheckResult {
  allowed: boolean;
  /** Populated when allowed=true. */
  matchedPattern?: string;
  /** Populated when allowed=false. */
  reason?: string;
}

// ── Mount options (programmatic API) ─────────────────────────────────────────

/** Options for the programmatic mount() API (superset of WidgetConfig). */
export interface MountOptions extends WidgetConfig {
  /** Shadow DOM mode. Default: 'open'. */
  shadowMode?: 'open' | 'closed';
}

/** W9: Marketplace product display metadata. Non-sensitive catalog info. */
export interface ProductMeta {
  title: string;
  /**
   * Host-pre-formatted display text (e.g. "1 200", "12.99"), NOT a raw
   * numeric amount. The widget renders it verbatim as `${price} ${currency}`
   * (message-list.ts) — no Intl.NumberFormat or locale-aware formatting is
   * applied. Callers own formatting (decimals, thousands separators, symbol
   * placement) before setting this field.
   */
  price: string;
  currency: string;
  imageUrl: string;
  productUrl: string;
}
