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
import { Composer } from './ui/composer.js';
import { isAuthError } from './utils/auth.js';
import { Reconnector, type SubscribeFn } from './ui/reconnect.js';

const WIDGET_VERSION = '0.1.0';
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
   * CB2: Stub client's onError trigger — exposed as triggerSubscribeError() for tests.
   * Set during bootstrap so tests can fire async subscribe errors without public API leak.
   */
  #stubTriggerError: ((err: unknown) => void) | null = null;

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
    this.#stubTriggerError = null;
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
    this.#styleEl = null;
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

    // Attribute changes that require re-init (JWT, room, app-id, self-uid)
    if (name === 'jwt' || name === 'room-id' || name === 'app-id' || name === 'self-uid') {
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
   * CB2: Test hook — trigger an error from the stub subscribe() onError callback.
   * Routes through the real error-handling path (Reconnector) rather than bypassing it.
   * @internal — for testing only. Not exposed on the public type surface.
   */
  triggerSubscribeError(err: unknown): void {
    if (this.#stubTriggerError) {
      this.#stubTriggerError(err);
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
    this.#stubTriggerError = null;
    this.#composer?.destroy();
    this.#composer = null;
    this.#messageList?.destroy();
    this.#messageList = null;
    this.#styleEl = null;
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
  _setCallbacks(config: Pick<WidgetConfig, 'onTokenExpired' | 'onError' | 'allowLegacyToken'>): void {
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

    try {
      await checkOrigin(config);
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
      this.#mountIframe(config);
    } else {
      // Inline mode: W2.2 — mount real message list UI
      if (typeof window !== 'undefined' && (window as unknown as { __oxpDebug?: boolean }).__oxpDebug) {
        // eslint-disable-next-line no-console
        console.log(`OxpulseChatWidget ${WIDGET_VERSION} initialized`);
      }

      // Clear placeholder and mount MessageList + Composer.
      // SDK client is not yet wired (slice 3). Use a no-op stub client that
      // returns an empty history and never fires messages. Full SDK wiring is
      // a separate followup (W2.2 slice 3).
      //
      // CB1: The stub client exposes an onError trigger captured in #stubTriggerError
      // so tests can fire async subscribe errors without a public API on the element.
      // The subscribe stub passes onError to the Reconnector's SubscribeFn contract (CM1).
      let capturedOnError: ((err: unknown) => void) | null = null;
      const stubClient = {
        list: (_roomId: string, _args: { limit: number }) =>
          Promise.resolve({ items: [], hasNext: false }),
        subscribe: (_roomId: string, _args: unknown, callbacks?: { onError?: (err: unknown) => void }) => {
          // Capture onError from either new SubscribeFn style or legacy args object
          const cbOnError = callbacks?.onError ?? (typeof _args === 'object' && _args !== null
            ? (_args as Record<string, unknown>)['onError'] as ((err: unknown) => void) | undefined
            : undefined);
          if (cbOnError) capturedOnError = cbOnError;
          return () => {};
        },
        sendText: (_roomId: string, _text: string, _args?: unknown) =>
          Promise.resolve({ msgId: '' }),
        // W2.2 slice 3: reaction stubs — wired to real SDK in a later slice
        getReactions: (_roomId: string, _msgId: string) =>
          Promise.resolve({ counts: {} as Record<string, number>, users: {} as Record<string, string[]>, truncated: false }),
        sendReaction: (_roomId: string, _msgId: string, _emoji: string) =>
          Promise.resolve(),
        removeReaction: (_roomId: string, _msgId: string, _emoji: string) =>
          Promise.resolve(),
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
        client: stubClient,
        roomId: config.roomId,
        container: listContainer,
        lang: config.lang ?? 'en',
        // TODO(slice 5): derive from JWT sub claim once SDK is wired.
        // For now, use the self-uid attribute if provided.
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

      // CB1/CM1: Define SubscribeFn for the reconnect loop using the stub client.
      // onError callback receives async SDK errors and routes them to the Reconnector.
      const subscribeFn: SubscribeFn = (roomId, onError) => {
        return stubClient.subscribe(roomId, {}, { onError }) ?? (() => {});
      };

      // CB2: Expose the onError trigger for tests via triggerSubscribeError().
      // The stub's subscribe is called immediately once to register onError.
      // We wire onError inline so tests can trigger it without public API on the element.
      const reconnector = this.#reconnector;
      this.#stubTriggerError = (err: unknown) => {
        if (isAuthError(err)) {
          reconnector.notifyAuthExpired();
          this.dispatchEvent(new CustomEvent('oxpulse-chat:token-expired', {
            bubbles: true,
            composed: true,
            detail: { roomId: config.roomId },
          }));
          if (this.#config?.onTokenExpired) {
            void this.#config.onTokenExpired();
          }
        } else {
          reconnector.startReconnectLoop(subscribeFn, config.roomId);
        }
      };

      // Composer sits at the bottom of widgetRoot
      this.#composer = new Composer({
        client: stubClient,
        roomId: config.roomId,
        container: widgetRoot,
        signal: signal,
      });
      this.#composer.mount();
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

    if (!appId || !jwt || !roomId) return null;

    const mode = this.getAttribute('mode');
    const theme = this.getAttribute('theme');
    const lang = this.getAttribute('lang');
    const selfUid = this.getAttribute('self-uid');

    return {
      appId,
      jwt,
      roomId,
      mode: (mode === 'inline' || mode === 'iframe') ? mode : 'inline',
      theme: (theme === 'light' || theme === 'dark' || theme === 'auto') ? theme : 'auto',
      lang: lang ?? undefined,
      selfUid: selfUid ?? undefined,
      // Merge stored callbacks
      onTokenExpired: this.#config?.onTokenExpired,
      onError: this.#config?.onError,
      allowLegacyToken: this.#config?.allowLegacyToken,
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
  el.setAttribute('jwt', config.jwt);
  el.setAttribute('room-id', config.roomId);
  if (config.mode) el.setAttribute('mode', config.mode);
  if (config.theme) el.setAttribute('theme', config.theme);
  if (config.lang) el.setAttribute('lang', config.lang);
  if (config.selfUid) el.setAttribute('self-uid', config.selfUid);

  // Store callbacks (not representable as attributes)
  el._setCallbacks({
    onTokenExpired: config.onTokenExpired,
    onError: config.onError,
    allowLegacyToken: config.allowLegacyToken,
  });

  target.appendChild(el);

  return {
    destroy(): void {
      el.destroy();
      target.removeChild(el);
    },
  };
}
