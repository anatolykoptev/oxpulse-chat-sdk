/**
 * @oxpulse/chat-widget — ReactionQuickBar (reactions quick-bar redesign,
 * heart-first amendment 2026-07-14). Renamed from ReactionPicker (W2.2
 * slice 3) — same floating-popover mechanics, now reached by holding the
 * per-bubble heart button (≥400ms touch/pen hold, ≥400ms mouse hover-intent)
 * or pressing ArrowUp on it, instead of a click-triggered two-step flow (see
 * ui/reaction-trigger.ts and MessageList's wiring).
 *
 * Plain TS class, no framework. Renders emoji buttons inside the container,
 * handles keyboard navigation, outside click, and AbortSignal.
 */

import { REACTION_EMOJIS, reactionAriaLabel } from '../utils/reaction-types.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import { computeQuickBarPosition } from '../utils/reaction-quick-bar-position.js';

// ── Constructor options ───────────────────────────────────────────────────────

export interface ReactionQuickBarOptions {
  /** Container element to render the bar inside. */
  container: HTMLElement;
  /** Called when the user selects an emoji. */
  onSelect: (emoji: string) => void;
  /** Optional abort signal — when aborted, show() becomes a no-op. */
  signal?: AbortSignal;
  /** BCP-47 tag or an already-resolved Locale. Optional — defaults via resolveLocale(). */
  lang?: string;
  /** The caller's current own reaction on this message, if any (spec 2026-07-14).
   *  Marks the matching button aria-pressed=true + an accent ring so the bar
   *  reflects existing state, not just a blank picker. */
  ownEmoji?: string;
  /** Whether the message this bar is attached to is the caller's own
   *  (reuse-update 2026-07-14) — drives right-edge vs left-edge anchoring
   *  via computeQuickBarPosition, ported from oxpulse-chat web's
   *  computePopoverPosition. Default false. */
  isOwnMessage?: boolean;
  /** Called whenever the bar closes ITSELF — Escape, outside-pointerdown,
   *  or an explicit hide()/re-show() (review fix HIGH#4, 2026-07-14).
   *  Without this, a caller that tracks "which message currently owns the
   *  bar" (MessageList's #quickBar/#quickBarMsgId) has no way to learn the
   *  bar closed on its own — its state goes stale and an idempotent-reshow
   *  guard keyed on that state blocks reopening the SAME message forever.
   *  NOT called for a redundant hide() on an already-closed bar. */
  onHide?: () => void;
}

/** MOTION (spec 2026-07-14): select fires a burst/scale-pop on the chosen
 *  button before the bar dismisses — this is the visual budget for that pop
 *  to play before DOM removal. Reduced-motion is handled entirely in CSS
 *  (the keyframe is zeroed under `prefers-reduced-motion: reduce`); this
 *  fixed short delay is imperceptible either way and keeps onSelect's
 *  business-logic side effect synchronous regardless of motion preference. */
export const SELECT_DISMISS_DELAY_MS = 160;

// ── ReactionQuickBar ──────────────────────────────────────────────────────────

/**
 * ReactionQuickBar renders a floating emoji quick-select bar.
 *
 * Lifecycle:
 *   show(anchorEl) — appends bar to container, positions it, focuses first emoji
 *   hide()         — removes from DOM, restores focus to anchor
 *
 * A11y:
 *   role="dialog", first emoji focused on open, Arrow keys navigate,
 *   Escape hides + restores focus to anchor (deferred to a microtask),
 *   outside capture-phase pointerdown hides.
 */
export class ReactionQuickBar {
  #container: HTMLElement;
  #onSelect: (emoji: string) => void;
  #onHide: (() => void) | undefined;
  #signal: AbortSignal | undefined;
  #lang: Locale;
  #ownEmoji: string | undefined;
  #isOwnMessage: boolean;
  /** Pending select-burst dismiss timer — cleared on hide() so a select
   *  followed immediately by an unrelated hide (e.g. outside click racing
   *  the burst window) never double-fires the removal. */
  #dismissTimer: ReturnType<typeof setTimeout> | null = null;
  #barEl: HTMLElement | null = null;
  #anchorEl: HTMLElement | null = null;
  /** Element Escape restores focus to — defaults to anchorEl when omitted.
   *  Kept distinct from anchorEl because the positioning anchor (the bubble)
   *  is not always the right focus-restore target (e.g. a visually-hidden
   *  keyboard trigger button anchored to the same bubble). */
  #restoreFocusEl: HTMLElement | null = null;
  #outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  #keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Code MAJOR-2: abort listener to hide bar when signal fires mid-open. */
  #abortListener: (() => void) | null = null;
  /** Buttons inside the bar — stored for Tab focus trap. */
  #barButtons: HTMLButtonElement[] = [];
  /** Track where the bar was mounted to determine positioning strategy. */
  #mountTo: HTMLElement | undefined = undefined;

  constructor(opts: ReactionQuickBarOptions) {
    this.#container = opts.container;
    this.#onSelect = opts.onSelect;
    this.#onHide = opts.onHide;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
    this.#ownEmoji = opts.ownEmoji;
    this.#isOwnMessage = opts.isOwnMessage ?? false;
  }

  /**
   * Show the bar anchored to the given element.
   *
   * @param anchorEl  — element to anchor position to
   * @param mountTo   — element to append the bar to (default: constructor container).
   *                    Pass the ShadowRoot host element to escape overflow:hidden clip contexts.
   *                    F3 (design MAJOR-5): container has overflow:hidden which clips absolute children.
   * @param restoreFocusEl — element Escape restores focus to. Defaults to anchorEl.
   *                    Pass the heart button (anchorEl is the bubble, which is
   *                    not itself focusable).
   * @param focusFirstButton — whether to move focus into the bar on open.
   *                    Default true. Pass false for a passively-opened bar
   *                    (review fix CRITICAL#2, 2026-07-14: a mouse
   *                    hover-intent open must not steal focus from wherever
   *                    the user was, e.g. mid-typing in the composer) —
   *                    a deliberate hold/keyboard open should still focus it.
   */
  show(anchorEl: HTMLElement, mountTo?: HTMLElement, restoreFocusEl?: HTMLElement, focusFirstButton = true): void {
    if (this.#signal?.aborted) return;
    // If already visible, hide first
    if (this.#barEl) this.#removeBar();

    this.#anchorEl = anchorEl;
    this.#restoreFocusEl = restoreFocusEl ?? anchorEl;
    this.#mountTo = mountTo;
    this.#barEl = this.#buildBar();
    const appendTarget = mountTo ?? this.#container;
    appendTarget.appendChild(this.#barEl);

    // Position: above anchor if room, below otherwise
    this.#position(anchorEl);

    // Focus first button — skipped for a passively-opened (hover) bar.
    if (focusFirstButton && this.#barButtons.length > 0) {
      this.#barButtons[0]!.focus();
    }

    // Outside dismissal handler — reuse-update (2026-07-14): capture-phase
    // pointerdown (ported pattern from web's MessageActions.svelte), not
    // bubble-phase mousedown. Capture-phase listeners run on the way DOWN
    // the tree, before any bubble-phase handler between the click target
    // and document gets a chance to stopPropagation() and swallow the
    // event — the prior bubble-phase mousedown listener could be defeated
    // by exactly that.
    this.#outsideClickHandler = (e: MouseEvent) => {
      if (this.#barEl && !this.#barEl.contains(e.target as Node) &&
          e.target !== anchorEl && !anchorEl.contains(e.target as Node)) {
        this.hide();
      }
    };
    document.addEventListener('pointerdown', this.#outsideClickHandler, true);

    // Escape key handler + Tab focus trap (M2)
    this.#keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // P2 design-review fix (starthey demo, 2026-07-14): stop the event
        // from reaching window — a host page's own global Escape listener
        // (e.g. the starthey demo unmounts the whole chat on window keydown
        // Escape) must not act on an Escape the user meant only to close
        // this bar with. This listener is document-level and only lives
        // while the bar is open (added in show(), removed in #removeBar()),
        // so a closed bar never swallows Escape for the host.
        e.stopPropagation();
        // Capture before hide() — #removeBar() clears #restoreFocusEl.
        const restoreFocusEl = this.#restoreFocusEl;
        this.hide();
        // Reuse-update (2026-07-14): defer focus restore to a microtask
        // (ported from web's MessageActions.svelte) — hide() has just
        // removed the focused button from the DOM; queueMicrotask lets
        // that removal (and any synchronous focus reset the UA performs)
        // settle before we claim the restore target.
        queueMicrotask(() => restoreFocusEl?.focus());
      } else if (e.key === 'Tab') {
        // M2: Tab focus trap — keep focus inside the bar
        const buttons = this.#barButtons;
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

    // Code MAJOR-2: listen for abort mid-open → hide bar
    if (this.#signal) {
      this.#abortListener = () => this.hide();
      this.#signal.addEventListener('abort', this.#abortListener, { once: true });
    }
  }

  /** Hide the bar without firing onSelect. */
  hide(): void {
    this.#removeBar();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #removeBar(): void {
    // Review fix HIGH#4: only notify the caller if there was actually a bar
    // to remove — hide() calls this unconditionally, so a redundant hide()
    // on an already-closed bar must not double-fire onHide.
    const wasOpen = this.#barEl !== null;
    if (this.#dismissTimer !== null) {
      clearTimeout(this.#dismissTimer);
      this.#dismissTimer = null;
    }
    if (this.#outsideClickHandler) {
      document.removeEventListener('pointerdown', this.#outsideClickHandler, true);
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
    if (this.#barEl?.parentNode) {
      this.#barEl.parentNode.removeChild(this.#barEl);
    }
    this.#barEl = null;
    this.#barButtons = [];
    this.#mountTo = undefined;
    this.#anchorEl = null;
    this.#restoreFocusEl = null;
    if (wasOpen) this.#onHide?.();
  }

  #buildBar(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'oxp-reaction-quick-bar';
    el.setAttribute('role', 'dialog');
    // M2: aria-modal=true prevents Tab from escaping dialog (broken dialog pattern fix)
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', t('chooseReactionAria', this.#lang));

    const buttons: HTMLButtonElement[] = [];

    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      const isOwn = emoji === this.#ownEmoji;
      btn.className = isOwn
        ? 'oxp-reaction-quick-bar-button oxp-reaction-quick-bar-button--own'
        : 'oxp-reaction-quick-bar-button';
      btn.textContent = emoji;
      btn.setAttribute('aria-label', reactionAriaLabel(emoji, this.#lang));
      btn.setAttribute('aria-pressed', String(isOwn));
      btn.type = 'button';

      btn.addEventListener('click', () => {
        // MOTION: burst/scale-pop on the chosen button, then dismiss.
        // onSelect fires synchronously — the visual delay never blocks the
        // business-logic side effect (add/remove/replace).
        btn.classList.add('oxp-reaction-quick-bar-button--burst');
        this.#onSelect(emoji);
        this.#dismissTimer = setTimeout(() => {
          this.#dismissTimer = null;
          this.hide();
        }, SELECT_DISMISS_DELAY_MS);
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
    this.#barButtons = buttons;
    return el;
  }

  /**
   * Placement (above/below flip) and left-vs-right anchor SIDE are decided by
   * computeQuickBarPosition (reuse-update 2026-07-14, ported from
   * oxpulse-chat web's computePopoverPosition). The actual pixel math —
   * fixed-vs-absolute coordinate frame switch and the left/right-edge
   * viewport-width clamp — stays this file's own pre-existing logic (F2/4C/
   * DM3); web has no shadow-DOM coordinate-frame split or narrow-viewport
   * clamp equivalent to port.
   */
  #position(anchorEl: HTMLElement): void {
    if (!this.#barEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const isMountedOutside = this.#mountTo !== undefined && this.#mountTo !== this.#container;
    // DM3 (design MAJOR): CSS sets explicit width: 256px on .oxp-reaction-quick-bar so offsetWidth
    // returns a stable non-zero value pre-paint. Fallback 256 guards jsdom (no layout engine)
    // and any edge case where CSS width isn't applied.
    const barWidth = this.#barEl.offsetWidth || 256;
    const barHeight = this.#barEl.offsetHeight;
    const viewportWidth = window.innerWidth;

    if (isMountedOutside) {
      // Mounted outside container (e.g. shadow host) — use viewport coords via position:fixed.
      // getBoundingClientRect() returns viewport-relative coords, which map directly to
      // fixed positioning. This avoids the coordinate mismatch when container has
      // overflow:hidden and the bar is appended to a different ancestor (F2/M5).
      this.#barEl.style.position = 'fixed';
      const pos = computeQuickBarPosition({
        anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        barHeight,
        viewportTop: 0,
        isOwn: this.#isOwnMessage,
      });
      this.#applyPlacementClass(pos.placement);
      this.#barEl.style.top = `${Math.max(8, pos.top)}px`;
      if (pos.right !== undefined) {
        // Own message — anchor by right edge (CSS `right` is measured from
        // the containing block's right edge, so convert).
        const cssRight = viewportWidth - pos.right;
        const clampedRight = Math.min(Math.max(8, cssRight), viewportWidth - barWidth - 8);
        this.#barEl.style.right = `${clampedRight}px`;
      } else {
        // 4C: clamp right edge — prevent overflow on narrow viewports (320px)
        const clampedLeft = Math.min(Math.max(8, pos.left ?? rect.left), viewportWidth - barWidth - 8);
        this.#barEl.style.left = `${clampedLeft}px`;
      }
    } else {
      // Inside container — offset-parent-relative coords via position:absolute.
      const containerRect = this.#container.getBoundingClientRect();
      this.#barEl.style.position = 'absolute';
      const anchorRect = {
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top,
        left: rect.left - containerRect.left,
        right: rect.right - containerRect.left,
      };
      const pos = computeQuickBarPosition({
        anchorRect,
        barHeight,
        viewportTop: 0,
        isOwn: this.#isOwnMessage,
      });
      this.#applyPlacementClass(pos.placement);
      this.#barEl.style.top = `${Math.max(0, pos.top)}px`;
      const containerWidth = this.#container.offsetWidth || viewportWidth;
      if (pos.right !== undefined) {
        const cssRight = containerWidth - pos.right;
        const clampedRight = Math.min(Math.max(0, cssRight), containerWidth - barWidth - 8);
        this.#barEl.style.right = `${clampedRight}px`;
      } else {
        // 4C: clamp right edge relative to container
        const clampedLeft = Math.min(Math.max(0, pos.left ?? anchorRect.left), containerWidth - barWidth - 8);
        this.#barEl.style.left = `${clampedLeft}px`;
      }
    }
    this.#barEl.style.zIndex = '10';
  }

  /** Review fix LOW#12: consume computeQuickBarPosition's placement — a
   *  class rather than a discarded field — so CSS can key direction-aware
   *  entrance motion off it later without another positioning pass. */
  #applyPlacementClass(placement: 'above' | 'below'): void {
    if (!this.#barEl) return;
    this.#barEl.classList.toggle('oxp-reaction-quick-bar--above', placement === 'above');
    this.#barEl.classList.toggle('oxp-reaction-quick-bar--below', placement === 'below');
  }
}
