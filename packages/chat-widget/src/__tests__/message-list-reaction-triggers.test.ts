/**
 * message-list-reaction-triggers.test.ts — TDD RED phase (reactions
 * quick-bar redesign, heart-first amendment 2026-07-14).
 *
 * Tests: MessageList wires a ReactionTrigger to each bubble's heart button —
 * tap/click instantly toggles the heart reaction (add/remove/replace via
 * #selectReaction), a ≥400ms touch/pen hold, a ≥400ms mouse hover-intent, or
 * ArrowUp opens the full ReactionQuickBar, movement >10px cancels a hold.
 * Gated behind reactionsEnabled + client.sendReaction. Trigger
 * listeners/timers are torn down on destroy() and on eviction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList, MAX_LIVE_MESSAGES_HARD_CEILING } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';

function makeRow(overrides: Partial<MessageRow> & { senderUid: string }): MessageRow {
  return {
    seq: 1,
    msgId: crypto.randomUUID(),
    senderUid: overrides.senderUid,
    sealed: new ArrayBuffer(0),
    plaintext: new TextEncoder().encode(overrides.text ?? 'hello'),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    ...overrides,
  };
}

function drainMicrotasks(n = 10): Promise<void> {
  return Array.from({ length: n }).reduce(
    (p) => (p as Promise<void>).then(() => Promise.resolve()),
    Promise.resolve(),
  ) as Promise<void>;
}

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

interface ReactionsResponse {
  counts: Record<string, number>;
  users: Record<string, string[]>;
  truncated: boolean;
}

function makeMockClient(
  rows: MessageRow[] = [],
  reactions: Record<string, ReactionsResponse> = {},
): MessageListClient {
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    getReactions: vi.fn().mockImplementation(
      (_roomId: string, msgId: string) =>
        Promise.resolve(reactions[msgId] ?? { counts: {}, users: {}, truncated: false }),
    ),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };
}

describe('MessageList — reaction quick-bar triggers (heart-first)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('tapping_the_heart_button_calls_sendReaction_with_the_heart_emoji', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-1', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn).not.toBeNull();
    heartBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(client.sendReaction).toHaveBeenCalledWith('r1', 'msg-1', '❤️');
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
    ml.destroy();
  });

  it('tapping_own_heart_calls_removeReaction', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-2', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-2': { counts: { '❤️': 1 }, users: { '❤️': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('aria-pressed')).toBe('true');
    heartBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(client.removeReaction).toHaveBeenCalledWith('r1', 'msg-2', '❤️');
    ml.destroy();
  });

  it('tapping_heart_while_owning_a_different_emoji_replaces_it', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-3', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-3': { counts: { '👍': 1 }, users: { '👍': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('aria-pressed')).toBe('false');
    heartBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(client.removeReaction).toHaveBeenCalledWith('r1', 'msg-3', '👍');
    expect(client.sendReaction).toHaveBeenCalledWith('r1', 'msg-3', '❤️');
    ml.destroy();
  });

  // ── Heart-add pulse animation (reuse-update 2026-07-14, ported from
  // web's Bubble.svelte .qa-heart.on.pulse / triggerHeartPulse) ───────────

  it('adding_the_heart_reaction_pulses_the_button_then_clears_after_240ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-pulse-1', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(heartBtn.classList.contains('oxp-reaction-heart-btn--pulse')).toBe(true);

    await vi.advanceTimersByTimeAsync(240);
    expect(heartBtn.classList.contains('oxp-reaction-heart-btn--pulse')).toBe(false);
    ml.destroy();
  });

  it('removing_the_heart_reaction_does_not_pulse', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-pulse-2', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-pulse-2': { counts: { '❤️': 1 }, users: { '❤️': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(heartBtn.classList.contains('oxp-reaction-heart-btn--pulse')).toBe(false);
    ml.destroy();
  });

  it('replacing_a_different_emoji_with_heart_pulses_the_button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-pulse-3', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-pulse-3': { counts: { '👍': 1 }, users: { '👍': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(heartBtn.classList.contains('oxp-reaction-heart-btn--pulse')).toBe(true);
    ml.destroy();
  });

  it('replacing_to_heart_does_not_pulse_when_the_client_cannot_removeReaction', async () => {
    // Review fix LOW#10: #optimisticReplaceReaction silently no-ops without
    // client.removeReaction (its own internal capability gate) — the pulse
    // must respect the SAME gate, not fire regardless.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-pulse-4', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-pulse-4': { counts: { '👍': 1 }, users: { '👍': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    // removeReaction deliberately capability-less — sendReaction stays (so
    // the heart button still renders; the gate is #populateBubble's own).
    delete (client as { removeReaction?: unknown }).removeReaction;

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(heartBtn.classList.contains('oxp-reaction-heart-btn--pulse')).toBe(false);
    expect(client.sendReaction).not.toHaveBeenCalled();
    ml.destroy();
  });

  it('mouse_hover_400ms_on_the_heart_button_opens_the_quick_bar', async () => {
    // Reuse-update (2026-07-14): mouse gets hover-intent, not long-press —
    // scoped to the heart button itself (TG-desktop pattern), not the bubble.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-4', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(400);

    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();
    ml.destroy();
  });

  it('hover_opening_the_bar_does_not_steal_focus_from_a_focused_input', async () => {
    // Review fix CRITICAL#2 (2026-07-14): a user typing in the composer
    // (or any other input) whose pointer happens to rest on a heart for
    // 400ms must not have focus ripped out from under them.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-4c', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const composer = document.createElement('input');
    container.appendChild(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(400);

    // The hover-intent guard (reaction-trigger.ts) suppresses the open
    // entirely while an input is focused — the bar never appears AND
    // focus stays put either way this is enforced.
    expect(document.activeElement).toBe(composer);

    composer.remove();
    ml.destroy();
  });

  it('hover_open_bar_does_not_focus_its_buttons_even_when_nothing_else_is_focused', async () => {
    // Distinct from the input-guard test above: this proves the SEPARATE
    // focusFirstButton=false wiring (source==='hover') independent of the
    // typing-target guard — hover opens the bar here (no input focused),
    // but must still not move focus into it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-4d', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const activeBeforeHover = document.activeElement;
    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(400);

    const bar = container.querySelector('.oxp-reaction-quick-bar');
    expect(bar).not.toBeNull();
    expect(bar!.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(activeBeforeHover);
    ml.destroy();
  });

  it('mouse_pointerdown_on_the_heart_button_never_opens_the_bar', async () => {
    // Ported gate (usePopover.svelte.ts): mouse is excluded from the
    // press-and-hold path entirely — a mouse hold via pointerdown alone
    // (no hover) must never open the bar.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-4b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
    ml.destroy();
  });

  it('touch_hold_400ms_on_the_heart_button_opens_the_quick_bar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-5', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(400);

    const bar = container.querySelector('.oxp-reaction-quick-bar');
    expect(bar).not.toBeNull();
    // Unlike a hover-open, a deliberate hold still focuses the bar.
    expect(bar!.contains(document.activeElement)).toBe(true);
    ml.destroy();
  });

  it('a_completed_touch_hold_does_not_also_toggle_the_heart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-5b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(400);
    heartBtn.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);

    expect(client.sendReaction).not.toHaveBeenCalled();
    ml.destroy();
  });

  it('movement_over_10px_cancels_a_touch_hold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-6', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(100);
    heartBtn.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 30, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
    ml.destroy();
  });

  it('mouse_leaving_the_heart_button_before_400ms_cancels_the_hover_intent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-6b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(200);
    heartBtn.dispatchEvent(pointerEvent('pointerleave', { pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
    ml.destroy();
  });

  it('arrowup_on_the_heart_button_opens_the_quick_bar', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-7', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();
    ml.destroy();
  });

  it('bar_anchors_by_the_right_edge_for_the_callers_own_message', async () => {
    // Reuse-update (2026-07-14): own-message bars anchor by right edge via
    // computeQuickBarPosition, threaded from MessageList through isOwnMessage.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-own', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    const bar = container.querySelector('.oxp-reaction-quick-bar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.style.right).not.toBe('');
    expect(bar!.style.left).toBe('');
    ml.destroy();
  });

  it('bar_anchors_by_the_left_edge_for_another_writers_message', async () => {
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-other', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    const bar = container.querySelector('.oxp-reaction-quick-bar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.style.left).not.toBe('');
    expect(bar!.style.right).toBe('');
    ml.destroy();
  });

  it('escape_hides_the_bar_and_restores_focus_to_the_heart_button', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-7b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);
    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await drainMicrotasks(5);

    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
    expect(document.activeElement).toBe(heartBtn);
    ml.destroy();
  });

  it('bar_reopens_on_the_same_message_after_escape', async () => {
    // Review fix HIGH#4: without onHide wiring, #quickBarMsgId went stale
    // after Escape and #showQuickBar's idempotent-reshow guard blocked
    // reopening the SAME message's bar forever.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-7c', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);
    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await drainMicrotasks(5);
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();

    // Reopen the SAME heart's bar via ArrowUp again.
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();
    ml.destroy();
  });

  it('bar_reopens_on_the_same_message_after_outside_click', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-7d', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);
    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await drainMicrotasks(5);
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();

    // Reopen the SAME heart's bar via ArrowUp again.
    heartBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    expect(container.querySelector('.oxp-reaction-quick-bar')).not.toBeNull();
    ml.destroy();
  });

  it('heart_button_has_the_addReactionAria_label_and_arrowup_keyshortcut', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-8', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('aria-label')).toBe('Add reaction');
    expect(heartBtn?.getAttribute('aria-keyshortcuts')).toBe('ArrowUp');
    ml.destroy();
  });

  it('heart_button_has_a_hold_for_more_title_hint', async () => {
    // Review fix HIGH#6 (operator decision: gesture-only model, no chevron —
    // just a native title hint through i18n).
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-8b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('title')).toBe('React ❤ · hold for more');
    ml.destroy();
  });

  it('heart_button_title_is_localized_for_ru', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-8c', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'ru', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('title')).toBe('Реакция ❤ · удержите для выбора');
    ml.destroy();
  });

  it('heart_aria_label_flips_to_remove_when_the_caller_already_owns_the_heart', async () => {
    // Review fix HIGH#5: the static 'Add reaction' label was wrong for a
    // pressed heart — the real action is REMOVE. State-aware at build time.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-9b', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-9b': { counts: { '❤️': 1 }, users: { '❤️': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(heartBtn?.getAttribute('aria-label')).toBe('Remove reaction');
    ml.destroy();
  });

  it('heart_aria_label_flips_live_on_add_then_back_on_remove', async () => {
    // State-aware at LIVE-sync time too (#syncHeartButton), not just build.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-9c', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    expect(heartBtn.getAttribute('aria-label')).toBe('Add reaction');

    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);
    expect(heartBtn.getAttribute('aria-label')).toBe('Remove reaction');

    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(5);
    expect(heartBtn.getAttribute('aria-label')).toBe('Add reaction');

    ml.destroy();
  });

  // ── Gates: reactionsEnabled=false / no sendReaction capability ────────────

  it('no_heart_button_when_reactionsEnabled_is_false', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-9', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1', reactionsEnabled: false,
    });
    await ml.mount();
    await drainMicrotasks(20);

    expect(container.querySelector('.oxp-reaction-heart-btn')).toBeNull();
    ml.destroy();
  });

  it('no_heart_button_when_client_has_no_sendReaction', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-10', seq: 1 });
    const client: MessageListClient = {
      list: vi.fn().mockResolvedValue({ items: [row], hasNext: false }),
      subscribe: vi.fn().mockReturnValue(() => {}),
      // sendReaction deliberately omitted — capability-less client
    };
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    expect(container.querySelector('.oxp-reaction-heart-btn')).toBeNull();
    ml.destroy();
  });

  // ── Lifecycle: destroy() / eviction clear trigger timers (no leaks) ──────

  it('destroy_clears_a_pending_touch_hold_timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-11', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    // Hold timer pending (400ms) — destroy before it fires.
    ml.destroy();

    await vi.advanceTimersByTimeAsync(1000);
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
  });

  it('destroy_clears_a_pending_mouse_hover_timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-11b', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'mouse' }));
    // Hover timer pending (400ms) — destroy before it fires.
    ml.destroy();

    await vi.advanceTimersByTimeAsync(1000);
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();
  });

  it('eviction_destroys_the_evicted_bubbles_trigger', async () => {
    // Push the live-message count past the hard ceiling while scrolled up
    // (unpinned) so #evictOldMessages runs and must tear down the evicted
    // row's ReactionTrigger along with its DOM/state bookkeeping.
    // getReactions is deliberately OMITTED (not defaulted to a stub) — see
    // message-list-eviction.test.ts's makeMockClient doc comment: with it
    // present, #handleNewMessage's reaction-fetch gate fires once per filler
    // message, and #updateReactionCluster's pre-existing O(n) scan makes
    // MAX_LIVE_MESSAGES_HARD_CEILING+ fillers O(n²) — irrelevant cost for a
    // trigger-lifecycle test.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client: MessageListClient = {
      list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
      subscribe: vi.fn().mockReturnValue(() => {}),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(5);

    const listEl = container.querySelector('.oxp-message-list') as HTMLElement;
    Object.defineProperty(listEl, 'scrollHeight', { value: 100_000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    listEl.scrollTop = 0;

    const firstMsgId = 'msg-evict-first';
    ml.handleMessage(makeRow({ senderUid: 'u2', msgId: firstMsgId, seq: 1 }));
    await drainMicrotasks(5);
    // Capture the first bubble's heart button BEFORE it gets evicted — used
    // below to prove its ReactionTrigger was actually torn down (destroy()
    // called), not merely that the DOM row is gone.
    const evictedHeartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    expect(evictedHeartBtn).not.toBeNull();

    for (let i = 1; i < MAX_LIVE_MESSAGES_HARD_CEILING + 5; i++) {
      ml.handleMessage(makeRow({ senderUid: 'u2', msgId: `msg-evict-${i}`, seq: i + 1 }));
    }
    await drainMicrotasks(10);

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES_HARD_CEILING);
    expect(container.querySelector(`[data-msg-id="${firstMsgId}"]`)).toBeNull();

    // Behavioral proof of teardown: a hold on the DETACHED (evicted) button
    // must not fire onOpenBar — ReactionTrigger.destroy() removed its
    // pointerdown listener, not just the DOM node being gone.
    evictedHeartBtn.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(container.querySelector('.oxp-reaction-quick-bar')).toBeNull();

    ml.destroy();
  }, 30_000); // MAX_LIVE_MESSAGES_HARD_CEILING+ bubble creations — default 5s
  // timeout is too tight under CI/shared-runner load (matches
  // message-list-eviction.test.ts's established margin at this scale).
});
