/**
 * @oxpulse/chat-widget — Pinned messages banner (#228).
 *
 * Renders a banner at the top of the message list showing the currently
 * pinned messages. When more than one message is pinned, a carousel
 * (◀ ▶ + index "2/5") lets the user cycle through them.
 *
 * Driven by:
 *   - setPins(pins) — initial load from listPins() on mount
 *   - addPin(msgId, pinnedBy) — live SSE op="pin"
 *   - removePin(msgId) — live SSE op="unpin"
 *
 * Preview text is resolved from the caller's already-decrypted row store
 * (MessageList.#rows) via the `resolvePreview` callback — the banner never
 * fetches or decrypts content itself (E2EE-consistent: the content is
 * already client-side decrypted; a pin pointing outside the loaded window
 * shows a graceful "Message not loaded" placeholder).
 *
 * Clicking the preview jumps to the source message via `onJumpToMessage`.
 *
 * Zero-third-party-dep — plain DOM, matching the widget's existing pattern
 * (typing-indicator.ts, presence-overlay.ts, etc.).
 *
 * Lifecycle:
 *   1. new PinnedBanner({ container, ... }) — mounts hidden immediately
 *   2. setPins/addPin/removePin — update state + re-render
 *   3. destroy() — removes DOM + clears timers
 */

import { t, type Locale } from '../utils/i18n.js';

/** A pinned-message entry — mirrors the fields the banner needs. */
export interface PinnedEntry {
  msgId: string;
  pinnedBy: string;
  pinnedAt: string;
}

export interface PinnedBannerOptions {
  /** Container element to mount the banner into (above the message list). */
  container: HTMLElement;
  /** If provided, insert the banner before this element; otherwise append. */
  insertBefore?: HTMLElement;
  /** BCP-47 tag or resolved Locale. */
  lang?: string;
  /** Optional AbortSignal — destroy() is called automatically on abort. */
  signal?: AbortSignal;
  /** Resolve a msgId → preview text from the caller's decrypted row store.
   *  Returns undefined when the message is outside the loaded window. */
  resolvePreview?: (msgId: string) => string | undefined;
  /** Resolve a userId → display name (from roster). Falls back to userId. */
  resolveName?: (userId: string) => string | undefined;
  /** Called when the user clicks the preview to jump to the source message. */
  onJumpToMessage?: (msgId: string) => void;
}

export class PinnedBanner {
  readonly #container: HTMLElement;
  readonly #insertBefore: HTMLElement | undefined;
  #lang: Locale;
  #signal: AbortSignal | undefined;
  #resolvePreview: (msgId: string) => string | undefined;
  #resolveName: (userId: string) => string | undefined;
  #onJumpToMessage: ((msgId: string) => void) | undefined;

  /** Ordered pinned entries (newest pinned_at first, per listPins contract). */
  #pins: PinnedEntry[] = [];
  /** Current carousel index (0-based). */
  #currentIndex = 0;
  /** Whether the banner has been dismissed by the user (close button).
   *  A new pin/addPin re-shows it (the user dismissed the OLD set). */
  #dismissed = false;

  #root: HTMLElement | null = null;
  #previewEl: HTMLButtonElement | null = null;
  #metaEl: HTMLElement | null = null;
  #counterEl: HTMLElement | null = null;
  #destroyed = false;

  constructor(opts: PinnedBannerOptions) {
    this.#container = opts.container;
    this.#insertBefore = opts.insertBefore;
    this.#lang = (opts.lang as Locale) ?? 'en';
    this.#signal = opts.signal;
    this.#resolvePreview = opts.resolvePreview ?? (() => undefined);
    this.#resolveName = opts.resolveName ?? ((id: string) => id);
    this.#onJumpToMessage = opts.onJumpToMessage;

    this.#ensureMounted();
    this.#render();

    if (this.#signal) {
      this.#signal.addEventListener('abort', () => this.destroy(), { once: true });
    }
  }

  /** Replace the full pinned set (initial load from listPins). */
  setPins(pins: readonly PinnedEntry[]): void {
    if (this.#destroyed) return;
    this.#pins = [...pins];
    this.#currentIndex = 0;
    this.#dismissed = false;
    this.#render();
  }

  /** Add a pin (live SSE op="pin"). Idempotent — if already present, no-op. */
  addPin(msgId: string, pinnedBy: string, pinnedAt: string): void {
    if (this.#destroyed) return;
    if (this.#pins.some((p) => p.msgId === msgId)) return;
    // Prepend: listPins returns pinned_at desc, so newest first.
    this.#pins.unshift({ msgId, pinnedBy, pinnedAt });
    this.#dismissed = false;
    this.#render();
  }

  /** Remove a pin (live SSE op="unpin"). No-op if not present. */
  removePin(msgId: string): void {
    if (this.#destroyed) return;
    const idx = this.#pins.findIndex((p) => p.msgId === msgId);
    if (idx === -1) return;
    this.#pins.splice(idx, 1);
    if (this.#currentIndex >= this.#pins.length) {
      this.#currentIndex = Math.max(0, this.#pins.length - 1);
    }
    this.#render();
  }

  /** Whether a message is currently in the pinned set. */
  isPinned(msgId: string): boolean {
    return this.#pins.some((p) => p.msgId === msgId);
  }

  /** Get the set of pinned msgIds (for footer pin-button state). */
  getPinnedMsgIds(): Set<string> {
    return new Set(this.#pins.map((p) => p.msgId));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#root?.remove();
    this.#root = null;
    this.#previewEl = null;
    this.#metaEl = null;
    this.#counterEl = null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  #ensureMounted(): void {
    if (this.#root) return;
    this.#root = document.createElement('div');
    this.#root.className = 'oxp-pinned-banner';
    this.#root.style.display = 'none';

    // Pin icon
    const iconEl = document.createElement('span');
    iconEl.className = 'oxp-pinned-banner-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = '📌';

    // Content area (preview + meta)
    const contentEl = document.createElement('div');
    contentEl.className = 'oxp-pinned-banner-content';

    this.#previewEl = document.createElement('button');
    this.#previewEl.className = 'oxp-pinned-banner-preview';
    this.#previewEl.addEventListener('click', () => {
      const entry = this.#pins[this.#currentIndex];
      if (entry) this.#onJumpToMessage?.(entry.msgId);
    });

    this.#metaEl = document.createElement('span');
    this.#metaEl.className = 'oxp-pinned-banner-meta';

    contentEl.appendChild(this.#previewEl);
    contentEl.appendChild(this.#metaEl);

    // Carousel controls (prev / counter / next)
    const navEl = document.createElement('div');
    navEl.className = 'oxp-pinned-banner-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'oxp-pinned-banner-nav-btn';
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t('pinnedBannerPrevAria', this.#lang));
    prevBtn.textContent = '◀';
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#cycle(-1);
    });

    this.#counterEl = document.createElement('span');
    this.#counterEl.className = 'oxp-pinned-banner-counter';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'oxp-pinned-banner-nav-btn';
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t('pinnedBannerNextAria', this.#lang));
    nextBtn.textContent = '▶';
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#cycle(1);
    });

    navEl.appendChild(prevBtn);
    navEl.appendChild(this.#counterEl);
    navEl.appendChild(nextBtn);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'oxp-pinned-banner-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('pinnedBannerCloseAria', this.#lang));
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#dismissed = true;
      this.#render();
    });

    this.#root.appendChild(iconEl);
    this.#root.appendChild(contentEl);
    this.#root.appendChild(navEl);
    this.#root.appendChild(closeBtn);

    if (this.#insertBefore) {
      this.#container.insertBefore(this.#root, this.#insertBefore);
    } else {
      this.#container.appendChild(this.#root);
    }
  }

  #cycle(delta: number): void {
    if (this.#pins.length <= 1) return;
    this.#currentIndex = (this.#currentIndex + delta + this.#pins.length) % this.#pins.length;
    this.#render();
  }

  #render(): void {
    if (this.#destroyed) return;
    this.#ensureMounted();
    if (!this.#root || !this.#previewEl || !this.#metaEl || !this.#counterEl) return;

    if (this.#pins.length === 0 || this.#dismissed) {
      this.#root.style.display = 'none';
      return;
    }

    this.#root.style.display = 'flex';

    const entry = this.#pins[this.#currentIndex];
    if (!entry) {
      this.#root.style.display = 'none';
      return;
    }

    // Preview text from the caller's decrypted row store.
    const preview = this.#resolvePreview(entry.msgId);
    if (preview !== undefined) {
      this.#previewEl.textContent = preview;
      this.#previewEl.removeAttribute('data-not-loaded');
      this.#previewEl.setAttribute(
        'aria-label',
        t('pinnedBannerJumpAria', this.#lang),
      );
    } else {
      this.#previewEl.textContent = t('pinnedBannerNotLoaded', this.#lang);
      this.#previewEl.setAttribute('data-not-loaded', 'true');
      this.#previewEl.setAttribute(
        'aria-label',
        t('pinnedBannerNotLoaded', this.#lang),
      );
    }

    // Meta: "Pinned by {name}"
    const name = this.#resolveName(entry.pinnedBy) ?? entry.pinnedBy;
    this.#metaEl.textContent = t('pinnedBannerPinnedBy', this.#lang, { name });

    // Counter: "2/5" when >1, hidden when 1
    if (this.#pins.length > 1) {
      this.#counterEl.textContent = `${this.#currentIndex + 1}/${this.#pins.length}`;
      this.#counterEl.style.display = '';
      this.#root.setAttribute('data-multi', 'true');
    } else {
      this.#counterEl.style.display = 'none';
      this.#root.removeAttribute('data-multi');
    }
  }
}
