/**
 * reaction-trigger.test.ts — TDD RED phase (reactions quick-bar redesign,
 * heart-first amendment 2026-07-14, reuse-update pass).
 *
 * Tests: ReactionTrigger — wired to a single heart button.
 *   - tap/click (no preceding hold) → onToggle()
 *   - touch/pen: press-and-hold ≥400ms → onOpenBar(); movement >10px cancels;
 *     the trailing click after a completed/cancelled hold is suppressed.
 *     Long-press timing/gating ported from oxpulse-chat web's
 *     usePopover.svelte.ts (LONG_PRESS_MS=400, POINTER_CANCEL_PX=10,
 *     `pointerType === 'mouse'` excluded from the long-press path).
 *   - mouse: NO long-press — instead hover-intent ≥400ms on the heart
 *     button itself → onOpenBar() (TG-desktop pattern, scoped to the
 *     button, not the bubble). Leaving before 400ms cancels; no
 *     auto-hide-on-leave once opened (the bar owns its own dismissal).
 *   - ArrowUp key → onOpenBar()
 *   - Enter/Space → native button activation ends up as a 'click' event;
 *     tested by dispatching 'click' directly (jsdom's own keyboard→click
 *     synthesis is not this class's concern)
 *   - destroy() clears all timers/listeners
 *
 * Pointer events are dispatched as MouseEvent with an explicit `pointerType`
 * property (jsdom has no native PointerEvent constructor) — the browser
 * dispatches real PointerEvents at runtime; tests only need the event
 * *type* string to match what addEventListener('pointerdown', ...) etc.
 * listen for, which jsdom honors regardless of the constructor used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReactionTrigger } from '../ui/reaction-trigger.js';

function pointerEvent(
  type: string,
  props: { pointerType?: string; clientX?: number; clientY?: number } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX ?? 0,
    clientY: props.clientY ?? 0,
  });
  Object.defineProperty(ev, 'pointerType', { value: props.pointerType ?? 'mouse', configurable: true });
  return ev;
}

describe('ReactionTrigger', () => {
  let button: HTMLButtonElement;
  let onToggle: ReturnType<typeof vi.fn>;
  let onOpenBar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    button = document.createElement('button');
    document.body.appendChild(button);
    onToggle = vi.fn();
    onOpenBar = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (button.parentNode) button.parentNode.removeChild(button);
  });

  it('plain_click_with_no_preceding_pointer_sequence_toggles', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('quick_tap_touch_toggles_and_does_not_open_the_bar', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(100);
    button.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('mouse_pointerdown_does_not_start_any_hold_timer', () => {
    // Ported gate from usePopover.svelte.ts: pointerType==='mouse' is
    // excluded from the long-press path entirely — mouse uses hover-intent
    // instead (separate test below).
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(1000);

    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('touch_hold_400ms_opens_the_bar', () => {
    // LONG_PRESS_MS=400 ported from usePopover.svelte.ts.
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));

    vi.advanceTimersByTime(399);
    expect(onOpenBar).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onOpenBar).toHaveBeenCalledOnce();
  });

  it('pen_hold_400ms_opens_the_bar', () => {
    // usePopover.svelte.ts: "Only register long-press for touch + pen."
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'pen', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).toHaveBeenCalledOnce();
  });

  it('the_trailing_click_after_a_completed_touch_hold_does_not_also_toggle', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);
    expect(onOpenBar).toHaveBeenCalledOnce();

    button.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    // Browsers fire a native 'click' on pointerup at the same target regardless
    // of hold duration — must be suppressed so opening the bar doesn't ALSO
    // toggle the heart.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('movement_over_10px_cancels_the_touch_hold_and_suppresses_the_trailing_click', () => {
    // POINTER_CANCEL_PX=10 ported from usePopover.svelte.ts.
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 30, clientY: 10 }));
    vi.advanceTimersByTime(1000);

    expect(onOpenBar).not.toHaveBeenCalled();

    button.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 30, clientY: 10 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('movement_under_10px_does_not_cancel_the_touch_hold', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 15, clientY: 10 }));
    vi.advanceTimersByTime(200);

    expect(onOpenBar).toHaveBeenCalledOnce();
  });

  it('pointercancel_before_400ms_cancels_the_touch_hold', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointercancel', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(1000);

    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('touch_hold_suppresses_contextmenu_only_while_pressing', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));

    const midPressMenu = new Event('contextmenu', { bubbles: true, cancelable: true });
    button.dispatchEvent(midPressMenu);
    expect(midPressMenu.defaultPrevented).toBe(true);

    button.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 10, clientY: 10 }));

    const afterPressMenu = new Event('contextmenu', { bubbles: true, cancelable: true });
    button.dispatchEvent(afterPressMenu);
    expect(afterPressMenu.defaultPrevented).toBe(false);
  });

  // ── Mouse hover-intent (reuse-update: scoped to the button, not the bubble) ──

  it('mouse_hover_400ms_on_the_button_opens_the_bar', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));

    vi.advanceTimersByTime(399);
    expect(onOpenBar).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onOpenBar).toHaveBeenCalledOnce();
  });

  it('mouse_leaving_before_400ms_never_opens_the_bar', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointerleave', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(1000);

    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('touch_pointerenter_does_not_start_hover_intent', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'touch' }));
    vi.advanceTimersByTime(1000);

    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('a_deliberate_click_during_an_unfired_mouse_hover_still_toggles', () => {
    // Hover and click are independent for mouse — no suppression, unlike
    // the touch/pen hold-then-click case (mouse never sets pressStart).
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(100);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  // ── Keyboard ───────────────────────────────────────────────────────────────

  it('arrowup_opens_the_bar', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    button.dispatchEvent(ev);

    expect(onOpenBar).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('enter_or_space_activation_ends_up_toggling_via_the_native_click', () => {
    // Native <button> activation behavior turns Enter/Space into a real
    // 'click' event — this class only needs to handle that click, not
    // reimplement keyboard activation.
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it('destroy_clears_pending_hold_timer_and_listeners', () => {
    const trigger = new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    trigger.destroy();

    vi.advanceTimersByTime(1000);
    expect(onOpenBar).not.toHaveBeenCalled();

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();

    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it('destroy_clears_a_pending_mouse_hover_timer', () => {
    const trigger = new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    trigger.destroy();

    vi.advanceTimersByTime(1000);
    expect(onOpenBar).not.toHaveBeenCalled();
  });

  it('abort_signal_destroys_the_trigger', () => {
    const ctrl = new AbortController();
    new ReactionTrigger({ element: button, onToggle, onOpenBar, signal: ctrl.signal });
    ctrl.abort();

    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(1000);
    expect(onOpenBar).not.toHaveBeenCalled();

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
