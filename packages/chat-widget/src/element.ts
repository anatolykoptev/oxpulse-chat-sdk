/**
 * @oxpulse/chat-widget — <oxpulse-chat> Custom Element.
 *
 * Skeleton: handles lifecycle + origin check + placeholder rendering.
 * Full UI (message list, composer, reactions) ships in W2.2.
 *
 * Voice/video interface reserved for v3.0: see WidgetConfig for attribute stub.
 */

import { checkOrigin } from './bootstrap.js';
import {
  WidgetError,
  OriginNotAllowedError,
  OBSERVED_ATTRIBUTES,
  type MountOptions,
  type WidgetConfig,
} from './types.js';
import { THEME_CSS, applyTheme } from './ui/theme.js';
import { MessageList } from './ui/message-list.js';
import type { MessageListClient, MessageRow, MutationEvent as WidgetMutationEvent, ReactionEvent as WidgetReactionEvent } from './ui/message-list.js';
import { Composer } from './ui/composer.js';
import { isAuthError } from './utils/auth.js';
import { Reconnector, type SubscribeFn } from './ui/reconnect.js';
import { SDKChatClient, mintAnonReadToken, AnonReadMintError, mintNamedWriteToken, NamedWriteMintError, fetchRoster } from '@oxpulse/chat-sdk';
import type { MutationEvent as SDKMutationEvent, ReactionEvent as SDKReactionEvent } from '@oxpulse/chat-sdk';

const WIDGET_VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0-dev';
const ELEMENT_TAG = 'oxpulse-chat';

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

    // Attribute changes that require re-init (JWT, room, app-id, self-uid, base-url, allow-anon-read, allow-write, write-mint-endpoint)
    if (name === 'jwt' || name === 'room-id' || name === 'app-id' || name === 'self-uid' || name === 'base-url' || name === 'allow-anon-read' || name === 'allow-write' || name === 'write-mint-endpoint') {
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
   * Updates the jwt attribute and re-bootstraps.
   */
  refreshToken(jwt: string): void {
    // Only re-bootstrap if the value actually changes
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
  _setCallbacks(config: Pick<WidgetConfig, 'onTokenExpired' | 'onError' | 'allowLegacyToken' | '_createClient' | '_mintAnonReadToken' | '_mintNamedWriteToken'>): void {
    this.#config = {
      ...(this.#config ?? { appId: '', jwt: '', roomId: '' }),
      ...config,
    };
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

    // Clear previous content
    if (this.#anonRenewTimer !== null) {
      clearTimeout(this.#anonRenewTimer);
      this.#anonRenewTimer = null;
    }
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
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
    this.#renderPlaceholder('Chat loading…');

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
        // Fire token-expired event
        this.dispatchEvent(
          new CustomEvent('oxpulse-chat:token-expired', {
            bubbles: true,
            composed: true,
            detail: { roomId: config.roomId },
          }),
        );
        // Call onTokenExpired callback if provided
        if (this.#config?.onTokenExpired) {
          void this.#config.onTokenExpired();
        }
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
          onMutation?: (event: SDKMutationEvent) => void;
          onReaction?: (event: SDKReactionEvent) => void;
        }): () => void;
        sendText(roomId: string, args: { senderUid: string; text: string; msgId?: string }): Promise<{ seq?: number; msgId: string }>;
        getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
        sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
        /** T18: roster fetch. Optional — when absent roster is disabled. */
        getRoster?(appId: string, roomId: string): Promise<Map<string, string>>;
      }

      // ── Anon-read mode: mint token when allow-anon-read is set and no jwt provided ──
      const resolvedBaseUrl = config.baseUrl ?? 'https://oxpulse.chat';
      let resolvedJwt = config.jwt;
      let isAnonMode = false;

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
      //      (roomId, text, args?) with senderUid derived from config.selfUid.
      //   4. SDK sendText() returns { seq, msgId } — ComposerClient expects { msgId }.

      // onError handler shared between the real subscribe() callback and #subscribeOnError
      // (so tests can fire it via triggerSubscribeError() without going through real SSE).
      let reconnectorRef: Reconnector | null = null;
      let subscribeFnRef: SubscribeFn | null = null;

      const handleSubscribeError = (err: unknown): void => {
        // Normalise SDKChatError.statusCode → err.status so isAuthError() can detect it.
        const errObj: Record<string, unknown> =
          err != null && typeof err === 'object' ? (err as Record<string, unknown>) : {};
        const normalised: Record<string, unknown> = {
          ...errObj,
          // Bridge SDKChatError.statusCode → .status so isAuthError() can detect 401.
          status: errObj['status'] ?? errObj['statusCode'],
          // Bridge SDKChatError.code === 'unauthorized' → kind 'auth_expired'.
          kind: errObj['kind'] ?? (errObj['code'] === 'unauthorized' ? 'auth_expired' : undefined),
        };
        if (isAuthError(normalised)) {
          reconnectorRef?.notifyAuthExpired();
          this.dispatchEvent(new CustomEvent('oxpulse-chat:token-expired', {
            bubbles: true,
            composed: true,
            detail: { roomId: config.roomId },
          }));
          if (this.#config?.onTokenExpired) {
            void this.#config.onTokenExpired();
          }
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
          sdkClient.list(roomId, { limit: args.limit }),

        subscribe: (roomId: string, args: {
          onMessage: (row: MessageRow) => void;
          onMutation?: (event: WidgetMutationEvent) => void;
          onReaction?: (event: WidgetReactionEvent) => void;
          onRosterSignal?: () => void;
        }) => {
          return sdkClient.subscribe(roomId, {
            onMessage: args.onMessage,
            onError: handleSubscribeError,
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
                  // Widget: { emoji, userUid, op: 'add'|'remove', totalCount }
                  // totalCount is not available from the live SSE event; set to 0
                  // (MessageList maintains its own count state from getReactions).
                  args.onReaction!({
                    msgId: sdkEv.msgId,
                    emoji: sdkEv.reaction,
                    op: sdkEv.op === 'reaction_add' ? 'add' : 'remove',
                    userUid: sdkEv.userId,
                    totalCount: 0,
                  });
                }
              : undefined,
          });
        },

        getReactions: (roomId: string, msgId: string) =>
          sdkClient.getReactions?.(roomId, msgId) ??
          Promise.resolve({ counts: {}, users: {}, truncated: false }),

        sendReaction: (roomId: string, msgId: string, emoji: string) =>
          sdkClient.sendReaction?.(roomId, msgId, emoji) ?? Promise.resolve(),

        removeReaction: (roomId: string, msgId: string, emoji: string) =>
          sdkClient.removeReaction?.(roomId, msgId, emoji) ?? Promise.resolve(),

        // T18: roster — fetch names for OTHER writers via the same JWT.
        // Uses the real fetchRoster helper (injected for tests via _createClient mock).
        getRoster: sdkClient.getRoster
          ? (roomId: string) => sdkClient.getRoster!(config.appId, roomId)
          : (roomId: string) => fetchRoster({
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

      this.#messageList = new MessageList({
        client: widgetClient,
        roomId: config.roomId,
        container: listContainer,
        lang: config.lang ?? 'en',
        // selfUid from element attribute (JWT sub claim wiring is a future slice).
        selfUid: config.selfUid ?? '',
        signal: signal,
        // MAJOR-5: pass shadow root so ReactionPicker mounts outside overflow:hidden widgetRoot.
        shadowHost: this.#shadow ?? undefined,
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
      });
      reconnectorRef = this.#reconnector;

      // CB1/CM1: SubscribeFn for the Reconnector's retry loop.
      // When the SDK's internal reconnect exhausts and fires onError, the Reconnector
      // calls this fn to re-establish the stream. We route new messages to the existing
      // MessageList via its public handleMessage() method.
      const subscribeFn: SubscribeFn = (roomId, onError) => {
        return sdkClient.subscribe(roomId, {
          onMessage: (row) => { this.#messageList?.handleMessage(row); },
          onError,
          onMutation: undefined,
          onReaction: undefined,
        });
      };
      subscribeFnRef = subscribeFn;

      // Composer sits at the bottom of widgetRoot.
      // Decision matrix:
      //   isAnonMode && !writeClient → read-only (composer hidden, capability-based block)
      //   isAnonMode && writeClient  → named-write JWT available; wire composer to writeClient
      //   !isAnonMode               → authed path; standard JWT handles sends via sdkClient
      //                               UNLESS allowWrite + writeClient: use write client instead
      // In all cases: writeClient (if present) takes precedence for sends (named-write capability).
      const effectiveSendClient: RawClient | null = writeClient ?? (!isAnonMode ? sdkClient : null);

      if (effectiveSendClient !== null) {
        // ComposerClient adapter — bridges (roomId, text) → SDK { senderUid, text }.
        // Write path only wired when there is a capable JWT (named-write or standard authed).
        // senderUid: config.selfUid if present; the server authorizes by the JWT sub, not sender_uid.
        const capturedSendClient = effectiveSendClient;
        // isNamedWritePath: true when effectiveSendClient is the dedicated writeClient.
        // Used to dispatch the specific oxpulse-chat:write-error event on send failure
        // (in addition to the generic oxpulse-chat:error the Composer fires internally).
        const isNamedWritePath = writeClient !== null && capturedSendClient === writeClient;
        const self = this;
        const composerClient = {
          sendText: (roomId: string, text: string, _args?: unknown): Promise<{ msgId: string }> =>
            capturedSendClient.sendText(roomId, { senderUid: config.selfUid ?? '', text }).then((res) => {
              // Dispatch message-sent event on success
              self.dispatchEvent(new CustomEvent('oxpulse-chat:message-sent', {
                bubbles: true,
                composed: true,
                detail: { roomId, msgId: res.msgId },
              }));
              return res;
            }).catch((err: unknown) => {
              // For the named-write path: dispatch oxpulse-chat:write-error with
              // WRITE_SEND_FAILED so integrators can distinguish write failures from
              // generic widget errors. The Composer's own catch still fires
              // oxpulse-chat:error and renders the inline error chip — we do not swallow.
              if (isNamedWritePath) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const writeErr = new WidgetError('WRITE_SEND_FAILED', errMsg);
                self.dispatchEvent(new CustomEvent('oxpulse-chat:write-error', {
                  bubbles: true,
                  composed: true,
                  detail: writeErr,
                }));
              }
              // Re-throw so the Composer's catch path fires (renders error chip + generic error event).
              throw err;
            }),
        };
        this.#composer = new Composer({
          client: composerClient,
          roomId: config.roomId,
          container: widgetRoot,
          signal: signal,
        });
        this.#composer.mount();
      }
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

    const baseUrl = config.baseUrl ?? 'https://oxpulse.chat';
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
    const selfUid = this.getAttribute('self-uid');
    const baseUrl = this.getAttribute('base-url') ?? undefined;

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
      // Merge stored callbacks + test factory overrides
      onTokenExpired: this.#config?.onTokenExpired,
      onError: this.#config?.onError,
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

  // Store callbacks + test factory overrides (not representable as attributes)
  el._setCallbacks({
    onTokenExpired: config.onTokenExpired,
    onError: config.onError,
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
