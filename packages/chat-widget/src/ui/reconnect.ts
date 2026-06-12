/**
 * @oxpulse/chat-widget — Reconnector + BackoffStrategy (W2.2 slice 5).
 */

import { isAuthError } from '../utils/auth.js';

// ── BackoffStrategy ───────────────────────────────────────────────────────────

const MAX_DELAY_MS = 8_000;
const MAX_ATTEMPTS = 10;
const JITTER = 0.20;

/**
 * Exponential backoff: attempt 0=0ms, 1=1s, 2=2s, 3=4s, 4=8s (cap).
 * Attempt 5+: 8s ±20% jitter.
 */
export class BackoffStrategy {
  delayMs(attempt: number): number {
    if (attempt === 0) return 0;
    const base = Math.min(1_000 * Math.pow(2, attempt - 1), MAX_DELAY_MS);
    if (attempt <= 4) return base;
    const jr = MAX_DELAY_MS * JITTER;
    return Math.round(MAX_DELAY_MS - jr + Math.random() * jr * 2);
  }

  shouldGiveUp(attempt: number): boolean { return attempt >= MAX_ATTEMPTS; }
  reset(): void { /* stateless — caller resets attempt counter */ }
  shouldRetryOnAuthError(): boolean { return false; }
}

// ── Reconnector ───────────────────────────────────────────────────────────────

type ReconnectState = 'idle' | 'auth-expired' | 'reconnecting' | 'connected';

/**
 * CM1: SubscribeFn accepts an onError callback for async error surfacing.
 * Sync throws are also caught via try/catch in #scheduleAttempt.
 */
export type SubscribeFn = (roomId: string, onError: (err: unknown) => void) => (() => void);

export interface ReconnectorOptions {
  container: HTMLElement;
  host: EventTarget;
  signal?: AbortSignal;
}

/**
 * Manages reconnect banners and retry loops for the chat widget.
 *
 * notifyAuthExpired()  → role="alert" aria-live="assertive" (action required)
 * notifyNetworkLost(n) → role="status" aria-live="polite"   (auto-retry)
 * notifyReconnected()  → brief toast, auto-hides after 2s
 * notifyGivenUp()      → "Reconnect manually" button
 * clear()              → removes banner + stops loop
 * destroy()            → full cleanup: timers, banner, window listeners
 *
 * Design M1: Banner DOM node is created once and mutated in-place across state
 * transitions so aria-live region survives — screen readers receive all announcements.
 */
export class Reconnector {
  #container: HTMLElement;
  #host: EventTarget;
  #signal: AbortSignal | undefined;
  /** Design M1: single persistent banner node, never removed/re-created mid-lifecycle. */
  #banner: HTMLElement | null = null;
  #state: ReconnectState = 'idle';
  #clearTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #attempt = 0;
  #roomId = '';
  #subscribeFn: SubscribeFn | null = null;
  #backoff = new BackoffStrategy();
  #destroyed = false;

  constructor(opts: ReconnectorOptions) {
    this.#container = opts.container;
    this.#host = opts.host;
    this.#signal = opts.signal;

    // CM2: AbortSignal wires to destroy() — once: true prevents leak
    opts.signal?.addEventListener('abort', () => this.destroy(), { once: true });

    // CM3: online/offline window listeners — use signal for auto-cleanup when available
    const onlineHandler = (): void => { this.#onOnline(); };
    const offlineHandler = (): void => { this.notifyNetworkLost(this.#attempt); };
    if (opts.signal) {
      window.addEventListener('online', onlineHandler, { signal: opts.signal });
      window.addEventListener('offline', offlineHandler, { signal: opts.signal });
    } else {
      // No signal — track manually for destroy()
      window.addEventListener('online', onlineHandler);
      window.addEventListener('offline', offlineHandler);
      this.#onlineHandler = onlineHandler;
      this.#offlineHandler = offlineHandler;
    }
  }

  // Manual cleanup refs when no AbortSignal provided
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  notifyAuthExpired(): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    // Design M4/CM7: stop loop BEFORE showing banner — prevents scheduled tick from
    // overwriting the auth-expired state after this call returns.
    this.stopReconnectLoop();
    this.#updateBanner('auth-expired', 'alert', 'assertive', 'Session expired.', {
      label: 'Refresh', ariaLabel: 'Refresh session',
      onClick: () => {
        this.#host.dispatchEvent(new CustomEvent('oxpulse-chat:token-expired', {
          bubbles: true, composed: true,
        }));
      },
    });
    // Design M3: only seize focus if no meaningful element currently has it
    this.#maybeFocusBtn();
  }

  notifyNetworkLost(attempt: number): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    this.#updateBanner('reconnecting', 'status', 'polite',
      `Connection lost. Reconnecting… (attempt ${attempt})`);
  }

  notifyReconnected(): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    // Design M4: stop loop so reconnected state isn't overwritten by a late tick
    this.stopReconnectLoop();
    this.#updateBanner('connected', 'status', 'polite', 'Connected.');
    this.#clearTimer = setTimeout(() => {
      this.#removeBannerFromDom();
      this.#clearTimer = null;
    }, 2_000);
  }

  notifyGivenUp(): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    this.#updateBanner('auth-expired', 'alert', 'assertive', 'Could not reconnect.', {
      label: 'Reconnect', ariaLabel: 'Retry connection manually',
      onClick: () => {
        if (this.#subscribeFn && this.#roomId) {
          this.#attempt = 0;
          this.startReconnectLoop(this.#subscribeFn, this.#roomId);
        }
      },
    });
    this.#maybeFocusBtn();
  }

  clear(): void {
    // Remove banner from DOM entirely on explicit clear (resets aria-live region fully).
    // State-transition hides are via #hideBanner() which keeps the node.
    if (this.#clearTimer !== null) { clearTimeout(this.#clearTimer); this.#clearTimer = null; }
    this.stopReconnectLoop();
    this.#removeBannerFromDom();
    this.#state = 'idle';
  }

  /**
   * Full cleanup: timers, banner DOM, window listeners, abort signal listener.
   * CM2: Called by AbortSignal abort event (once) and by element disconnectedCallback.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.clear();
    // CM3: remove window listeners if signal wasn't used (manual cleanup path)
    if (this.#onlineHandler) {
      window.removeEventListener('online', this.#onlineHandler);
      this.#onlineHandler = null;
    }
    if (this.#offlineHandler) {
      window.removeEventListener('offline', this.#offlineHandler);
      this.#offlineHandler = null;
    }
    // Remove persistent banner from DOM (if visible)
    this.#removeBannerFromDom();
    this.#banner = null;
  }

  startReconnectLoop(subscribeFn: SubscribeFn, roomId: string): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    this.#subscribeFn = subscribeFn;
    this.#roomId = roomId;
    this.#scheduleAttempt();
  }

  stopReconnectLoop(): void {
    if (this.#reconnectTimer !== null) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    if (this.#unsubscribe) { this.#unsubscribe(); this.#unsubscribe = null; }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #scheduleAttempt(): void {
    if (this.#destroyed || this.#signal?.aborted || !this.#subscribeFn) return;
    if (this.#backoff.shouldGiveUp(this.#attempt)) { this.notifyGivenUp(); return; }
    const delay = this.#backoff.delayMs(this.#attempt);
    this.notifyNetworkLost(this.#attempt + 1);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#destroyed || this.#signal?.aborted || !this.#subscribeFn) return;
      // CM1: pass onError callback so async SDK errors surface correctly
      const onError = (err: unknown): void => {
        if (this.#destroyed || this.#signal?.aborted) return;
        if (isAuthError(err)) { this.notifyAuthExpired(); return; }
        this.#attempt++;
        this.#scheduleAttempt();
      };
      try {
        const unsub = this.#subscribeFn(this.#roomId, onError);
        this.#unsubscribe = unsub;
        this.notifyReconnected();
        this.#attempt = 0;
      } catch (err) {
        if (isAuthError(err)) { this.notifyAuthExpired(); return; }
        this.#attempt++;
        this.#scheduleAttempt();
      }
    }, delay);
  }

  /** CM3: Retry immediately when browser comes back online and we're reconnecting. */
  #onOnline(): void {
    if (this.#destroyed || this.#signal?.aborted) return;
    if (this.#state === 'reconnecting' && this.#subscribeFn) {
      // Cancel the pending timer and fire immediately (delay=0)
      if (this.#reconnectTimer !== null) {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
      }
      // Schedule with delay=0 regardless of backoff — network is back, try now
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        if (this.#destroyed || this.#signal?.aborted || !this.#subscribeFn) return;
        const onError = (err: unknown): void => {
          if (this.#destroyed || this.#signal?.aborted) return;
          if (isAuthError(err)) { this.notifyAuthExpired(); return; }
          this.#attempt++;
          this.#scheduleAttempt();
        };
        try {
          const unsub = this.#subscribeFn(this.#roomId, onError);
          this.#unsubscribe = unsub;
          this.notifyReconnected();
          this.#attempt = 0;
        } catch (err) {
          if (isAuthError(err)) { this.notifyAuthExpired(); return; }
          this.#attempt++;
          this.#scheduleAttempt();
        }
      }, 0);
    }
  }

  /**
   * Design M1: Instead of removing+re-creating the banner, mutate its content
   * in-place. Creates banner once on first call, then updates state/text/button.
   * This preserves the aria-live region so screen readers receive all announcements.
   */
  #updateBanner(
    state: ReconnectState, role: 'alert' | 'status', ariaLive: 'assertive' | 'polite',
    text: string,
    btn?: { label: string; ariaLabel: string; onClick: () => void },
  ): void {
    this.#state = state;

    // Ensure persistent banner node exists and is in DOM
    if (!this.#banner) {
      const el = document.createElement('div');
      el.className = 'oxp-reconnect-banner';
      this.#banner = el;
    }
    if (!this.#banner.parentNode) {
      this.#container.appendChild(this.#banner);
    }
    // Remove hidden attr if present
    this.#banner.removeAttribute('hidden');

    // Update attributes in-place
    this.#banner.setAttribute('data-state', state);
    this.#banner.setAttribute('role', role);
    this.#banner.setAttribute('aria-live', ariaLive);

    // Rebuild children (text + optional button) — minimal DOM churn inside the node
    // The node identity is preserved; only its content changes.
    while (this.#banner.firstChild) this.#banner.removeChild(this.#banner.firstChild);

    const span = document.createElement('span');
    span.textContent = text;
    this.#banner.appendChild(span);

    if (btn) {
      const b = document.createElement('button');
      b.className = 'oxp-reconnect-btn';
      b.textContent = btn.label;
      b.setAttribute('aria-label', btn.ariaLabel);
      b.addEventListener('click', btn.onClick, { once: true });
      this.#banner.appendChild(b);
    }
  }

  /** Hide banner without removing from DOM (preserves aria-live region for state transitions). */
  #hideBanner(): void {
    if (this.#banner) {
      this.#banner.setAttribute('hidden', '');
    }
  }

  /** Remove banner from DOM entirely (used by clear() and notifyReconnected timer). */
  #removeBannerFromDom(): void {
    if (this.#banner?.parentNode) {
      this.#banner.parentNode.removeChild(this.#banner);
    }
    // Keep #banner ref so it can be re-appended on next show without re-creating
    // (design M1: node identity preserved across lifecycle, just not always in DOM)
  }

  /**
   * Design M3: Focus the refresh button only when no meaningful element has focus.
   * Prevents mid-keystroke focus theft.
   */
  #maybeFocusBtn(): void {
    const active = (this.#host as unknown as { shadowRoot?: { activeElement: Element | null } }).shadowRoot?.activeElement ?? document.activeElement;
    if (!active || active === document.body || active === this.#host) {
      const btn = this.#banner?.querySelector('button') as HTMLButtonElement | null;
      btn?.focus();
    }
  }
}

/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export { isAuthError };
