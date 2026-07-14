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

    // pointerup + the trailing native click follow immediately in a real
    // gesture (same event tick) — dispatch them right away, matching that,
    // rather than after an artificial delay that would outlive the
    // suppress-click guard window (review fix LOW#9, DEFAULT_SUPPRESS_CLICK_GUARD_MS=300ms).
    button.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 30, clientY: 10 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onOpenBar).not.toHaveBeenCalled();
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

  // ── onOpenBar source (review fix CRITICAL#2, 2026-07-14): the caller
  // needs to know WHICH path opened the bar to decide whether to move
  // focus — a passive mouse hover must not steal focus from wherever the
  // user was (e.g. the composer), while a deliberate hold/ArrowUp should
  // still focus the bar for usability/a11y. ──────────────────────────────

  it('touch_hold_reports_source_hold', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).toHaveBeenCalledWith('hold');
  });

  it('mouse_hover_reports_source_hover', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).toHaveBeenCalledWith('hover');
  });

  it('arrowup_reports_source_keyboard', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));

    expect(onOpenBar).toHaveBeenCalledWith('keyboard');
  });

  // ── Hover-intent suppressed while an input/textarea is focused (review
  // fix CRITICAL#2) — a user typing in the composer whose pointer happens
  // to rest on a heart for 400ms must not have the bar pop open under them. ──

  it('hover_intent_does_not_fire_while_an_input_is_focused', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).not.toHaveBeenCalled();
    input.remove();
  });

  it('hover_intent_does_not_fire_while_a_textarea_is_focused', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).not.toHaveBeenCalled();
    textarea.remove();
  });

  it('hover_intent_fires_normally_when_no_input_is_focused', () => {
    // Sanity/falsification: the guard must not swallow every hover.
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).toHaveBeenCalledWith('hover');
  });

  it('touch_hold_still_fires_while_an_input_is_focused', () => {
    // The focused-input guard is scoped to hover-intent only — a
    // deliberate touch/pen hold is not an accidental pointer-rest and
    // must still open the bar.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);

    expect(onOpenBar).toHaveBeenCalledWith('hold');
    input.remove();
  });

  // ── #suppressNextClick leak guard (review fix LOW#9, 2026-07-14) ─────────
  // A completed/cancelled hold sets the suppress flag expecting a trailing
  // native click to consume it — but if pointerup lands OFF the element
  // (no click ever fires) or activation happens via some other path, the
  // flag used to dangle true forever and would wrongly swallow a later,
  // completely unrelated genuine tap.

  it('a_completed_hold_with_no_trailing_click_does_not_swallow_a_later_genuine_tap', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);
    expect(onOpenBar).toHaveBeenCalledOnce();
    // No 'click' dispatched here — simulates pointerup landing off-element,
    // the real-world case where the browser never fires a trailing click.

    // Let the leak-guard window elapse, then a later, unrelated genuine tap.
    vi.advanceTimersByTime(1000);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('a_movement_cancelled_hold_with_no_trailing_click_does_not_swallow_a_later_genuine_tap', () => {
    new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(200);
    button.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 30, clientY: 10 }));
    // No 'click' dispatched — simulates the drag ending off-element.

    vi.advanceTimersByTime(1000);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('destroy_clears_a_pending_suppress_next_click_guard_timer', () => {
    // Lifecycle discipline (matches the repo's no-leaked-timers convention):
    // the guard-window timer itself must be torn down on destroy(), not
    // just prevented from having an externally-visible effect.
    const trigger = new ReactionTrigger({ element: button, onToggle, onOpenBar });
    button.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(400);
    expect(onOpenBar).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    trigger.destroy();

    expect(vi.getTimerCount()).toBe(0);
  });
});
