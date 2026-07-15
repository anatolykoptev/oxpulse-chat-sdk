/**
 * @oxpulse/chat-widget — <oxpulse-chat> Custom Element.
 *
 * Skeleton: handles lifecycle + origin check + placeholder rendering.
 * Full UI (message list, composer, reactions) ships in W2.2.
 *
 * Voice/video interface reserved for v3.0: see WidgetConfig for attribute stub.
 */

import { checkOrigin, decodeJwtPayload } from './bootstrap.js';
import { sendRefreshTokenToIframe } from './postmessage.js';
import {
  WidgetError,
  OriginNotAllowedError,
  OBSERVED_ATTRIBUTES,
  type MountOptions,
  type WidgetConfig,
  type ProductMeta,
  type WidgetErrorCode,
  type WriteFailureOp,
  type WriteFailureReason,
} from './types.js';
import { THEME_CSS, applyTheme } from './ui/theme.js';
import { MessageList } from './ui/message-list.js';
import type { MessageListClient, MessageRow, MutationEvent as WidgetMutationEvent, ReactionEvent as WidgetReactionEvent } from './ui/message-list.js';
import { Composer, type SendTextArgs } from './ui/composer.js';
import { isAuthError, classifyWriteFailureReason } from './utils/auth.js';
import { Reconnector, type SubscribeFn } from './ui/reconnect.js';
import { SDKChatClient, mintAnonReadToken, AnonReadMintError, mintNamedWriteToken, NamedWriteMintError, fetchRoster } from '@oxpulse/chat-sdk';
import type { MutationEvent as SDKMutationEvent, ReactionEvent as SDKReactionEvent } from '@oxpulse/chat-sdk';
import { presignAttachment } from '@oxpulse/chat-sdk/attachments';
import { t, resolveLocale } from './utils/i18n.js';
import {
  encodeAttachmentEnvelope,
  decodeAttachmentEnvelope,
  attachmentUrl,
  type EnvelopeAttachment,
} from './utils/attachment-envelope.js';

const WIDGET_VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0-dev';
const ELEMENT_TAG = 'oxpulse-chat';
/** Default OxPulse API base URL when no `base-url` override is set. Single source for the postMessage target origin. */
const DEFAULT_BASE_URL = 'https://oxpulse.chat';

/**
 * Derive the self uid from the JWT `sub` claim (display-side only — the
 * server never trusts it; it drives self/other bubble alignment).
 *
 * Fail-soft by design: a malformed or expired token returns `undefined`
 * here rather than throwing — bootstrap's own `decodeJwtPayload` call is
 * where the real error surfaces to the embedder. Alignment sugar must
 * never take the widget down.
 */
export function selfUidFromJwt(jwt: string | null): string | undefined {
  if (!jwt) return undefined;
  try {
    const sub = decodeJwtPayload(jwt)['sub'];
    return typeof sub === 'string' && sub !== '' ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** Hex-encode a digest buffer (crypto.subtle.digest output) — used for the SHA-256 sent to presign. */
function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Read a Blob into an ArrayBuffer via FileReader — Blob.prototype.arrayBuffer()
 * is unimplemented in some embed/test environments (jsdom has no arrayBuffer/
 * text/stream on Blob, only slice); FileReader.readAsArrayBuffer is the
 * portable primitive, matching utils/attachments.ts's compress() which
 * already reads a Blob via FileReader (readAsDataURL) for the same reason.
 */
function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(result);
      else reject(new Error('FileReader: expected ArrayBuffer result'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * issue #67: read-side inverse of composerClient.sendFile's envelope encode.
 *
 * chat-sdk's MessageRow has no attachments field at all (verified: types.ts,
 * client.ts's rowToMessageRow) — a stored attachment blob is structurally
 * unlinked from any message on the wire. This widget links them itself: since
 * cryptoMode is always 'plaintext' here, row.plaintext is UTF-8 bytes fully
 * controlled by the widget. When those bytes decode as our attachment
 * envelope (attachment-envelope.ts), unwrap it into row.text (caption) +
 * row.attachments (AttachmentMeta[], url built from the already-documented
 * GET /api/sdk/attachments/{id} route). Any other plaintext — every
 * pre-existing plain-text message — fails the shape check and passes through
 * unchanged, so this never touches the ordinary text path.
 */
function decodeRowAttachments(row: MessageRow, baseUrl: string): MessageRow {
  if (!row.plaintext) return row;
  let text: string;
  try {
    text = new TextDecoder().decode(row.plaintext);
  } catch {
    return row;
  }
  const envelope = decodeAttachmentEnvelope(text);
  if (!envelope) return row;
  return {
    ...row,
    text: envelope.body,
    attachments: envelope.attachments.map((a) => ({
      id: a.id,
      url: attachmentUrl(baseUrl, a.id),
      mime: a.mime,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
    })),
  };
}

// ── OxpulseChatElement ────────────────────────────────────────────────────────

/**
 * <oxpulse-chat> Custom Element.
 *
 * HTML usage:
 *   <oxpulse-chat app-id="..." jwt="..." room-id="..."></oxpulse-chat>
 *
 * Attributes:
 *   app-id   — OxPulse app ID (required)
 *   jwt      — signed JWT (required)
 *   room-id  — room to open (required)
 *   mode     — 'inline' | 'iframe' (default: 'inline')
 *   theme    — 'light' | 'dark' | 'auto' (default: 'auto')
 *   lang     — BCP 47 locale override
 */
export class OxpulseChatElement extends HTMLElement {
  static readonly observedAttributes: readonly string[] = OBSERVED_ATTRIBUTES;

  /** Shadow root — always open for W2.1 skeleton. */
  #shadow: ShadowRoot | null = null;
  /** Whether connectedCallback has finished its init sequence. */
  #initialized = false;
  /** Abort controller for async bootstrap. */
  #abortController: AbortController | null = null;
  /** 1H: debounce flag — true when a queueMicrotask bootstrap is already scheduled. */
  #bootstrapScheduled = false;
  /** Config callbacks — stored from mount() programmatic API. */
  #config: WidgetConfig | null = null;
  /** Active MessageList instance (inline mode only). */
  #messageList: MessageList | null = null;
  /** Active Composer instance (inline mode only). */
  #composer: Composer | null = null;
  /** Theme <style> element injected into shadow root — retained to survive placeholder cleanup. */
  #styleEl: HTMLStyleElement | null = null;
  /** CB1: Reconnector instance — wired after mount, drives banner + retry loop. */
  #reconnector: Reconnector | null = null;
  /**
   * CB2: onError trigger from the real SDK client's subscribe() callback.
   * Exposed as triggerSubscribeError() for tests.
   * Set during bootstrap so tests can fire async subscribe errors without public API leak.
   */
  #subscribeOnError: ((err: unknown) => void) | null = null;
  /** Timer ID for anon-read token pre-expiry re-mint. */
  #anonRenewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live sandboxed iframe (iframe mode only) — target for in-place token refresh. */
  #iframe: HTMLIFrameElement | null = null;
  /** Guard: true while refreshToken() syncs the jwt attribute in place — suppresses the remount. */
  #suppressJwtReboot = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback(): void {
    if (this.#initialized) return; // guard against double-mount
    this.#initialized = true;
    this.#abortController = new AbortController();
    void this.#bootstrap(this.#abortController.signal);
  }

  disconnectedCallback(): void {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#initialized = false;
    this.#bootstrapScheduled = false;
    this.#reconnector?.destroy();
    this.#reconnector = null;
    this.#subscribeOnError = null;
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
    this.#styleEl = null;
    this.#iframe = null;
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    // Clear shadow DOM content (resource cleanup)
    if (this.#shadow) {
      while (this.#shadow.firstChild) {
        this.#shadow.removeChild(this.#shadow.firstChild);
      }
    }
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (!this.#initialized) return; // ignore pre-connect attribute changes
    if (old === value) return;

    // theme: apply live to host element (no re-bootstrap needed)
    if (name === 'theme') {
      applyTheme(this, value);
    }

    // Attribute changes that require re-init (JWT, room, app-id, self-uid, base-url, allow-anon-read, allow-write, write-mint-endpoint, reactions-enabled)
    if (name === 'jwt' || name === 'room-id' || name === 'app-id' || name === 'self-uid' || name === 'base-url' || name === 'allow-anon-read' || name === 'allow-write' || name === 'write-mint-endpoint' || name === 'reactions-enabled') {
      // In-place iframe refresh keeps the jwt attribute (remount source-of-truth) in
      // sync but must NOT remount — refreshToken() applied the token via postMessage.
      if (name === 'jwt' && this.#suppressJwtReboot) return;
      // 1H: debounce via queueMicrotask — N synchronous setAttribute calls collapse into 1 bootstrap.
      // Abort the current bootstrap immediately (prevents stale state mutation).
      this.#abortController?.abort();
      this.#abortController = new AbortController();
      this.#initialized = true;
      if (!this.#bootstrapScheduled) {
        this.#bootstrapScheduled = true;
        queueMicrotask(() => {
          this.#bootstrapScheduled = false;
          // Use the current abortController (may have been replaced by subsequent attr changes)
          if (this.#abortController) {
            void this.#bootstrap(this.#abortController.signal);
          }
        });
      }
    }
    // lang / mode: deferred to later slices
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * W2.2 slice 5: Returns the last seq value seen by the MessageList.
   * Used by tests and reconnect logic to pass lastSeq on reconnect.
   */
  getLastSeq(): number {
    return this.#messageList?.getLastSeq() ?? 0;
  }

  /**
   * W9: Attach a product card to the next outgoing composer message.
   * Call after the 'oxpulse-chat:ready' event when the composer is mounted.
   *
   * E2EE posture: `productMeta` (title/price/imageUrl/productUrl) travels
   * UNSEALED in the wire payload and is server-visible even in E2EE rooms —
   * by design, mirroring the sendProductCard contract to enable marketplace
   * search. Only `productRef` is opaque. Do not put sensitive data in
   * `productMeta`.
   */
  setProductCard(productRef: string, productMeta: ProductMeta): void {
    this.#composer?.setProductCard(productRef, productMeta);
  }

  /**
   * CB2: Test hook — trigger an error through the real SDK subscribe() onError path.
   * Routes through the real error-handling path (Reconnector) rather than bypassing it.
   * @internal — for testing only. Not exposed on the public type surface.
   */
  triggerSubscribeError(err: unknown): void {
    if (this.#subscribeOnError) {
      this.#subscribeOnError(err);
    }
  }

  /**
   * Provide a fresh JWT (called after 'oxpulse-chat:token-expired' event).
   *
   * In-place path (iframe mode): posts the fresh JWT to the LIVE iframe over an
   * origin-pinned postMessage — no remount, so the SSE stream, scroll position
   * and decrypt state survive. The iframe re-authenticates internally without a
   * document reload.
   *
   * Fallback (inline mode, the iframe is not present/ready, OR a remount is
   * already pending): re-bootstrap with the fresh token. A pending remount
   * (e.g. from a same-tick base-url/room change) would replace the current
   * iframe, so an in-place post to it targets the OLD origin and the browser
   * drops it (token lost) — instead we sync the attribute and let the pending
   * remount deliver the fresh token. Inline uses a `readonly`-JWT SDKChatClient
   * that can only be re-authed by reconstruction, so a re-bootstrap is required.
   */
  refreshToken(jwt: string): void {
    const iframe = this.#iframe;
    if (iframe?.contentWindow && !this.#bootstrapScheduled) {
      const config = this.#resolveConfig();
      if (config) {
        // Same concrete origin the init path posts to — never '*'.
        sendRefreshTokenToIframe(iframe, jwt, this.#resolveBaseUrl(config));
        // Keep the jwt attribute (the remount source-of-truth) in sync so a later
        // re-bootstrap uses the fresh token — WITHOUT triggering a remount here.
        this.#suppressJwtReboot = true;
        try {
          this.setAttribute('jwt', jwt);
        } finally {
          this.#suppressJwtReboot = false;
        }
        return;
      }
    }
    // Fallback: no live iframe → re-bootstrap (existing behaviour).
    if (this.getAttribute('jwt') !== jwt) {
      this.setAttribute('jwt', jwt);
      // attributeChangedCallback handles re-bootstrap
    } else {
      // Force re-bootstrap even on same value (token was refreshed externally)
      this.#abortController?.abort();
      this.#abortController = new AbortController();
      this.#initialized = true;
      void this.#bootstrap(this.#abortController.signal);
    }
  }

  /**
   * Tear down the widget, cancel in-flight async operations, clear shadow DOM.
   */
  destroy(): void {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#initialized = false;
    this.#bootstrapScheduled = false;
    this.#reconnector?.destroy();
    this.#reconnector = null;
    this.#subscribeOnError = null;
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
    this.#styleEl = null;
    this.#iframe = null;
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    if (this.#shadow) {
      while (this.#shadow.firstChild) {
        this.#shadow.removeChild(this.#shadow.firstChild);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Store config callbacks from programmatic mount().
   * Not exposed as attributes — only via the JS API.
   * @internal
   */
  _setCallbacks(config: Pick<WidgetConfig, 'onTokenExpired' | 'onError' | 'onWriteError' | 'allowLegacyToken' | '_createClient' | '_mintAnonReadToken' | '_mintNamedWriteToken'>): void {
    this.#config = {
      ...(this.#config ?? { appId: '', jwt: '', roomId: '' }),
      ...config,
    };
  }

  /**
   * Write-401 fix (issue #78): single choke-point for the token-expired
   * signal — dispatches the DOM event + calls the config callback. Reused
   * by the origin-check JWT_EXPIRED branch, the subscribe-error path
   * (handleSubscribeError), and the write-401 paths (composer send,
   * reaction add/remove/replace via MessageList's onAuthExpired) so every
   * route fires the SAME signal the host already listens for, instead of
   * re-implementing dispatch at each call site.
   */
  #notifyTokenExpired(roomId: string): void {
    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:token-expired', {
        bubbles: true,
        composed: true,
        detail: { roomId },
      }),
    );
    if (this.#config?.onTokenExpired) {
      void this.#config.onTokenExpired();
    }
  }

  /**
   * Write-401 fix (issue #78): failure-counter hook — dispatches
   * `oxpulse-chat:write-error` (extending the existing event/WidgetError
   * shape with op/reason fields, not inventing a new event) and calls
   * config.onWriteError, for EVERY write-op failure (not just auth) so an
   * integrator can count silent write failures.
   */
  #notifyWriteFailure(op: WriteFailureOp, reason: WriteFailureReason, message: string): void {
    const code: WidgetErrorCode = op === 'send' ? 'WRITE_SEND_FAILED' : 'WRITE_REACTION_FAILED';
    const err = new WidgetError(code, message, { op, reason });
    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:write-error', {
        bubbles: true,
        composed: true,
        detail: err,
      }),
    );
    if (this.#config?.onWriteError) {
      this.#config.onWriteError({ op, reason });
    }
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    // Ensure shadow root exists
    if (!this.#shadow) {
      this.#shadow = this.attachShadow({ mode: 'open' });
    }

    const config = this.#resolveConfig();
    if (!config) {
      // Required attributes not yet set — wait for attributeChangedCallback
      return;
    }
    // i18n: resolve once per bootstrap (lang option → navigator.language prefix
    // → 'en') and reuse for every string this bootstrap renders/constructs.
    const lang = resolveLocale(config.lang);

    // Clear previous content
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
    // Drop the stale iframe ref; #mountIframe re-sets it in iframe mode, inline leaves it null.
    this.#iframe = null;
    while (this.#shadow.firstChild) {
      this.#shadow.removeChild(this.#shadow.firstChild);
    }

    // Inject theme CSS into shadow root — store ref so placeholder cleanup can preserve it.
    const styleEl = document.createElement('style');
    styleEl.textContent = THEME_CSS;
    this.#styleEl = styleEl;
    this.#shadow.appendChild(styleEl);

    // Apply theme attribute to host element
    applyTheme(this, config.theme ?? null);

    // Render loading placeholder
    this.#renderPlaceholder(t('chatLoading', lang));

    // In anon-read mode the mint endpoint is the authorization gate; skip the
    // JWT-based origin check (config.jwt is empty before minting).
    try {
      if (!config.allowAnonRead) {
        await checkOrigin(config);
      }
    } catch (err) {
      if (signal.aborted) return;
      const widgetErr =
        err instanceof WidgetError
          ? err
          : new WidgetError('UNKNOWN', String(err));

      this.#renderError(widgetErr.message);

      // M3: dispatch appropriate event and call config callback
      if (widgetErr.code === 'JWT_EXPIRED') {
        this.#notifyTokenExpired(config.roomId);
      } else {
        // All other errors → fire error event
        this.dispatchEvent(
          new CustomEvent('oxpulse-chat:error', {
            bubbles: true,
            composed: true,
            detail: widgetErr,
          }),
        );
        // Call onError callback if provided
        if (this.#config?.onError) {
          this.#config.onError(widgetErr);
        }
      }
      return;
    }

    if (signal.aborted) return;

    // Origin check passed — dispatch ready event
    if (config.mode === 'iframe') {
      // M6: iframe mode — create sandboxed iframe inside shadow root
      if (config.allowWrite) {
        // Named-write in iframe mode is not yet implemented (W5).
        // Warn loudly rather than silently doing nothing.
        // eslint-disable-next-line no-console
        console.warn('[oxpulse-chat-widget] allowWrite=true is not supported in mode:"iframe" yet (W5). The compose UI will not be shown. Use mode:"inline" for named-write.');
      }
      this.#mountIframe(config);
    } else {
      // Inline mode: W2.2 — mount real message list UI
      if (typeof window !== 'undefined' && (window as unknown as { __oxpDebug?: boolean }).__oxpDebug) {
        // eslint-disable-next-line no-console
        console.log(`OxpulseChatWidget ${WIDGET_VERSION} initialized`);
      }

      // Instantiate the chat client.
      // In tests, config._createClient overrides construction with a mock.
      // In production: real SDKChatClient with plaintext mode (no E2EE in the widget).
      // baseUrl: use config.baseUrl (default 'https://oxpulse.chat').
      // compression: 'none' — widget does not bundle zstd dicts.
      // cryptoMode: 'plaintext' — widget operates without E2EE; the server must be
      //   configured for plaintext mode on the target room.
      // RawClient: structural interface covering every sdkClient call-site in this function.
      // Defines the minimal contract shared by SDKChatClient and the test mock factory.
      // Kept local to this function — not exported.
      interface RawClient {
        list(roomId: string, args: { limit: number }): Promise<{ items: MessageRow[]; hasNext: boolean }>;
        subscribe(roomId: string, args: {
          onMessage: (row: MessageRow) => void;
          onError?: (err: unknown) => void;
          onRosterSignal?: () => void;
          onMutation?: (event: SDKMutationEvent) => void;
          onReaction?: (event: SDKReactionEvent) => void;
        }): () => void;
        sendText(roomId: string, args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: import('./types.js').ProductMeta }): Promise<{ seq?: number; msgId: string }>;
        getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
        sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        /**
         * issue #67: optional — enables attachment upload. composerClient.sendFile
         * (below) drives presignAttachment() + PUT + send() directly rather than
         * chat-sdk's sendFile() convenience wrapper, because that wrapper discards
         * the presigned attachmentId when it calls send() (attachments.ts:163-167) —
         * see the "attachments (issue #67)" comment block near composerClient below.
         * Feature-detected like sendReaction?/getReactions? above; a real
         * SDKChatClient always has all three together.
         */
        send?(roomId: string, args: { senderUid: string; sealed: ArrayBuffer }): Promise<{ seq: number; msgId: string }>;
        readonly baseUrl?: string;
        readonly jwt?: string;
      }

      // ── Anon-read mode: mint token when allow-anon-read is set and no jwt provided ──
      const resolvedBaseUrl = this.#resolveBaseUrl(config);
      let resolvedJwt = config.jwt;
      let isAnonMode = false;
      // Bug fix (independent audit, sibling gap to #39): captures the anon mint's
      // own identity so it can backfill selfUid below when no jwt sub is available.
      let anonUserId: string | undefined;

      if (config.allowAnonRead && !config.jwt) {
        isAnonMode = true;
        const mintFn = config._mintAnonReadToken ?? mintAnonReadToken;
        let mintResult: { token: string; userId: string; expiresAt: number };
        try {
          mintResult = await mintFn({
            baseUrl: resolvedBaseUrl,
            appId: config.appId,
            roomId: config.roomId,
          });
        } catch (err) {
          if (signal.aborted) return;
          const mintErrMsg = err instanceof AnonReadMintError
            ? `Anon read token mint failed (${err.code}): ${err.message}`
            : `Anon read token mint failed: ${err instanceof Error ? err.message : String(err)}`;
          const widgetErr = new WidgetError('UNKNOWN', mintErrMsg);
          this.#renderError(widgetErr.message);
          if (this.#config?.onError) {
            this.#config.onError(widgetErr);
          }
          this.dispatchEvent(new CustomEvent('oxpulse-chat:error', {
            bubbles: true, composed: true, detail: widgetErr,
          }));
          return;
        }
        if (signal.aborted) return;

        resolvedJwt = mintResult.token;
        anonUserId = mintResult.userId;

        // Schedule re-mint 30 s before expiry. expiresAt is a Unix timestamp in seconds.
        // Floor at 5 s so a near-expired / clock-skewed token cannot spin a tight re-mint
        // loop (each renew is a network call); the 300 s server TTL makes this rare anyway.
        const nowSecs = Math.floor(Date.now() / 1000);
        const ANON_MIN_RENEW_MS = 5000;
        const renewAfterMs = Math.max((mintResult.expiresAt - nowSecs - 30) * 1000, ANON_MIN_RENEW_MS);
        if (this.#anonRenewTimer !== null) {
          clearTimeout(this.#anonRenewTimer);
        }
        this.#anonRenewTimer = setTimeout(() => {
          this.#anonRenewTimer = null;
          if (!this.#initialized) return;
          // Re-bootstrap to mint a fresh token. Uses current abortController.
          this.#abortController?.abort();
          this.#abortController = new AbortController();
          this.#initialized = true;
          void this.#bootstrap(this.#abortController.signal);
        }, renewAfterMs);
      }

      // ── Named-write mode: mint write token when allow-write + writeMintEndpoint set ──
      // The write JWT is kept separate from the read JWT (different capability level).
      // Even in anon-read mode, allowWrite can be enabled to let a named user write
      // while reading via the anon token (two separate clients).
      let resolvedWriteJwt: string | null = null;
      if (config.allowWrite && config.writeMintEndpoint) {
        const mintWriteFn = config._mintNamedWriteToken ?? mintNamedWriteToken;
        try {
          resolvedWriteJwt = await mintWriteFn({
            mintEndpoint: config.writeMintEndpoint,
            roomId: config.roomId,
          });
        } catch (err) {
          if (signal.aborted) return;
          const mintErrMsg = err instanceof NamedWriteMintError
            ? `Named-write token mint failed (${err.code}): ${err.message}`
            : `Named-write token mint failed: ${err instanceof Error ? err.message : String(err)}`;
          const widgetErr = new WidgetError('WRITE_MINT_FAILED', mintErrMsg);
          this.#renderError(widgetErr.message);
          if (this.#config?.onError) {
            this.#config.onError(widgetErr);
          }
          this.dispatchEvent(new CustomEvent('oxpulse-chat:error', {
            bubbles: true, composed: true, detail: widgetErr,
          }));
          return;
        }
        if (signal.aborted) return;
      }

      // Bug fix (independent audit, sibling gap to #39): config.selfUid is resolved
      // in #resolveConfig() BEFORE the anon-read / named-write mints above run, so it
      // can never see a mint result. Anon-read (no jwt attribute) combined with
      // named-write is an explicitly supported combo (see the decision matrix below)
      // where the ONLY real identity comes from a mint, not the jwt attribute —
      // backfill here now that both mints (if any) have settled.
      // Precedence: an explicit self-uid attribute already won inside config.selfUid
      // (#resolveConfig, unchanged since #39). Otherwise, the write JWT's sub wins
      // over the anon mint's userId: when a write token exists it becomes
      // effectiveSendClient below, and the server stamps the ECHOED sender identity
      // from THAT JWT's sub (see the senderUid comment on the composerClient below) —
      // so it is the identity that will actually come back on the visitor's own
      // messages. The anon mint's userId is the best fallback when there is no
      // write token at all.
      let resolvedSelfUid = config.selfUid;
      if (!resolvedSelfUid) {
        resolvedSelfUid = selfUidFromJwt(resolvedWriteJwt) ?? anonUserId;
      }

      const clientOpts = {
        baseUrl: resolvedBaseUrl,
        jwt: resolvedJwt,
        appId: config.appId,
      };
      const sdkClient: RawClient = config._createClient
        ? (config._createClient(clientOpts) as unknown as RawClient)
        : new SDKChatClient({ ...clientOpts, compression: 'none', cryptoMode: 'plaintext' }) as unknown as RawClient;

      // When allowWrite is true with a write token, build a separate write client
      // using the named-write JWT. In non-anon authed mode (jwt present, no allowWrite)
      // the existing sdkClient handles sends directly.
      let writeClient: RawClient | null = null;
      if (resolvedWriteJwt !== null) {
        const writeClientOpts = {
          baseUrl: resolvedBaseUrl,
          jwt: resolvedWriteJwt,
          appId: config.appId,
        };
        writeClient = config._createClient
          ? (config._createClient(writeClientOpts) as unknown as RawClient)
          : new SDKChatClient({ ...writeClientOpts, compression: 'none', cryptoMode: 'plaintext' }) as unknown as RawClient;
      }

      // Decision matrix:
      //   isAnonMode && !writeClient → read-only (composer hidden, capability-based block)
      //   isAnonMode && writeClient  → named-write JWT available; wire composer to writeClient
      //   !isAnonMode               → authed path; standard JWT handles sends via sdkClient
      //                               UNLESS allowWrite + writeClient: use write client instead
      // In all cases: writeClient (if present) takes precedence for sends (named-write capability).
      const effectiveSendClient: RawClient | null = writeClient ?? (!isAnonMode ? sdkClient : null);

      // Adapt the real SDK client to the widget's duck-typed MessageListClient interface.
      // The widget components use stable narrow interfaces defined in their own files;
      // we bridge here rather than changing those interfaces.
      //
      // Key differences bridged:
      //   1. SDK subscribe() takes { onMessage, onError?, onMutation?, onReaction? } —
      //      MessageListClient.subscribe() passes { onMessage, onMutation?, onReaction? }
      //      plus a separate onError routed through the Reconnector.
      //   2. SDK ReactionEvent has { reaction, userId, op: 'reaction_add'|'reaction_remove' } —
      //      widget ReactionEvent has { emoji, userUid, op: 'add'|'remove', totalCount }.
      //   3. SDK sendText() requires { senderUid, text } — ComposerClient.sendText() passes
      //      (roomId, text, args?) with senderUid derived from resolvedSelfUid (self-uid
      //      attribute > write JWT sub > anon mint userId — see the backfill below).
      //   4. SDK sendText() returns { seq, msgId } — ComposerClient expects { msgId }.

      // onError handler shared between the real subscribe() callback and #subscribeOnError
      // (so tests can fire it via triggerSubscribeError() without going through real SSE).
      let reconnectorRef: Reconnector | null = null;
      let subscribeFnRef: SubscribeFn | null = null;

      const handleSubscribeError = (err: unknown): void => {
        // isAuthError() understands both the widget-bridged {status, kind}
        // shape and the raw SDKChatError {statusCode, code} shape directly —
        // no hand-built bridge object needed here (write-401 fix, issue #78:
        // extracted into utils/auth.ts so this normalisation isn't copied a
        // 2nd/3rd time into the write-401 paths below).
        if (isAuthError(err)) {
          reconnectorRef?.notifyAuthExpired();
          this.#notifyTokenExpired(config.roomId);
        } else if (reconnectorRef !== null && subscribeFnRef !== null) {
          reconnectorRef.startReconnectLoop(subscribeFnRef, config.roomId);
        }
      };

      // CB2: Expose the onError trigger for tests via triggerSubscribeError().
      this.#subscribeOnError = handleSubscribeError;

      // widgetClient conforms to MessageListClient.
      // subscribe() bridges onError into the reconnect flow and maps event shapes.
      const widgetClient: MessageListClient = {
        list: (roomId: string, args: { limit: number }) =>
          sdkClient.list(roomId, { limit: args.limit }).then((result) => ({
            ...result,
            items: result.items.map((row) => decodeRowAttachments(row, resolvedBaseUrl)),
          })),

        subscribe: (roomId: string, args: {
          onMessage: (row: MessageRow) => void;
          onMutation?: (event: WidgetMutationEvent) => void;
          onReaction?: (event: WidgetReactionEvent) => void;
          onRosterSignal?: () => void;
        }) => {
          return sdkClient.subscribe(roomId, {
            onMessage: (row) => args.onMessage(decodeRowAttachments(row, resolvedBaseUrl)),
            onError: handleSubscribeError,
            onRosterSignal: args.onRosterSignal,
            onMutation: args.onMutation
              ? (sdkEv: SDKMutationEvent): void => {
                  // Widget MutationEvent shape is compatible with SDK's (same fields used).
                  args.onMutation!({
                    msgId: sdkEv.msgId,
                    op: sdkEv.op,
                    deletedAt: sdkEv.deletedAt,
                    editedAt: sdkEv.editedAt,
                  });
                }
              : undefined,
            onReaction: args.onReaction
              ? (sdkEv: SDKReactionEvent): void => {
                  // Bridge SDK ReactionEvent → widget ReactionEvent.
                  // SDK: { reaction, userId, op: 'reaction_add'|'reaction_remove' }
                  // Widget: { emoji, userUid, op: 'add'|'remove', totalCount? }.
                  // totalCount is not available from the live SSE event; MessageList
                  // re-fetches getReactions when totalCount is omitted/0 for the
                  // authoritative aggregate.
                  args.onReaction!({
                    msgId: sdkEv.msgId,
                    emoji: sdkEv.reaction,
                    op: sdkEv.op === 'reaction_add' ? 'add' : 'remove',
                    userUid: sdkEv.userId,
                  });
                }
              : undefined,
          });
        },

        getReactions: (roomId: string, msgId: string) =>
          sdkClient.getReactions?.(roomId, msgId) ??
          Promise.resolve({ counts: {}, users: {}, truncated: false }),

        sendReaction: effectiveSendClient?.sendReaction
          ? (roomId: string, msgId: string, emoji: string) => effectiveSendClient!.sendReaction!(roomId, msgId, emoji)
          : undefined,

        removeReaction: effectiveSendClient?.removeReaction
          ? (roomId: string, msgId: string, emoji: string) => effectiveSendClient!.removeReaction!(roomId, msgId, emoji)
          : undefined,

        // issue #67: GET /api/sdk/attachments/{id} is JWT-authenticated (Authorization:
        // Bearer only — no signed query-token fallback like the PUT upload URL has), so a
        // bare `<img src>` 401s for every viewer. resolvedJwt is this widget's own read
        // token (named or anon-minted) — the same credential list()/subscribe() already
        // use — so any viewer who can read the room can read its attachments too.
        fetchAttachmentBlob: async (url: string, signal?: AbortSignal): Promise<Blob> => {
          const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${resolvedJwt ?? ''}` },
            signal,
          });
          if (!resp.ok) {
            throw new Error(`attachment fetch failed: HTTP ${resp.status}`);
          }
          return resp.blob();
        },

        // T18: roster — fetch names for OTHER writers via the same JWT.
        getRoster: (roomId: string) => fetchRoster({
          baseUrl: resolvedBaseUrl,
          appId: config.appId,
          roomId,
          jwt: resolvedJwt,
        }),
      };

      // F3: Remove placeholder in a single explicit pass — keeps #styleEl, removes all else.
      // Prior while-loop + querySelector was brittle (two passes, order-dependent).
      const styleEl = this.#styleEl;
      Array.from(this.#shadow.children).forEach((c) => {
        if (c !== styleEl) this.#shadow!.removeChild(c);
      });

      // .oxp-widget-root — vertical flex wrapper (theme.ts defines layout)
      const widgetRoot = document.createElement('div');
      widgetRoot.className = 'oxp-widget-root';
      this.#shadow.appendChild(widgetRoot);

      // MessageList occupies flex-1 (grows to fill space)
      const listContainer = document.createElement('div');
      listContainer.className = 'oxp-message-list-wrapper';
      widgetRoot.appendChild(listContainer);

      // Mount the Composer BEFORE MessageList so the message-list scroll container
      // has its final height when MessageList scrolls to the bottom after render.
      // Without this, MessageList scrolls against the composer-less flex height,
      // leaving the list stuck partway up once the composer shrinks the available space.
      if (effectiveSendClient !== null) {
        // ComposerClient adapter — bridges (roomId, text) → SDK { senderUid, text }.
        // Write path only wired when there is a capable JWT (named-write or standard authed).
        // senderUid: resolvedSelfUid if present; the server authorizes by the JWT sub, not
        // sender_uid — this field is best-effort/informational, but MUST stay in sync with
        // the same resolvedSelfUid the MessageList renders against (see the backfill comment
        // above), not the pre-mint config.selfUid, or the two would drift on the very same
        // anon-read + named-write combo this fix targets.
        const capturedSendClient = effectiveSendClient;
        const self = this;
        // issue #67: narrow ONCE to a client that can drive the presign/PUT/send
        // attachment flow (send/baseUrl/jwt all present — a real SDKChatClient
        // always has all three together; test mocks opt in explicitly). Typed
        // here so composerClient.sendFile below needs no per-call-site casts.
        const attachmentClient: (RawClient & { send: NonNullable<RawClient['send']>; baseUrl: string; jwt: string }) | null =
          capturedSendClient.send && capturedSendClient.baseUrl !== undefined && capturedSendClient.jwt !== undefined
            ? (capturedSendClient as RawClient & { send: NonNullable<RawClient['send']>; baseUrl: string; jwt: string })
            : null;

        // issue #67: split presign/PUT from send so the attachmentId is available
        // before the message is sent (stage-then-send).
        async function uploadAttachment(
          roomId: string,
          blob: Blob,
          args: { mimeType?: string; filename?: string; width?: number; height?: number; signal?: AbortSignal },
        ): Promise<{ attachmentId: string; attachment: EnvelopeAttachment }> {
          try {
            const mimeType = args.mimeType ?? blob.type;
            const digest = await crypto.subtle.digest('SHA-256', await readBlobAsArrayBuffer(blob));
            const sha256 = bytesToHex(digest);
            const { attachmentId, uploadUrl } = await presignAttachment(attachmentClient!, {
              mimeType,
              byteSize: blob.size,
              sha256,
            });
            const putUrl = uploadUrl.startsWith('/') ? `${attachmentClient!.baseUrl}${uploadUrl}` : uploadUrl;
            const putResp = await fetch(putUrl, {
              method: 'PUT',
              body: blob,
              headers: { 'Content-Type': mimeType },
              signal: args.signal,
            });
            if (!putResp.ok) {
              throw new Error(`attachment upload failed: HTTP ${putResp.status}`);
            }
            const attachment: EnvelopeAttachment = {
              id: attachmentId,
              mime: mimeType,
              filename: args.filename ?? 'file',
              sizeBytes: blob.size,
              width: args.width,
              height: args.height,
            };
            return { attachmentId, attachment };
          } catch (err) {
            const reason = classifyWriteFailureReason(err);
            const errMsg = err instanceof Error ? err.message : String(err);
            self.#notifyWriteFailure('send', reason, errMsg);
            if (reason === 'auth_expired') {
              self.#notifyTokenExpired(config!.roomId);
            }
            throw err;
          }
        }

        async function sendAttachmentMessage(
          roomId: string,
          body: string,
          attachments: readonly EnvelopeAttachment[],
          args?: SendTextArgs,
        ): Promise<{ msgId: string }> {
          try {
            const sealed = encodeAttachmentEnvelope(body, attachments);
            let result: { seq: number; msgId: string };
            try {
              result = await attachmentClient!.send(roomId, {
                senderUid: resolvedSelfUid ?? '',
                sealed,
                ...args,
              });
            } catch (sendErr) {
              const ids = attachments.map((a) => a.id).join(', ');
              console.warn(
                `[oxpulse/chat-widget] composerClient.sendAttachmentMessage: attachment(s) ${ids} ` +
                  'uploaded but client.send failed (orphaned attachment(s) may exist).',
                sendErr,
              );
              throw sendErr;
            }
            self.dispatchEvent(new CustomEvent('oxpulse-chat:message-sent', {
              bubbles: true,
              composed: true,
              detail: { roomId, msgId: result.msgId },
            }));
            return { msgId: result.msgId };
          } catch (err) {
            const reason = classifyWriteFailureReason(err);
            const errMsg = err instanceof Error ? err.message : String(err);
            self.#notifyWriteFailure('send', reason, errMsg);
            if (reason === 'auth_expired') {
              self.#notifyTokenExpired(config!.roomId);
            }
            throw err;
          }
        }

        const composerClient = {
          sendText: (roomId: string, text: string, args?: SendTextArgs): Promise<{ msgId: string }> =>
            capturedSendClient.sendText(roomId, { senderUid: resolvedSelfUid ?? '', text, ...args }).then((res) => {
              // Dispatch message-sent event on success
              self.dispatchEvent(new CustomEvent('oxpulse-chat:message-sent', {
                bubbles: true,
                composed: true,
                detail: { roomId, msgId: res.msgId },
              }));
              return res;
            }).catch((err: unknown) => {
              // Write-401 fix (issue #78): every composer send failure — named-write
              // or the plain authed path alike — fires the write-error telemetry
              // event (dispatch generalised beyond the old isNamedWritePath gate, so
              // an integrator can count silent write failures regardless of mode).
              // An auth failure additionally fires the SAME token-expired signal the
              // subscribe path uses. The Composer's own catch still fires
              // oxpulse-chat:error and renders the inline error chip — we do not swallow.
              const reason = classifyWriteFailureReason(err);
              const errMsg = err instanceof Error ? err.message : String(err);
              self.#notifyWriteFailure('send', reason, errMsg);
              if (reason === 'auth_expired') {
                self.#notifyTokenExpired(config!.roomId);
              }
              // Re-throw so the Composer's catch path fires (renders error chip + generic error event).
              throw err;
            }),
          // issue #67: attachments wired end-to-end. Split into uploadAttachment
          // (presign+PUT only) and sendAttachmentMessage (encode+send) so the
          // attachmentId(s) can be staged before the composer sends the message.
          // Only exposed when the underlying client is upload-capable (send/baseUrl/jwt
          // present); paperclip/paste/drag-drop in composer.ts feature-detect this.
          uploadAttachment: attachmentClient ? uploadAttachment : undefined,
          sendAttachmentMessage: attachmentClient ? sendAttachmentMessage : undefined,
        };
        this.#composer = new Composer({
          client: composerClient,
          roomId: config.roomId,
          container: widgetRoot,
          signal: signal,
          lang,
        });
        this.#composer.mount();
      }

      this.#messageList = new MessageList({
        client: widgetClient,
        roomId: config.roomId,
        container: listContainer,
        lang,
        // resolvedSelfUid: self-uid attribute > write JWT sub > anon mint userId
        // (see the backfill comment above where it is computed).
        selfUid: resolvedSelfUid ?? '',
        signal: signal,
        // MAJOR-5: pass shadow root so ReactionPicker mounts outside overflow:hidden widgetRoot.
        shadowHost: this.#shadow ?? undefined,
        // P5: role-badge label overrides, presentation only.
        roleLabels: config.roleLabels,
        // Reactions toggle. Default true when omitted.
        reactionsEnabled: config.reactionsEnabled,
        // W7: only show reply buttons when there is a composer wired to receive them.
        onSetReply: effectiveSendClient
          ? (snapshot) => { this.#composer?.setReplyTarget(snapshot); }
          : undefined,
        // Write-401 fix (issue #78): reaction write failures route through
        // the SAME token-expired signal + write-error telemetry the
        // subscribe path and composer send path use — wired here rather
        // than re-implemented inside MessageList.
        onAuthExpired: () => this.#notifyTokenExpired(config.roomId),
        onWriteFailure: (op, reason, message) => this.#notifyWriteFailure(op, reason, message),
      });

      await this.#messageList.mount();

      if (signal.aborted) return;

      // CB1: Wire Reconnector — drives banner + retry loop for subscribe errors.
      // Mounted into widgetRoot so banner sits above message list (z-index 5 per theme.ts).
      // AbortSignal from bootstrap wires cleanup (CM2).
      this.#reconnector?.destroy();
      this.#reconnector = new Reconnector({
        container: widgetRoot,
        host: this,
        signal: signal,
        lang,
      });
      reconnectorRef = this.#reconnector;

      // CB1/CM1: SubscribeFn for the Reconnector's retry loop.
      // When the SDK's internal reconnect exhausts and fires onError, the Reconnector
      // calls this fn to re-establish the stream. We route new messages and reactions
      // to the existing MessageList via its public handleMessage()/handleReaction() methods.
      const subscribeFn: SubscribeFn = (roomId, onError) => {
        return sdkClient.subscribe(roomId, {
          onMessage: (row) => { this.#messageList?.handleMessage(decodeRowAttachments(row, resolvedBaseUrl)); },
          onError,
          onMutation: undefined,
          onReaction: (sdkEv) => {
            this.#messageList?.handleReaction({
              msgId: sdkEv.msgId,
              emoji: sdkEv.reaction,
              op: sdkEv.op === 'reaction_add' ? 'add' : 'remove',
              userUid: sdkEv.userId,
            });
          },
        });
      };
      subscribeFnRef = subscribeFn;
    }

    if (signal.aborted) return;

    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:ready', {
        bubbles: true,
        composed: true,
        detail: { roomId: config.roomId },
      }),
    );

    // W2.2: real UI mounts here. Skeleton keeps the placeholder.
  }

  /**
   * M6: Mount sandboxed iframe inside the shadow root.
   * Per threat model: sandbox="allow-scripts allow-same-origin" is MANDATORY.
   */
  #mountIframe(config: WidgetConfig): void {
    if (!this.#shadow) return;

    const baseUrl = this.#resolveBaseUrl(config);
    const parentOrigin = encodeURIComponent(
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
    );

    const iframe = document.createElement('iframe');
    iframe.src = `${baseUrl}/widget/embed.html?app=${encodeURIComponent(config.appId)}&room=${encodeURIComponent(config.roomId)}&origin=${parentOrigin}`;

    // MANDATORY per threat model (CHANGELOG.md)
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';

    // Relay init config once iframe loads
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage(
        { ns: 'oxpulse-chat', type: 'init', config },
        baseUrl,
      );
    });

    this.#shadow.appendChild(iframe);
    // Retain the live iframe so refreshToken() can post an in-place token
    // refresh to it instead of remounting.
    this.#iframe = iframe;
  }

  /**
   * Resolve the widget's API base URL — the single authority for both the iframe
   * src origin and the postMessage target origin (never '*').
   *
   * Validates `base-url` as an absolute http(s) URL: a missing, malformed, or
   * non-http(s) value (e.g. `'*'`, `'javascript:…'`, garbage) falls back to the
   * default rather than flowing a magic/injected value into `iframe.src` or a
   * postMessage targetOrigin.
   */
  #resolveBaseUrl(config: WidgetConfig): string {
    const raw = config.baseUrl;
    if (!raw) return DEFAULT_BASE_URL;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw;
    } catch {
      // Not an absolute URL — fall through to the safe default.
    }
    // eslint-disable-next-line no-console
    console.warn(`[oxpulse-chat-widget] ignoring invalid base-url "${raw}" (must be an absolute http(s) URL) — using ${DEFAULT_BASE_URL}`);
    return DEFAULT_BASE_URL;
  }

  /** Resolve WidgetConfig from element attributes + stored callbacks. Returns null if required attrs missing. */
  #resolveConfig(): WidgetConfig | null {
    const appId = this.getAttribute('app-id');
    const jwt = this.getAttribute('jwt');
    const roomId = this.getAttribute('room-id');
    const allowAnonRead = this.hasAttribute('allow-anon-read');
    const allowWrite = this.hasAttribute('allow-write');
    const writeMintEndpoint = this.getAttribute('write-mint-endpoint') ?? undefined;

    // jwt is required unless allow-anon-read is set (anon mode mints its own token)
    if (!appId || !roomId) return null;
    if (!jwt && !allowAnonRead) return null;

    const mode = this.getAttribute('mode');
    const theme = this.getAttribute('theme');
    const lang = this.getAttribute('lang');
    // self/other bubble alignment: an explicit self-uid attribute wins;
    // without it, fall back to the JWT `sub` claim so the visitor's own
    // messages align right out of the box (previously the fallback was ''
    // → every message, own included, rendered as "other" / left-aligned).
    const selfUid = this.getAttribute('self-uid') ?? selfUidFromJwt(jwt);
    const baseUrl = this.getAttribute('base-url') ?? undefined;
    const reactionsEnabled = this.getAttribute('reactions-enabled') !== 'false';

    return {
      appId,
      jwt: jwt ?? '',
      roomId,
      mode: (mode === 'inline' || mode === 'iframe') ? mode : 'inline',
      theme: (theme === 'light' || theme === 'dark' || theme === 'auto') ? theme : 'auto',
      lang: lang ?? undefined,
      selfUid: selfUid ?? undefined,
      baseUrl,
      allowAnonRead,
      allowWrite,
      writeMintEndpoint,
      reactionsEnabled,
      // Merge stored callbacks + test factory overrides
      onTokenExpired: this.#config?.onTokenExpired,
      onError: this.#config?.onError,
      onWriteError: this.#config?.onWriteError,
      allowLegacyToken: this.#config?.allowLegacyToken,
      _createClient: this.#config?._createClient,
      _mintAnonReadToken: this.#config?._mintAnonReadToken,
      _mintNamedWriteToken: this.#config?._mintNamedWriteToken,
    };
  }

  /** Render a text placeholder inside the shadow root. */
  #renderPlaceholder(text: string): void {
    if (!this.#shadow) return;
    const el = document.createElement('div');
    // B3: use class referencing --oxp-muted token, not hardcoded color
    el.className = 'oxp-placeholder';
    // 1C: announce loading state to screen readers
    el.setAttribute('role', 'status');
    el.setAttribute('aria-busy', 'true');
    el.textContent = text;
    this.#shadow.appendChild(el);
  }

  /** Render an error message inside the shadow root. */
  #renderError(message: string): void {
    if (!this.#shadow) return;
    while (this.#shadow.firstChild) {
      this.#shadow.removeChild(this.#shadow.firstChild);
    }
    // Re-inject theme CSS so error state tokens are available
    const styleEl = document.createElement('style');
    styleEl.textContent = THEME_CSS;
    this.#shadow.appendChild(styleEl);
    const el = document.createElement('div');
    // B3: use class referencing --oxp-danger token, not hardcoded color
    el.className = 'oxp-error';
    el.textContent = `OxPulse Chat: ${message}`;
    this.#shadow.appendChild(el);
  }
}

// ── defineElement ─────────────────────────────────────────────────────────────

/**
 * Register <oxpulse-chat> as a Custom Element.
 * Safe to call multiple times — no-ops if already registered.
 */
export function defineElement(): void {
  if (typeof customElements === 'undefined') return; // SSR guard
  if (customElements.get(ELEMENT_TAG)) return; // already registered
  customElements.define(ELEMENT_TAG, OxpulseChatElement);
}

// ── mount (programmatic API) ──────────────────────────────────────────────────

/**
 * Programmatically mount an OxPulse Chat widget on a target element.
 *
 * This is an alternative to dropping <oxpulse-chat> in the HTML.
 * The element is created, configured, and appended to `target`.
 *
 * @returns An object with a `destroy()` method to remove the widget.
 */
export function mount(target: HTMLElement, config: MountOptions): { destroy: () => void } {
  defineElement();
  const el = document.createElement(ELEMENT_TAG) as OxpulseChatElement;

  el.setAttribute('app-id', config.appId);
  if (config.jwt) el.setAttribute('jwt', config.jwt);
  el.setAttribute('room-id', config.roomId);
  if (config.mode) el.setAttribute('mode', config.mode);
  if (config.theme) el.setAttribute('theme', config.theme);
  if (config.lang) el.setAttribute('lang', config.lang);
  if (config.selfUid) el.setAttribute('self-uid', config.selfUid);
  if (config.baseUrl) el.setAttribute('base-url', config.baseUrl);
  if (config.allowAnonRead) el.setAttribute('allow-anon-read', '');
  if (config.allowWrite) el.setAttribute('allow-write', '');
  if (config.writeMintEndpoint) el.setAttribute('write-mint-endpoint', config.writeMintEndpoint);
  // reactions-enabled defaults to true; only set the attribute explicitly to keep
  // the HTML truthful and to trigger re-init on future attribute changes.
  el.setAttribute('reactions-enabled', config.reactionsEnabled === false ? 'false' : 'true');

  // Store callbacks + test factory overrides (not representable as attributes)
  el._setCallbacks({
    onTokenExpired: config.onTokenExpired,
    onError: config.onError,
    onWriteError: config.onWriteError,
    allowLegacyToken: config.allowLegacyToken,
    _createClient: config._createClient,
    _mintAnonReadToken: config._mintAnonReadToken,
    _mintNamedWriteToken: config._mintNamedWriteToken,
  });

  target.appendChild(el);

  return {
    destroy(): void {
      el.destroy();
      target.removeChild(el);
    },
  };
}
