/**
 * @oxpulse/chat-widget — ReactionPicker (W2.2 slice 3).
 *
 * Plain TS class, no framework. Renders emoji buttons inside the container,
 * handles keyboard navigation, outside click, and AbortSignal.
 */

import { REACTION_EMOJIS, reactionAriaLabel } from '../utils/reaction-types.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';

// ── Constructor options ───────────────────────────────────────────────────────

export interface ReactionPickerOptions {
  /** Container element to render the picker inside. */
  container: HTMLElement;
  /** Called when the user selects an emoji. */
  onSelect: (emoji: string) => void;
  /** Optional abort signal — when aborted, show() becomes a no-op. */
  signal?: AbortSignal;
  /** BCP-47 tag or an already-resolved Locale. Optional — defaults via resolveLocale(). */
  lang?: string;
}

// ── ReactionPicker ────────────────────────────────────────────────────────────

/**
 * ReactionPicker renders a floating emoji selection popover.
 *
 * Lifecycle:
 *   show(anchorEl) — appends picker to container, positions it, focuses first emoji
 *   hide()         — removes from DOM, restores focus to anchor
 *
 * A11y:
 *   role="dialog", first emoji focused on open, Arrow keys navigate,
 *   Escape hides + restores focus to anchor, outside mousedown hides.
 */
export class ReactionPicker {
  #container: HTMLElement;
  #onSelect: (emoji: string) => void;
  #signal: AbortSignal | undefined;
  #lang: Locale;
  #pickerEl: HTMLElement | null = null;
  #anchorEl: HTMLElement | null = null;
  #outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  #keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Code MAJOR-2: abort listener to hide picker when signal fires mid-open. */
  #abortListener: (() => void) | null = null;
  /** Buttons inside picker — stored for Tab focus trap. */
  #pickerButtons: HTMLButtonElement[] = [];
  /** Track where the picker was mounted to determine positioning strategy. */
  #mountTo: HTMLElement | undefined = undefined;

  constructor(opts: ReactionPickerOptions) {
    this.#container = opts.container;
    this.#onSelect = opts.onSelect;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
  }

  /**
   * Show the picker anchored to the given element.
   *
   * @param anchorEl  — element to anchor position to
   * @param mountTo   — element to append the picker to (default: constructor container).
   *                    Pass the ShadowRoot host element to escape overflow:hidden clip contexts.
   *                    F3 (design MAJOR-5): container has overflow:hidden which clips absolute children.
   */
  show(anchorEl: HTMLElement, mountTo?: HTMLElement): void {
    if (this.#signal?.aborted) return;
    // If already visible, hide first
    if (this.#pickerEl) this.#removePicker();

    this.#anchorEl = anchorEl;
    this.#mountTo = mountTo;
    this.#pickerEl = this.#buildPicker();
    const appendTarget = mountTo ?? this.#container;
    appendTarget.appendChild(this.#pickerEl);

    // Position: above anchor if room, below otherwise
    this.#position(anchorEl);

    // Focus first button
    if (this.#pickerButtons.length > 0) {
      this.#pickerButtons[0]!.focus();
    }

    // Outside click handler
    this.#outsideClickHandler = (e: MouseEvent) => {
      if (this.#pickerEl && !this.#pickerEl.contains(e.target as Node) &&
          e.target !== anchorEl && !anchorEl.contains(e.target as Node)) {
        this.hide();
      }
    };
    // Use mousedown so click doesn't fire on the anchor after hide
    document.addEventListener('mousedown', this.#outsideClickHandler);

    // Escape key handler + Tab focus trap (M2)
    this.#keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
        this.#anchorEl?.focus();
      } else if (e.key === 'Tab') {
        // M2: Tab focus trap — keep focus inside picker
        const buttons = this.#pickerButtons;
        if (buttons.length === 0) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', this.#keydownHandler);

    // Code MAJOR-2: listen for abort mid-open → hide picker
    if (this.#signal) {
      this.#abortListener = () => this.hide();
      this.#signal.addEventListener('abort', this.#abortListener, { once: true });
    }
  }

  /** Hide the picker without firing onSelect. */
  hide(): void {
    this.#removePicker();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #removePicker(): void {
    if (this.#outsideClickHandler) {
      document.removeEventListener('mousedown', this.#outsideClickHandler);
      this.#outsideClickHandler = null;
    }
    if (this.#keydownHandler) {
      document.removeEventListener('keydown', this.#keydownHandler);
      this.#keydownHandler = null;
    }
    // Code MAJOR-2: remove abort listener to prevent double-hide on signal
    if (this.#abortListener && this.#signal) {
      this.#signal.removeEventListener('abort', this.#abortListener);
      this.#abortListener = null;
    }
    if (this.#pickerEl?.parentNode) {
      this.#pickerEl.parentNode.removeChild(this.#pickerEl);
    }
    this.#pickerEl = null;
    this.#pickerButtons = [];
    this.#mountTo = undefined;
  }

  #buildPicker(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'oxp-reaction-picker';
    el.setAttribute('role', 'dialog');
    // M2: aria-modal=true prevents Tab from escaping dialog (broken dialog pattern fix)
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', t('chooseReactionAria', this.#lang));

    const buttons: HTMLButtonElement[] = [];

    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.className = 'oxp-reaction-picker-button';
      btn.textContent = emoji;
      btn.setAttribute('aria-label', reactionAriaLabel(emoji, this.#lang));
      btn.type = 'button';

      btn.addEventListener('click', () => {
        this.#onSelect(emoji);
        this.hide();
      });

      // Arrow key navigation
      btn.addEventListener('keydown', (e: KeyboardEvent) => {
        const idx = buttons.indexOf(btn);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = buttons[(idx + 1) % buttons.length];
          next?.focus();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = buttons[(idx - 1 + buttons.length) % buttons.length];
          prev?.focus();
        }
      });

      el.appendChild(btn);
      buttons.push(btn);
    }

    // Store buttons array for Tab focus trap in show()
    this.#pickerButtons = buttons;
    return el;
  }

  #position(anchorEl: HTMLElement): void {
    if (!this.#pickerEl) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const isMountedOutside = this.#mountTo !== undefined && this.#mountTo !== this.#container;
    // DM3 (design MAJOR): CSS sets explicit width: 256px on .oxp-reaction-picker so offsetWidth
    // returns a stable non-zero value pre-paint. Fallback 256 guards jsdom (no layout engine)
    // and any edge case where CSS width isn't applied.
    const pickerWidth = this.#pickerEl.offsetWidth || 256;
    const viewportWidth = window.innerWidth;

    if (isMountedOutside) {
      // Mounted outside container (e.g. shadow host) — use viewport coords via position:fixed.
      // getBoundingClientRect() returns viewport-relative coords, which map directly to
      // fixed positioning. This avoids the coordinate mismatch when container has
      // overflow:hidden and the picker is appended to a different ancestor (F2/M5).
      this.#pickerEl.style.position = 'fixed';
      this.#pickerEl.style.top = `${Math.max(8, anchorRect.top - this.#pickerEl.offsetHeight - 8)}px`;
      // 4C: clamp right edge — prevent overflow on narrow viewports (320px)
      const clampedLeft = Math.min(
        Math.max(8, anchorRect.left),
        viewportWidth - pickerWidth - 8,
      );
      this.#pickerEl.style.left = `${clampedLeft}px`;
    } else {
      // Inside container — offset-parent-relative coords via position:absolute.
      const containerRect = this.#container.getBoundingClientRect();
      this.#pickerEl.style.position = 'absolute';
      this.#pickerEl.style.top = `${Math.max(0, anchorRect.top - containerRect.top - this.#pickerEl.offsetHeight - 8)}px`;
      // 4C: clamp right edge relative to container
      const rawLeft = anchorRect.left - containerRect.left;
      const containerWidth = this.#container.offsetWidth || viewportWidth;
      const clampedLeft = Math.min(
        Math.max(0, rawLeft),
        containerWidth - pickerWidth - 8,
      );
      this.#pickerEl.style.left = `${clampedLeft}px`;
    }
    this.#pickerEl.style.zIndex = '10';
  }
}
