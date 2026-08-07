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
import { MessageList, AttachmentFetchError } from './ui/message-list.js';
import type { MessageListClient, MessageRow, MutationEvent as WidgetMutationEvent, ReactionEvent as WidgetReactionEvent } from './ui/message-list.js';
import { Composer, type SendTextArgs } from './ui/composer.js';
import { isAuthError, classifyWriteFailureReason } from './utils/auth.js';
import { Reconnector, type SubscribeFn } from './ui/reconnect.js';
import { SDKChatClient, SDKChatError, SDKCatalogClient, mintAnonReadToken, AnonReadMintError, mintNamedWriteToken, NamedWriteMintError, fetchRoster, generateUUID, onOutboxDegraded } from '@oxpulse/chat-sdk';
import type {
  MutationEvent as SDKMutationEvent,
  ReactionEvent as SDKReactionEvent,
  OutboxOp,
  CryptoMode,
} from '@oxpulse/chat-sdk';
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
 * #263: debounce window for the reconnect-triggered flushOutbox. Reconnects on
 * a flaky network arrive in bursts (the Reconnector retries with backoff, and
 * browser online/offline events can fire rapidly). 500ms collapses a burst
 * into one flush without noticeably delaying the retry of transient-failure
 * entries. The SDK's in-flight guard handles concurrent calls; this reduces
 * the call count.
 */
const FLUSH_DEBOUNCE_MS = 500;

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
 * issue #67: read-side inverse of composerClient.sendAttachmentMessage's
 * envelope encode (composerClient.uploadAttachment + sendAttachmentMessage
 * below — the old single-shot sendFile field was replaced, not kept, once
 * AttachmentPicker moved to stage-then-send; see PR #88's changeset).
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
/** @internal Exported for tests only. */
export function decodeRowAttachments(row: MessageRow, baseUrl: string): MessageRow {
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
      durationMs: a.durationMs,
      peaks: a.peaks,
    })),
  };
}

// ── OxpulseChatElement ────────────────────────────────────────────────────────

// F3/F5 INTERIM: mode='iframe' is experimental — the iframe is created but no
// real chat client is constructed inside it, and in-place JWT refresh writes
// liveConfig.jwt with no consumer (W2.2 TODO). Emit a one-time console.warn per
// page load so an integrator who selects iframe mode is surfaced the gap
// without spamming on every (re)mount. The full iframe build is tracked
// separately; this is an interim safety notice only.
let __iframeExperimentalWarned = false;

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
  /**
   * #263: debounce timer for the reconnect-triggered flushOutbox. Repeated
   * reconnects on a flaky network collapse into one flush instead of one per
   * reconnect (N×M request amplification). Cleared + restarted on each
   * reconnect; cleared on teardown.
   */
  #flushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live sandboxed iframe (iframe mode only) — target for in-place token refresh. */
  #iframe: HTMLIFrameElement | null = null;
  /** Guard: true while refreshToken() syncs the jwt attribute in place — suppresses the remount. */
  #suppressJwtReboot = false;
  /**
   * D2: Pending retry context for send-failed messages — keyed by msgId.
   * Stores the caption text + send args so the user can retry an upload
   * failure while the page is still open (blob still in memory). The retry
   * re-initiates the send via the composer's non-blocking path.
   */
  #pendingRetries: Map<string, { roomId: string; body: string; sendArgs: import('./ui/composer.js').SendTextArgs }> = new Map();
  /**
   * D2: Bound listener for oxpulse-chat:send-failed events — stored so it
   * can be removed in disconnectedCallback.
   */
  #sendFailedListener: ((ev: Event) => void) | null = null;
  /**
   * R3/F1: Bound dismissFailedOutboxEntry from the effective send client.
   * Stored so #dismissFailedMessage can durably dequeue a failed outbox
   * entry (the user's dismiss must outlive a reload). Null when the client
   * lacks the method (anon-read mode) or after teardown.
   */
  #dismissFailedOutboxEntry: ((roomId: string, msgId: string) => Promise<void>) | null = null;

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
    // #261: drop the outbox-durability subscription. Without this the listener
    // outlives the element and a re-mount stacks another one — the SDK holds
    // them in a module-level set that nothing else clears.
    this.#outboxDegradedDispose?.();
    this.#outboxDegradedDispose = null;
    // D2: remove the send-failed listener and clear retry context.
    if (this.#sendFailedListener) {
      this.removeEventListener('oxpulse-chat:send-failed', this.#sendFailedListener);
      this.#sendFailedListener = null;
    }
    this.#pendingRetries.clear();
    this.#dismissFailedOutboxEntry = null;
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    // #263: cancel any pending debounced reconnect flush.
    if (this.#flushDebounceTimer !== null) {
      clearTimeout(this.#flushDebounceTimer);
      this.#flushDebounceTimer = null;
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

    // Attribute changes that require re-init (JWT, room, app-id, self-uid, base-url, allow-anon-read, allow-write, write-mint-endpoint, reactions-enabled, pinned-messages-enabled, seller-catalog)
    if (name === 'jwt' || name === 'room-id' || name === 'app-id' || name === 'self-uid' || name === 'base-url' || name === 'allow-anon-read' || name === 'allow-write' || name === 'write-mint-endpoint' || name === 'reactions-enabled' || name === 'pinned-messages-enabled' || name === 'seller-catalog') {
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
    // #261: drop the outbox-durability subscription. Without this the listener
    // outlives the element and a re-mount stacks another one — the SDK holds
    // them in a module-level set that nothing else clears.
    this.#outboxDegradedDispose?.();
    this.#outboxDegradedDispose = null;
    // D2: remove the send-failed listener and clear retry context.
    if (this.#sendFailedListener) {
      this.removeEventListener('oxpulse-chat:send-failed', this.#sendFailedListener);
      this.#sendFailedListener = null;
    }
    this.#pendingRetries.clear();
    this.#dismissFailedOutboxEntry = null;
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    // #263: cancel any pending debounced reconnect flush.
    if (this.#flushDebounceTimer !== null) {
      clearTimeout(this.#flushDebounceTimer);
      this.#flushDebounceTimer = null;
    }
    if (this.#shadow) {
      while (this.#shadow.firstChild) {
        this.#shadow.removeChild(this.#shadow.firstChild);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** #261: disposer for the outbox-durability subscription; see #bootstrap. */
  #outboxDegradedDispose: (() => void) | null = null;

  /**
   * #261: report the durability loss at most once per element. The SDK latches
   * the first transition but replays it to every new subscriber, so without this
   * a re-mount reports again — the docs claimed "once per page" and were wrong.
   * Field state survives disconnect/reconnect, which is exactly the scope wanted.
   */
  #outboxUnavailableReported = false;

  /**
   * Store config callbacks from programmatic mount().
   * Not exposed as attributes — only via the JS API.
   * @internal
   */
  _setCallbacks(config: Pick<WidgetConfig, 'onTokenExpired' | 'onError' | 'onWriteError' | 'allowLegacyToken' | '_createClient' | '_mintAnonReadToken' | '_mintNamedWriteToken' | '_createCatalogClient'>): void {
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

  /**
   * #261: the outbox degrades to a no-op when IndexedDB is unavailable — Safari
   * private browsing, storage-pressure eviction, blocked site data. Sending keeps
   * working; what is lost is retry-after-reload. That is a legitimate degradation
   * but it used to be invisible, so a support conversation could not tell "we lost
   * your message" from "durability was never available in this browser".
   *
   * Reported through the EXISTING error channel — `oxpulse-chat:error` plus
   * config.onError — with a new WidgetErrorCode, rather than inventing an event.
   * Note this is NOT #notifyWriteFailure's channel: that one owns
   * `oxpulse-chat:write-error`/onWriteError, which is a write-op failure counter.
   * A durability loss is not a failed write, so it belongs on the general
   * error channel; what is borrowed from it is the WidgetError shape.
   *
   * Fires at most once per element. The SDK latches the first transition, but
   * replays it to every new subscriber, so a re-mount would otherwise report
   * again — and two widgets on a page each report, by design, since each has
   * its own onError.
   */
  #notifyOutboxUnavailable(op: OutboxOp): void {
    if (this.#outboxUnavailableReported) return;
    this.#outboxUnavailableReported = true;
    const err = new WidgetError(
      'OUTBOX_UNAVAILABLE',
      `Message durability is unavailable in this browser (storage failed on ${op}). ` +
        'Sending still works, but unsent messages will not be retried after a reload.',
      { outboxOp: op },
    );
    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:error', {
        bubbles: true,
        composed: true,
        detail: err,
      }),
    );
    if (this.#config?.onError) {
      this.#config.onError(err);
    }
  }

  /**
   * Review finding #4: dispatches `oxpulse-chat:attachment-error` from the
   * widget host element when an attachment's authenticated hydration reaches
   * FINAL failure (after retries exhaust, or immediately for a permanent
   * 403/404/410). Mirrors #notifyWriteFailure's wiring (host-dispatched,
   * bubbles+composed so an integrator on the embedding page can observe it).
   * Dedup happens inside MessageList (once per attachment per final failure).
   */
  #notifyAttachmentError(msgId: string, attachmentId: string): void {
    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:attachment-error', {
        bubbles: true,
        composed: true,
        detail: { msgId, attachmentId, reason: 'hydrate_failed' },
      }),
    );
  }

  /**
   * Observability: dispatches `oxpulse-chat:decrypt-error` from the widget
   * host element when a row carrying an `unsealError` (chat-sdk's
   * classifyUnsealError reason 'replay' | 'auth' | 'unknown') is rendered.
   * Mirrors #notifyAttachmentError's wiring (host-dispatched, bubbles+composed
   * so an integrator on the embedding page can observe it). Dedup happens
   * inside MessageList (once per msgId per widget lifetime). The replay reason
   * is the one that matters most on an untrusted server (replay-attack
   * signature vs a benign auth/timeout).
   */
  #notifyDecryptError(roomId: string, msgId: string, seq: number, reason: 'replay' | 'auth' | 'unknown'): void {
    this.dispatchEvent(
      new CustomEvent('oxpulse-chat:decrypt-error', {
        bubbles: true,
        composed: true,
        detail: { roomId, msgId, seq, reason },
      }),
    );
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
      // F3/F5 INTERIM: one-time experimental notice (see __iframeExperimentalWarned).
      if (!__iframeExperimentalWarned) {
        __iframeExperimentalWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[oxpulse-chat] mode=iframe is experimental and not production-ready — the iframe is created but no real chat client is constructed inside it. Use mode="inline" for production.');
      }
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
          onTyping?: (event: { userId: string; ttlSecs?: number }) => void;
          onPresence?: (event: { userId: string; lastSeenAt: string }) => void;
          onReadReceipt?: (event: { userId: string; lastSeq: number }) => void;
        }): () => void;
        sendText(roomId: string, args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: import('./types.js').ProductMeta }): Promise<{ seq?: number; msgId: string }>;
        // Issue #115: optional — enables optimistic echo for E2EE consumers.
        sendTextOptimistic?(roomId: string, args: { senderUid: string; text: string; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: unknown }): { msgId: string; done: Promise<{ seq: number; msgId: string }>; onPending(cb: () => void): unknown; onSucceeded(cb: (r: { seq: number; msgId: string }) => void): unknown; onFailed(cb: (e: unknown) => void): unknown };
        // Non-blocking attachment send: enqueues to outbox immediately, sends
        // in the background once uploads complete. Returns an OptimisticHandle.
        sendAttachmentMessageOptimistic?(roomId: string, args: { senderUid: string; body: string; uploadPromise: Promise<ArrayBuffer>; msgId?: string; threadRootMsgId?: string; productRef?: string; productMeta?: unknown }): { msgId: string; done: Promise<{ seq: number; msgId: string }>; onPending(cb: () => void): unknown; onSucceeded(cb: (r: { seq: number; msgId: string }) => void): unknown; onFailed(cb: (e: unknown) => void): unknown };
        getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
        sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        /**
         * issue #67: optional — enables attachment upload. composerClient's
         * uploadAttachment + sendAttachmentMessage (below) drive
         * presignAttachment() + PUT + send() directly rather than chat-sdk's
         * own sendFile() convenience wrapper, because that wrapper discards
         * the presigned attachmentId when it calls send() (attachments.ts:163-167) —
         * see the "attachments (issue #67)" comment block near composerClient below.
         * Feature-detected like sendReaction?/getReactions? above; a real
         * SDKChatClient always has all three together.
         */
        send?(roomId: string, args: { senderUid: string; sealed: ArrayBuffer }): Promise<{ seq: number; msgId: string }>;
        /**
         * SEC-CR-001: poisoned-room fail-closed gate for the direct-upload path.
         * uploadAttachment (below) drives presignAttachment() + PUT directly, bypassing
         * chat-sdk's sendFile() and therefore its built-in poison gate. It calls this
         * BEFORE presign so no attachment BYTES leave for a room poisoned by a prior
         * crypto_mode_mismatch. REQUIRED together with send/baseUrl/jwt to enable upload
         * (see the attachmentClient narrowing below): a client that cannot answer poison
         * state is not trusted to upload E2EE bytes — fail closed, not open. A real
         * SDKChatClient always has all four together. Throws
         * SDKChatError('crypto_mode_poisoned') for a poisoned room.
         */
        assertRoomNotPoisoned?(roomId: string): void;
        /**
         * #259: read of the server-discovered crypto_mode for one room. REQUIRED
         * together with assertRoomNotPoisoned/send/baseUrl/jwt to enable upload
         * (see the attachmentClient narrowing below): the direct-upload path must
         * require a POSITIVE plaintext mode, not merely the absence of poison —
         * between mount and the first list()/subscribe() response the room is
         * neither poisoned nor known, and not-poisoned alone would let a
         * plaintext attachment envelope leave for a room the server considers
         * E2EE. Returns the discovered mode, or null when not yet discovered.
         */
        getRoomCryptoMode?(roomId: string): CryptoMode | null;
        /** #120: broadcast typing indicator. Fire-and-forget. */
        sendTyping?(roomId: string, ttlSecs?: number): Promise<void>;
        /** #121: send presence heartbeat. */
        sendPresence?(roomId: string): Promise<void>;
        /** #121: fetch presence snapshot. */
        getPresence?(roomId: string): Promise<Array<{ userId: string; lastSeenAt: string }>>;
        /** #122: mark messages up to seq as read. */
        markRead?(roomId: string, seq: number): Promise<void>;
        /** #126: fetch thread replies. */
        getThread?(roomId: string, rootMsgId: string): Promise<import('./ui/thread-panel.js').ThreadRow[]>;
        /** #228: list pinned messages (ordered by pinned_at desc). */
        listPins?(roomId: string): Promise<import('@oxpulse/chat-sdk').PinnedMessage[]>;
        /** #228: pin a message. Idempotent. */
        pinMessage?(roomId: string, msgId: string): Promise<void>;
        /** #228: unpin a message. No-op if not pinned. */
        unpinMessage?(roomId: string, msgId: string): Promise<void>;
        /** Retry queued outbox messages on reconnect/reload. */
        flushOutbox?(roomId: string): Promise<void>;
        /** Return permanently failed outbox entries (upload interrupted on
         *  reload). The widget reads these on mount to render failed bubbles. */
        getFailedOutboxEntries?(roomId: string): Promise<Array<{ msgId: string; senderUid: string; pendingAttachments?: { body: string }; sendFailed?: { reason: string; failedAt: number }; threadRootMsgId?: string; productRef?: string; productMeta?: unknown }>>;
        /** Dismiss (dequeue) a permanently failed outbox entry. */
        dismissFailedOutboxEntry?(roomId: string, msgId: string): Promise<void>;
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

      // R3/F1: stash the dismissFailedOutboxEntry seam so #dismissFailedMessage
      // can durably dequeue a failed outbox entry (the user's dismiss must
      // outlive a reload). Bound to preserve `this`-less dispatch.
      this.#dismissFailedOutboxEntry = effectiveSendClient?.dismissFailedOutboxEntry
        ? effectiveSendClient.dismissFailedOutboxEntry.bind(effectiveSendClient)
        : null;

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
                  // Bridge SDK MutationEvent → widget MutationEvent.
                  // #229: forward pinnedBy for op="pin" (was dropped before).
                  args.onMutation!({
                    msgId: sdkEv.msgId,
                    op: sdkEv.op,
                    deletedAt: sdkEv.deletedAt,
                    editedAt: sdkEv.editedAt,
                    pinnedBy: sdkEv.pinnedBy,
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

        // #228: pinned messages — listPins via the read client (sdkClient),
        // pin/unpin via the write client (effectiveSendClient), mirroring the
        // reaction bridge pattern. SDK PinnedMessage → widget PinnedEntry
        // (drops appId/roomId — the banner only needs msgId/pinnedBy/pinnedAt).
        listPins: sdkClient.listPins
          ? (roomId: string) => sdkClient.listPins!(roomId).then((pins) =>
              pins.map((p) => ({ msgId: p.msgId, pinnedBy: p.pinnedBy, pinnedAt: p.pinnedAt })),
            )
          : undefined,

        pinMessage: effectiveSendClient?.pinMessage
          ? (roomId: string, msgId: string) => effectiveSendClient!.pinMessage!(roomId, msgId)
          : undefined,

        unpinMessage: effectiveSendClient?.unpinMessage
          ? (roomId: string, msgId: string) => effectiveSendClient!.unpinMessage!(roomId, msgId)
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
            // Review finding #2: throw a TYPED error carrying the HTTP status so
            // hydrateMediaSrc's retry loop can skip retries for permanent statuses
            // (403/404/410) exactly as its comment promises — a plain Error left
            // the status only in the message string, uninspectable, so a gone/
            // forbidden attachment triggered 3 pointless authed fetches.
            throw new AttachmentFetchError(resp.status);
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
        // issue #67 + SEC-CR-001: narrow ONCE to a client that can drive the
        // presign/PUT/send attachment flow (send/baseUrl/jwt) AND enforce the
        // poisoned-room gate (assertRoomNotPoisoned) — a real SDKChatClient always has
        // all four together; test mocks opt in explicitly. Requiring the gate here
        // makes the direct-upload path fail CLOSED: a client that cannot answer poison
        // state simply gets no upload capability. Typed here so
        // uploadAttachment/sendAttachmentMessage below need no per-call-site casts.
        type UploadCapableClient = RawClient & {
          send: NonNullable<RawClient['send']>;
          baseUrl: string;
          jwt: string;
          assertRoomNotPoisoned: NonNullable<RawClient['assertRoomNotPoisoned']>;
          getRoomCryptoMode: NonNullable<RawClient['getRoomCryptoMode']>;
        };
        const attachmentClient: UploadCapableClient | null =
          capturedSendClient.send &&
          capturedSendClient.baseUrl !== undefined &&
          capturedSendClient.jwt !== undefined &&
          typeof capturedSendClient.assertRoomNotPoisoned === 'function' &&
          typeof capturedSendClient.getRoomCryptoMode === 'function'
            ? (capturedSendClient as UploadCapableClient)
            : null;

        // issue #67: split presign/PUT from send so the attachmentId is available
        // before the message is sent (stage-then-send).
        async function uploadAttachment(
          // The presign/PUT wire calls are not themselves room-scoped, but this room IS
          // the poison-gate key (SEC-CR-001, below) and the destination the later
          // sendAttachmentMessage → send(roomId) targets — matching the attachment-picker
          // that passes opts.roomId (attachment-picker.ts). The catch path still uses the
          // outer config!.roomId for token-expired signalling.
          roomId: string,
          blob: Blob,
          args: { mimeType?: string; filename?: string; width?: number; height?: number; signal?: AbortSignal },
        ): Promise<{ attachmentId: string; attachment: EnvelopeAttachment }> {
          try {
            // SEC-CR-001: fail CLOSED. This direct-upload path bypasses chat-sdk's
            // sendFile() gate, so it must assert poison state itself BEFORE presign —
            // otherwise a room poisoned by a prior crypto_mode_mismatch (a downgrade
            // tripwire) would still presign + PUT the file BYTES to storage, leaking the
            // fail-closed guarantee that no message content leaves a poisoned room.
            // Reads the SDK's authoritative #poisonedRooms via the public delegate; a
            // poisoned room throws SDKChatError('crypto_mode_poisoned') here.
            attachmentClient!.assertRoomNotPoisoned(roomId);
            // #259: require a POSITIVE plaintext mode, not merely the absence of
            // poison. assertRoomNotPoisoned (above) asserts "this room was not
            // PROVEN wrong" — it cannot tell a room whose crypto_mode is genuinely
            // known from one whose list()/subscribe() response has not yet arrived
            // (#activeCryptoModeByRoom has no entry until that response carries
            // crypto_mode). In that undiscovered window not-poisoned reads as
            // sufficient, so a plaintext attachment envelope would upload and send
            // into a room the server considers E2EE — silently, with no error on
            // either side. Gating here (BEFORE presign, alongside the poison check)
            // means no outbox entry is ever created in this state, so the
            // transient crypto_mode_undiscovered error never reaches
            // PERMANENT_OUTBOX_FAILURE_CODES classification — the mode becomes known
            // within ~1s of mount and the next attempt succeeds. Distinguishable
            // from poisoning: crypto_mode_poisoned is never retriable (the room was
            // tampered); crypto_mode_undiscovered is retriable the moment discovery
            // lands. The attachment-picker catch path surfaces this as a per-card
            // error with a retry button (the softer composer state), not a hard
            // error bubble — appropriate for a window that closes on its own.
            const discoveredMode = attachmentClient!.getRoomCryptoMode(roomId);
            if (discoveredMode !== 'plaintext') {
              throw new SDKChatError(
                'crypto_mode_undiscovered',
                `room ${roomId} crypto_mode not yet discovered; ` +
                  'wait for list()/subscribe() to report before uploading a plaintext attachment',
              );
            }
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
              // Review fix (LOW, PR #88): spread caller-supplied args FIRST so
              // senderUid/sealed — the authoritative identity + payload —
              // always win, rather than a caller-supplied object being able
              // to silently override them (defense-in-depth; SendTextArgs
              // doesn't declare these keys today, but nothing enforces that
              // at the call site since args flows through a variable, not a
              // literal TS can excess-property-check).
              result = await attachmentClient!.send(roomId, {
                ...args,
                senderUid: resolvedSelfUid ?? '',
                sealed,
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

        // Issue #115: Optimistic echo — insert a local row into the message list
        // BEFORE the server round-trip so the user sees their message instantly.
        // When the server SSE event arrives with the same msgId, #handleNewMessage
        // deduplicates by msgId and updates the row in place (seq, createdAt, etc.).
        const optimisticEcho = (roomId: string, text: string, args: SendTextArgs | undefined, msgId: string): void => {
          if (!self.#messageList) return;
          const optimisticRow: MessageRow = {
            seq: 0,
            msgId,
            senderUid: resolvedSelfUid ?? '',
            sealed: new ArrayBuffer(0),
            plaintext: new TextEncoder().encode(text).buffer as ArrayBuffer,
            createdAt: new Date().toISOString(),
            threadRootMsgId: args?.threadRootMsgId ?? null,
            productRef: args?.productRef ?? null,
            productMeta: args?.productMeta ?? null,
            text,
          };
          self.#messageList.handleMessage(optimisticRow);
        };

        const composerClient = {
          sendText: (roomId: string, text: string, args?: SendTextArgs): Promise<{ msgId: string }> => {
            // Issue #115: generate msgId client-side for optimistic echo dedup.
            const msgId = generateUUID();
            optimisticEcho(roomId, text, args, msgId);
            // Noted (PR #88 review, same class as sendAttachmentMessage below):
            // spread args first so senderUid/text can't be silently overridden.
            return capturedSendClient.sendText(roomId, { ...args, msgId, senderUid: resolvedSelfUid ?? '', text }).then((res) => {
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
            });
          },
          // issue #67: attachments wired end-to-end. Split into uploadAttachment
          // (presign+PUT only) and sendAttachmentMessage (encode+send) so the
          // attachmentId(s) can be staged before the composer sends the message.
          // Only exposed when the underlying client is upload-capable (send/baseUrl/jwt
          // present); paperclip/paste/drag-drop in composer.ts feature-detect this.
          uploadAttachment: attachmentClient ? uploadAttachment : undefined,
          sendAttachmentMessage: attachmentClient ? sendAttachmentMessage : undefined,
          // Non-blocking attachment send: enqueues to the SDK outbox immediately,
          // sends in the background once uploads complete. The composer regains
          // control instantly — the user can keep typing/sending.
          sendAttachmentMessageOptimistic:
            attachmentClient && typeof capturedSendClient.sendAttachmentMessageOptimistic === 'function'
              ? (roomId: string, body: string, attachmentsPromise: Promise<readonly EnvelopeAttachment[]>, args?: SendTextArgs): { msgId: string } => {
                  // Generate msgId client-side for optimistic echo dedup.
                  const msgId = generateUUID();

                  // Optimistic echo — insert a local row immediately so the user
                  // sees their message (with caption) while uploads proceed.
                  optimisticEcho(roomId, body, args, msgId);

                  // D2: Store retry context so the send-failed bubble's retry
                  // button can re-initiate the send (blob is still in memory).
                  self.#pendingRetries.set(msgId, { roomId, body, sendArgs: args ?? {} });

                  // Build the uploadPromise that resolves with sealed bytes once
                  // all attachment uploads complete. The SDK's serial send chain
                  // awaits this before sending.
                  const uploadPromise = attachmentsPromise.then((attachments) => {
                    return encodeAttachmentEnvelope(body, attachments);
                  });

                  const handle = capturedSendClient.sendAttachmentMessageOptimistic!(roomId, {
                    senderUid: resolvedSelfUid ?? '',
                    body,
                    uploadPromise,
                    msgId,
                    threadRootMsgId: args?.threadRootMsgId,
                    productRef: args?.productRef,
                    productMeta: args?.productMeta,
                  });

                  // Fire-and-forget the handle — errors are surfaced via the
                  // handle's onFailed callback, not via the composer. The
                  // composer has already moved on.
                  handle.done.then((res) => {
                    // D2: send succeeded — clear retry context.
                    self.#pendingRetries.delete(msgId);
                    self.dispatchEvent(new CustomEvent('oxpulse-chat:message-sent', {
                      bubbles: true,
                      composed: true,
                      detail: { roomId, msgId: res.msgId },
                    }));
                  }).catch((err: unknown) => {
                    const reason = classifyWriteFailureReason(err);
                    const errMsg = err instanceof Error ? err.message : String(err);
                    self.#notifyWriteFailure('send', reason, errMsg);
                    if (reason === 'auth_expired') {
                      self.#notifyTokenExpired(config!.roomId);
                    }
                    // Dispatch a per-message error event so the message bubble
                    // can show the failure (not the composer — it's long gone).
                    self.dispatchEvent(new CustomEvent('oxpulse-chat:send-failed', {
                      bubbles: true,
                      composed: true,
                      detail: { roomId, msgId, message: errMsg },
                    }));
                  });

                  return { msgId };
                }
              : undefined,
          // Issue #115: wire sendTextOptimistic for both E2EE and plaintext
          // consumers. The SDK returns an OptimisticHandle (callback chain +
          // .done promise), but the Composer expects Promise<{ msgId: string }>.
          // Wrap it: resolve on success, reject on failure. The optimistic row
          // is inserted here via optimisticEcho (using handle.msgId) so the user
          // sees their message instantly — the SDK's outbox path handles only
          // durability + retry, not UI echo.
          sendTextOptimistic: typeof capturedSendClient.sendTextOptimistic === 'function'
            ? (roomId: string, text: string, args?: SendTextArgs): Promise<{ msgId: string }> => {
                const handle = capturedSendClient.sendTextOptimistic!(roomId, { ...args, senderUid: resolvedSelfUid ?? '', text });
                // Optimistic echo — insert a local row immediately so the user
                // sees their message before the server round-trip. The SDK's
                // outbox fires onPending after a microtask, but the echo is a
                // UI concern so we do it here synchronously.
                optimisticEcho(roomId, text, args, handle.msgId);
                return handle.done.then((res) => {
                  self.dispatchEvent(new CustomEvent('oxpulse-chat:message-sent', {
                    bubbles: true,
                    composed: true,
                    detail: { roomId, msgId: res.msgId },
                  }));
                  return { msgId: res.msgId };
                }).catch((err: unknown) => {
                  const reason = classifyWriteFailureReason(err);
                  const errMsg = err instanceof Error ? err.message : String(err);
                  self.#notifyWriteFailure('send', reason, errMsg);
                  if (reason === 'auth_expired') {
                    self.#notifyTokenExpired(config!.roomId);
                  }
                  throw err;
                });
              }
            : undefined,
          // #120: typing indicator — forward to the SDK client's sendTyping.
          sendTyping: capturedSendClient.sendTyping?.bind(capturedSendClient),
        };
        // #196: construct the seller-catalog client from the SAME resolved
        // jwt + baseUrl the main SDK client already uses (no re-derivation),
        // and pass it to the Composer so the product-picker toolbar button
        // renders. Opt-in via the `seller-catalog` attribute (default OFF —
        // no catalogClient, no button, no behaviour change). Only constructed
        // when a composer is actually mounting (effectiveSendClient !== null)
        // — the picker is a compose-side feature, pointless read-only.
        // Tests inject a mock via config._createCatalogClient (mirrors
        // _createClient) to avoid a real network call.
        let catalogClient: SDKCatalogClient | undefined;
        if (config.sellerCatalog && resolvedJwt) {
          const catalogOpts = { jwt: resolvedJwt, baseUrl: resolvedBaseUrl };
          catalogClient = config._createCatalogClient
            ? config._createCatalogClient(catalogOpts)
            : new SDKCatalogClient(catalogOpts);
        }

        this.#composer = new Composer({
          client: composerClient,
          roomId: config.roomId,
          container: widgetRoot,
          signal: signal,
          lang,
          shadowHost: this.#shadow ?? undefined,
          catalogClient,
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
        // Pinned messages toggle. Default true when omitted.
        pinnedMessagesEnabled: config.pinnedMessagesEnabled,
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
        // Review finding #4: final attachment-hydration failure → dispatch
        // `oxpulse-chat:attachment-error` from the host element (mirrors
        // #notifyWriteFailure's oxpulse-chat:write-error wiring).
        onAttachmentError: (msgId, attachmentId) => this.#notifyAttachmentError(msgId, attachmentId),
        // Observability: unsealError row rendered → dispatch
        // `oxpulse-chat:decrypt-error` from the host element (mirrors
        // onAttachmentError's wiring). Deduped once per msgId per widget
        // lifetime inside MessageList.
        onDecryptError: (msgId, seq, reason) => this.#notifyDecryptError(config.roomId, msgId, seq, reason),
        // D2: retry button on a send-failed bubble — re-initiates the send.
        // Only fires for retryable failures (blob still in memory).
        onRetrySendFailed: (msgId: string) => {
          this.#retrySendFailed(config.roomId, msgId);
        },
        // D1: dismiss button on a send-failed bubble — dequeues the outbox
        // entry and removes the row from the list.
        onDismissFailedMessage: (msgId: string) => {
          this.#dismissFailedMessage(config.roomId, msgId);
        },
      });

      await this.#messageList.mount();

      if (signal.aborted) return;

      // H3: Drive flushOutbox on mount — retries queued messages left from a
      // prior session (transient failures that were never dequeued) and marks
      // orphaned pendingAttachments entries as sendFailed. Without this call
      // flushOutbox is dead code (declared + implemented but never invoked).
      // Fire-and-forget: the mount must not block on network retries, and
      // getFailedOutboxEntries below already catches both sendFailed and
      // pendingAttachments entries for display.
      void effectiveSendClient?.flushOutbox?.(config.roomId).catch(() => {});

      // #261: observe the loss of outbox durability. Subscribed here rather than
      // in the constructor because the notifier needs #config, and disposed first
      // so a re-mount does not accumulate listeners. onOutboxDegraded replays to a
      // late subscriber, so a failure that already happened during this mount's
      // first send is still reported.
      this.#outboxDegradedDispose?.();
      this.#outboxDegradedDispose = onOutboxDegraded((d) => {
        if (signal.aborted) return;
        this.#notifyOutboxUnavailable(d.op);
      });

      // D1: Read failed outbox entries on mount — these are messages whose
      // attachment uploads were interrupted by a page reload. The blob is
      // gone, so they are permanently failed (not retryable). Render them as
      // failed bubbles with the caption preserved so the user understands the
      // message did not send and can re-pick the attachment.
      if (effectiveSendClient?.getFailedOutboxEntries) {
        try {
          const failedEntries = await effectiveSendClient.getFailedOutboxEntries(config.roomId);
          for (const entry of failedEntries) {
            const caption = entry.pendingAttachments?.body ?? '';
            const failedRow: MessageRow = {
              seq: 0,
              msgId: entry.msgId,
              senderUid: entry.senderUid,
              sealed: new ArrayBuffer(0),
              plaintext: new TextEncoder().encode(caption).buffer as ArrayBuffer,
              createdAt: new Date(entry.sendFailed?.failedAt ?? Date.now()).toISOString(),
              threadRootMsgId: entry.threadRootMsgId ?? null,
              productRef: entry.productRef ?? null,
              productMeta: (entry.productMeta as import('./types.js').ProductMeta) ?? null,
              text: caption,
              sendFailed: {
                reason: entry.sendFailed?.reason ?? 'Upload interrupted',
                retryable: false, // blob is gone after reload — no retry
              },
            };
            this.#messageList?.handleMessage(failedRow);
          }
        } catch {
          // Best-effort — failed-outbox reading is a UX enhancement, not a gate.
        }
      }

      // D2: Wire the oxpulse-chat:send-failed listener. The composer's
      // non-blocking attachment send path dispatches this event when an upload
      // fails while the page is still open (the blob is still in memory, so
      // retry is meaningful). The listener marks the message bubble as failed
      // with a retry affordance. Without this listener the failure event has
      // no consumer — the user sees nothing.
      if (this.#sendFailedListener) {
        this.removeEventListener('oxpulse-chat:send-failed', this.#sendFailedListener);
      }
      this.#sendFailedListener = (ev: Event) => {
        const detail = (ev as CustomEvent).detail as { roomId: string; msgId: string; message: string };
        if (!detail || detail.roomId !== config.roomId) return;
        // Mark the bubble as failed with retry=true (blob still in memory).
        this.#messageList?.markSendFailed(detail.msgId, detail.message, true);
      };
      this.addEventListener('oxpulse-chat:send-failed', this.#sendFailedListener);

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
        // H3/#263: Drive flushOutbox on reconnect — the connection is back, so
        // transient-failure entries from a prior session get another send
        // attempt. Debounced: repeated reconnects on a flaky network collapse
        // into one flush instead of N (N×M request amplification, bounded by
        // the pending count but unbounded by the reconnect count). The debounce
        // lives in the widget (not the SDK) because the reconnect is a widget
        // concept — the SDK's flushOutbox is a public method with immediate
        // semantics, and a debounce there would change its contract for every
        // caller. The in-flight guard in the SDK prevents duplicate sends from
        // concurrent calls; this debounce reduces the NUMBER of calls.
        // Fire-and-forget: the reconnect must not block on retries.
        if (this.#flushDebounceTimer !== null) {
          clearTimeout(this.#flushDebounceTimer);
        }
        this.#flushDebounceTimer = setTimeout(() => {
          this.#flushDebounceTimer = null;
          void effectiveSendClient?.flushOutbox?.(roomId).catch(() => {});
        }, FLUSH_DEBOUNCE_MS);
        return sdkClient.subscribe(roomId, {
          onMessage: (row) => { this.#messageList?.handleMessage(decodeRowAttachments(row, resolvedBaseUrl)); },
          onError,
          // #229: forward mutation events (edit/delete/pin/unpin) to the
          // MessageList's internal handler — was undefined before, so pin/unpin
          // SSE events were silently dropped on the reconnect path.
          // M5: double-apply safety — Reconnector.#replaceSubscription tears
          // down the old subscription before establishing the new one, so the
          // old and new onMutation handlers never run concurrently. All current
          // mutation ops are idempotent anyway (edit/delete just set timestamps;
          // pin addPin is deduped, removePin is a no-op if absent).
          onMutation: (sdkEv) => {
            this.#messageList?.handleMutation({
              msgId: sdkEv.msgId,
              op: sdkEv.op,
              deletedAt: sdkEv.deletedAt,
              editedAt: sdkEv.editedAt,
              pinnedBy: sdkEv.pinnedBy,
            });
          },
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
    const sellerCatalog = this.hasAttribute('seller-catalog');

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
    const pinnedMessagesEnabled = this.getAttribute('pinned-messages-enabled') !== 'false';

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
      pinnedMessagesEnabled,
      sellerCatalog,
      // Merge stored callbacks + test factory overrides
      onTokenExpired: this.#config?.onTokenExpired,
      onError: this.#config?.onError,
      onWriteError: this.#config?.onWriteError,
      allowLegacyToken: this.#config?.allowLegacyToken,
      _createClient: this.#config?._createClient,
      _mintAnonReadToken: this.#config?._mintAnonReadToken,
      _mintNamedWriteToken: this.#config?._mintNamedWriteToken,
      _createCatalogClient: this.#config?._createCatalogClient,
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

  /**
   * D2/R3: Retry a send-failed message. Restores the caption text into the
   * composer so the user can re-pick the attachment and re-send. The blob is
   * still in memory (retryable=true).
   *
   * #257: The original outbox entry is dequeued before the caption is restored.
   * The user re-picks the attachment and re-sends, minting a new msgId — if
   * the original entry stayed queued, the next flushOutbox (mount/reconnect)
   * would send it too: one user intent, two messages. Mirrors
   * #dismissFailedMessage's fire-and-forget dequeue (best-effort; idb may be
   * unavailable, in which case the entry is already gone from memory).
   *
   * R3/F3: The failed bubble is NOT removed here — the failure stays visible
   * until a re-send is actually dispatched (a new optimistic echo replaces it)
   * or the user dismisses it. Removing the row eagerly destroyed the evidence
   * of the lost message before the user had re-staged the attachment.
   */
  #retrySendFailed(roomId: string, msgId: string): void {
    const ctx = this.#pendingRetries.get(msgId);
    if (!ctx) return;
    this.#pendingRetries.delete(msgId);
    // #257: Dequeue the original outbox entry so the next flushOutbox does
    // not re-send it alongside the user's new send (new msgId). Fire-and-forget
    // — best-effort (idb may be unavailable, in which case the entry is
    // already gone from memory).
    void this.#dismissFailedOutboxEntry?.(roomId, msgId).catch(() => {});
    // Re-insert the caption text into the composer so the user can re-pick
    // the attachment and re-send. The blob is in memory but the staged items
    // were detached, so the user needs to re-stage them. The caption is
    // preserved in the composer input. The failed bubble stays visible.
    this.#composer?.restoreText(ctx.body);
  }

  /**
   * D1/R3: Dismiss a send-failed message. Durably dequeues the outbox entry
   * (so the dismiss survives a reload) and removes the row from the list.
   * No retry — the blob is unrecoverable (reload case) or the user chose to
   * dismiss.
   */
  #dismissFailedMessage(roomId: string, msgId: string): void {
    this.#pendingRetries.delete(msgId);
    this.#messageList?.removeRow(msgId);
    // R3/F1: Durably dequeue from the outbox so the failed bubble does NOT
    // reappear on the next mount. Fire-and-forget — best-effort (idb may be
    // unavailable, in which case the entry is already gone from memory).
    void this.#dismissFailedOutboxEntry?.(roomId, msgId).catch(() => {});
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
  // pinned-messages-enabled defaults to true; only set the attribute explicitly to keep
  // the HTML truthful and to trigger re-init on future attribute changes.
  el.setAttribute('pinned-messages-enabled', config.pinnedMessagesEnabled === false ? 'false' : 'true');

  // #196: opt-in seller-catalog picker — boolean attribute, default OFF.
  if (config.sellerCatalog) el.setAttribute('seller-catalog', '');

  // Store callbacks + test factory overrides (not representable as attributes)
  el._setCallbacks({
    onTokenExpired: config.onTokenExpired,
    onError: config.onError,
    onWriteError: config.onWriteError,
    allowLegacyToken: config.allowLegacyToken,
    _createClient: config._createClient,
    _mintAnonReadToken: config._mintAnonReadToken,
    _mintNamedWriteToken: config._mintNamedWriteToken,
    _createCatalogClient: config._createCatalogClient,
  });

  target.appendChild(el);

  return {
    destroy(): void {
      el.destroy();
      target.removeChild(el);
    },
  };
}
