/**
 * @oxpulse/chat-widget — ReactionTrigger (reactions quick-bar redesign,
 * heart-first amendment 2026-07-14, reuse-update pass).
 *
 * Wired to a single heart button per bubble:
 *   - Tap/click (no preceding hold) → onToggle() — instant add/remove/
 *     replace-to-heart, handled by the caller.
 *   - Touch/pen: press-and-hold ≥400ms → onOpenBar() — reveals the full
 *     ReactionQuickBar. Movement >10px cancels (scroll wins) and suppresses
 *     the trailing click too (a drag gesture is not a tap). Long-press
 *     timing/gating ported from oxpulse-chat web's
 *     `web/src/lib/chat/list/usePopover.svelte.ts` (LONG_PRESS_MS=400,
 *     POINTER_CANCEL_PX=10, mouse excluded from this path).
 *   - Mouse: no long-press — instead a hover-intent ≥400ms scoped to THIS
 *     button (not the bubble) reveals the bar (TG-desktop pattern). Leaving
 *     before 400ms cancels; once opened there is no auto-hide-on-leave —
 *     ReactionQuickBar owns its own dismissal (Escape/outside-click/select).
 *   - ArrowUp → onOpenBar() (keyboard/SR path to the full bar).
 *   - Enter/Space → native <button> activation behavior fires a 'click'
 *     event; this class only needs a click listener, not a reimplementation
 *     of keyboard activation.
 *
 * Browsers fire a native 'click' on pointerup at the same target regardless
 * of how long the pointer was held — a completed touch/pen hold (onOpenBar
 * already fired) or a cancelled-by-movement hold must suppress that
 * trailing click so the heart doesn't ALSO toggle. Mouse never sets this
 * suppression — its hover-intent and click paths are independent (hover
 * never consumes a click the way a touch/pen long-press does).
 */

/** Which affordance opened the bar — the caller (MessageList) uses this to
 *  decide whether to move focus into the bar (review fix CRITICAL#2,
 *  2026-07-14): 'hover' must NOT steal focus (the user's pointer merely
 *  rested on the button — they could be typing elsewhere), while 'hold'
 *  and 'keyboard' are deliberate actions that should still focus the bar. */
export type ReactionTriggerOpenSource = 'hold' | 'hover' | 'keyboard';

export interface ReactionTriggerOptions {
  /** The heart button — hold/hover/click/ArrowUp target, contextmenu suppression scope. */
  element: HTMLElement;
  /** Called on a plain tap/click (not preceded by a completed or cancelled touch/pen hold). */
  onToggle: () => void;
  /** Called when a ≥400ms touch/pen hold, a ≥400ms mouse hover, or ArrowUp fires. */
  onOpenBar: (source: ReactionTriggerOpenSource) => void;
  /** Optional abort signal — destroys the trigger when it fires. */
  signal?: AbortSignal;
  longPressDelayMs?: number;
  longPressMoveCancelPx?: number;
  hoverDelayMs?: number;
  suppressClickGuardMs?: number;
}

/** Review fix CRITICAL#2: hover-intent must not fire at all while the user
 *  is mid-typing elsewhere (e.g. the composer) — a pointer resting on a
 *  heart for 400ms while they type is incidental, not an open request. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

/** Ported from usePopover.svelte.ts's LONG_PRESS_MS. */
export const DEFAULT_LONG_PRESS_DELAY_MS = 400;
/** Ported from usePopover.svelte.ts's POINTER_CANCEL_PX. */
export const DEFAULT_LONG_PRESS_MOVE_CANCEL_PX = 10;
/** Mouse hover-intent delay — same budget as the touch/pen hold (reuse-update). */
export const DEFAULT_HOVER_DELAY_MS = 400;
/** Review fix LOW#9: #suppressNextClick expects a trailing native click to
 *  consume it. If pointerup lands off-element (no click ever fires) the
 *  flag would otherwise dangle true and wrongly swallow a later, unrelated
 *  genuine tap — this bounds how long the suppression can outlive the
 *  gesture that armed it. Generously short relative to the 400ms
 *  interaction delays; a real click fires within the same event tick as
 *  pointerup, so this only ever fires for the "click never came" case. */
export const DEFAULT_SUPPRESS_CLICK_GUARD_MS = 300;

export class ReactionTrigger {
  #element: HTMLElement;
  #onToggle: () => void;
  #onOpenBar: (source: ReactionTriggerOpenSource) => void;
  #signal: AbortSignal | undefined;
  #longPressDelayMs: number;
  #longPressMoveCancelPx: number;
  #hoverDelayMs: number;
  #suppressClickGuardMs: number;

  #longPressTimer: ReturnType<typeof setTimeout> | null = null;
  #pressStart: { x: number; y: number } | null = null;
  /** Set when a touch/pen hold either opens the bar or is cancelled by
   *  movement — the click that follows pointerup must not also toggle.
   *  Mouse never sets this (see class doc comment). Always armed via
   *  #armSuppressNextClick (review fix LOW#9) — never set bare, so the
   *  guard-window timer is never forgotten. */
  #suppressNextClick = false;
  #suppressNextClickTimer: ReturnType<typeof setTimeout> | null = null;
  #hoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ReactionTriggerOptions) {
    this.#element = opts.element;
    this.#onToggle = opts.onToggle;
    this.#onOpenBar = opts.onOpenBar;
    this.#signal = opts.signal;
    this.#longPressDelayMs = opts.longPressDelayMs ?? DEFAULT_LONG_PRESS_DELAY_MS;
    this.#longPressMoveCancelPx = opts.longPressMoveCancelPx ?? DEFAULT_LONG_PRESS_MOVE_CANCEL_PX;
    this.#hoverDelayMs = opts.hoverDelayMs ?? DEFAULT_HOVER_DELAY_MS;
    this.#suppressClickGuardMs = opts.suppressClickGuardMs ?? DEFAULT_SUPPRESS_CLICK_GUARD_MS;

    this.#element.addEventListener('pointerdown', this.#onPointerDown);
    this.#element.addEventListener('pointermove', this.#onPointerMove);
    this.#element.addEventListener('pointerup', this.#onPointerUp);
    this.#element.addEventListener('pointercancel', this.#onPointerCancel);
    this.#element.addEventListener('pointerenter', this.#onPointerEnter);
    this.#element.addEventListener('pointerleave', this.#onPointerLeave);
    this.#element.addEventListener('click', this.#onClick);
    this.#element.addEventListener('keydown', this.#onKeydown);

    if (this.#signal) {
      if (this.#signal.aborted) {
        this.destroy();
      } else {
        this.#signal.addEventListener('abort', this.#onAbort, { once: true });
      }
    }
  }

  /** Tear down all listeners and clear any pending timer. Idempotent. */
  destroy(): void {
    this.#clearLongPressTimer();
    this.#clearHoverTimer();
    this.#clearSuppressNextClickTimer();
    this.#endPress();

    this.#element.removeEventListener('pointerdown', this.#onPointerDown);
    this.#element.removeEventListener('pointermove', this.#onPointerMove);
    this.#element.removeEventListener('pointerup', this.#onPointerUp);
    this.#element.removeEventListener('pointercancel', this.#onPointerCancel);
    this.#element.removeEventListener('pointerenter', this.#onPointerEnter);
    this.#element.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#element.removeEventListener('click', this.#onClick);
    this.#element.removeEventListener('keydown', this.#onKeydown);
    if (this.#signal) {
      this.#signal.removeEventListener('abort', this.#onAbort);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #onAbort = (): void => {
    this.destroy();
  };

  #onPointerDown = (e: Event): void => {
    const pe = e as PointerEvent;
    // Ported gate from usePopover.svelte.ts#handlePointerDown: "Only
    // register long-press for touch + pen. Mouse uses [hover-intent]."
    if (pe.pointerType === 'mouse') return;
    this.#pressStart = { x: pe.clientX, y: pe.clientY };
    this.#element.addEventListener('contextmenu', this.#onContextMenu);
    this.#clearLongPressTimer();
    this.#longPressTimer = setTimeout(() => {
      this.#longPressTimer = null;
      this.#armSuppressNextClick();
      this.#onOpenBar('hold');
    }, this.#longPressDelayMs);
  };

  #onPointerMove = (e: Event): void => {
    if (!this.#pressStart) return;
    const pe = e as PointerEvent;
    const dx = pe.clientX - this.#pressStart.x;
    const dy = pe.clientY - this.#pressStart.y;
    // Squared-distance compare (ported from usePopover.svelte.ts#handlePointerMove) — avoids sqrt.
    if (dx * dx + dy * dy > this.#longPressMoveCancelPx * this.#longPressMoveCancelPx) {
      // Scroll/drag wins — cancel the pending hold. Already-fired holds
      // (timer consumed) leave #longPressTimer null, so this is a no-op
      // for the "moved after the bar already opened" case.
      const wasPending = this.#longPressTimer !== null;
      this.#clearLongPressTimer();
      if (wasPending) this.#armSuppressNextClick();
      this.#pressStart = null;
      this.#element.removeEventListener('contextmenu', this.#onContextMenu);
    }
  };

  #onPointerUp = (): void => {
    this.#endPress();
  };

  #onPointerCancel = (): void => {
    this.#endPress();
  };

  #onPointerEnter = (e: Event): void => {
    const pe = e as PointerEvent;
    if (pe.pointerType !== 'mouse') return;
    this.#clearHoverTimer();
    this.#hoverTimer = setTimeout(() => {
      this.#hoverTimer = null;
      // Review fix CRITICAL#2: skip entirely if the user is mid-typing
      // elsewhere — a pointer resting on the heart while they type in the
      // composer is incidental, not an open request.
      if (isTypingTarget(document.activeElement)) return;
      this.#onOpenBar('hover');
    }, this.#hoverDelayMs);
  };

  #onPointerLeave = (e: Event): void => {
    const pe = e as PointerEvent;
    if (pe.pointerType !== 'mouse') return;
    // No auto-hide-on-leave once the bar has already opened — only cancel
    // a still-pending (not-yet-fired) hover-intent.
    this.#clearHoverTimer();
  };

  #onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  #onClick = (e: Event): void => {
    if (this.#suppressNextClick) {
      this.#suppressNextClick = false;
      this.#clearSuppressNextClickTimer();
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    this.#onToggle();
  };

  #onKeydown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'ArrowUp') {
      ke.preventDefault();
      this.#onOpenBar('keyboard');
    }
  };

  #endPress(): void {
    this.#clearLongPressTimer();
    this.#pressStart = null;
    this.#element.removeEventListener('contextmenu', this.#onContextMenu);
  }

  #clearLongPressTimer(): void {
    if (this.#longPressTimer !== null) {
      clearTimeout(this.#longPressTimer);
      this.#longPressTimer = null;
    }
  }

  #clearHoverTimer(): void {
    if (this.#hoverTimer !== null) {
      clearTimeout(this.#hoverTimer);
      this.#hoverTimer = null;
    }
  }

  /** Review fix LOW#9: arm the suppress flag AND a guard-window timer that
   *  auto-clears it if the expected trailing click never arrives (pointerup
   *  landed off-element, or activation happened via some other path) — a
   *  later, unrelated genuine tap must never be silently swallowed. */
  #armSuppressNextClick(): void {
    this.#suppressNextClick = true;
    this.#clearSuppressNextClickTimer();
    this.#suppressNextClickTimer = setTimeout(() => {
      this.#suppressNextClickTimer = null;
      this.#suppressNextClick = false;
    }, this.#suppressClickGuardMs);
  }

  #clearSuppressNextClickTimer(): void {
    if (this.#suppressNextClickTimer !== null) {
      clearTimeout(this.#suppressNextClickTimer);
      this.#suppressNextClickTimer = null;
    }
  }
}
