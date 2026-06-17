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
      onMutation?: (event: { msgId: string; op: string; deletedAt?: string; editedAt?: string; [k: string]: unknown }) => void;
      onReaction?: (event: { msgId: string; op: 'reaction_add' | 'reaction_remove'; reaction: string; userId: string; [k: string]: unknown }) => void;
    }): () => void;
    sendText(roomId: string, args: { senderUid: string; text: string; msgId?: string }): Promise<{ seq?: number; msgId: string }>;
    getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
    sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
    removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
  };
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
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type WidgetErrorCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'JWT_MALFORMED'
  | 'JWT_EXPIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class WidgetError extends Error {
  readonly code: WidgetErrorCode;

  constructor(code: WidgetErrorCode, message: string) {
    super(message);
    this.name = 'WidgetError';
    this.code = code;
  }
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
