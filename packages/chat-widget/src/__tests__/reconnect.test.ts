/**
 * reconnect.test.ts — TDD RED phase (W2.2 slice 5)
 *
 * Tests: Reconnector class in ui/reconnect.ts
 *
 * WCAG contrastRatio helper adapted from prior slices:
 *   W = luminance of lighter color, B = luminance of darker color
 *   ratio = (W + 0.05) / (B + 0.05)
 *   linearize(c) = c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4
 *   luminance(r,g,b) = 0.2126*R + 0.7152*G + 0.0722*B
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reconnector } from '../ui/reconnect.js';

// ── WCAG contrast helper ──────────────────────────────────────────────────────

function linearize(c: number): number {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Theme color values (from theme.ts)
const THEMES = {
  light: {
    bg: [255, 255, 255] as [number, number, number],
    fg: [26, 26, 26] as [number, number, number],
    danger: [192, 0, 0] as [number, number, number],       // #c00000
    accent: [0, 136, 204] as [number, number, number],     // #0088cc
    onAccent: [0, 0, 0] as [number, number, number],       // #000
  },
  dark: {
    bg: [28, 28, 30] as [number, number, number],
    fg: [235, 235, 245] as [number, number, number],
    danger: [255, 107, 107] as [number, number, number],   // #ff6b6b
    accent: [10, 132, 255] as [number, number, number],    // #0a84ff
    onAccent: [0, 0, 0] as [number, number, number],       // #000
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Reconnector', () => {
  let container: HTMLDivElement;
  let host: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    host = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (container.parentNode) container.parentNode.removeChild(container);
    if (host.parentNode) host.parentNode.removeChild(host);
  });

  it('mount_renders_no_banner_initially', () => {
    const r = new Reconnector({ container, host });
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
    r.clear();
  });

  it('notifyAuthExpired_shows_banner_with_refresh_button', () => {
    const r = new Reconnector({ container, host });
    r.notifyAuthExpired();
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner).not.toBeNull();
    const btn = banner!.querySelector('button');
    expect(btn).not.toBeNull();
    r.clear();
  });

  // i18n follow-up: lang defaults to English (unchanged); lang='ru' localizes
  // the banner text and button label/aria.
  it('notifyAuthExpired_localizes_banner_and_button_for_lang_ru', () => {
    const r = new Reconnector({ container, host, lang: 'ru' });
    r.notifyAuthExpired();
    const banner = container.querySelector('.oxp-reconnect-banner')!;
    expect(banner.textContent).toContain('Сессия истекла.');
    const btn = banner.querySelector('button')!;
    expect(btn.textContent).toBe('Обновить');
    expect(btn.getAttribute('aria-label')).toBe('Обновить сессию');
    r.clear();
  });

  it('notifyNetworkLost_localizes_the_attempt_count_message_for_lang_ru', () => {
    const r = new Reconnector({ container, host, lang: 'ru' });
    r.notifyNetworkLost(3);
    const banner = container.querySelector('.oxp-reconnect-banner')!;
    expect(banner.textContent).toBe('Соединение потеряно. Переподключение… (попытка 3)');
    r.clear();
  });

  it('notifyNetworkLost_shows_reconnecting_banner', () => {
    const r = new Reconnector({ container, host });
    r.notifyNetworkLost(1);
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('data-state')).toBe('reconnecting');
    r.clear();
  });

  it('notifyReconnected_shows_brief_toast_and_clears_after_2s', () => {
    vi.useFakeTimers();
    const r = new Reconnector({ container, host });
    r.notifyReconnected();
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('data-state')).toBe('connected');

    vi.advanceTimersByTime(2000);
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
    r.clear();
  });

  it('auth_expired_banner_has_role_alert_aria_live_assertive', () => {
    const r = new Reconnector({ container, host });
    r.notifyAuthExpired();
    const banner = container.querySelector('.oxp-reconnect-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    r.clear();
  });

  it('reconnecting_banner_has_role_status_aria_live_polite', () => {
    const r = new Reconnector({ container, host });
    r.notifyNetworkLost(1);
    const banner = container.querySelector('.oxp-reconnect-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    r.clear();
  });

  it('refresh_button_dispatches_token_expired_event', () => {
    const r = new Reconnector({ container, host });
    const events: Event[] = [];
    host.addEventListener('oxpulse-chat:token-expired', (e) => events.push(e));
    r.notifyAuthExpired();
    const btn = container.querySelector('.oxp-reconnect-banner button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(events.length).toBe(1);
    r.clear();
  });

  it('clear_removes_banner_from_dom', () => {
    const r = new Reconnector({ container, host });
    r.notifyAuthExpired();
    expect(container.querySelector('.oxp-reconnect-banner')).not.toBeNull();
    r.clear();
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
  });

  it('respects_abort_signal_during_setup', () => {
    const ac = new AbortController();
    ac.abort();
    // Should not throw when signal is already aborted
    const r = new Reconnector({ container, host, signal: ac.signal });
    // Aborted signal — notifyAuthExpired should be a no-op
    r.notifyAuthExpired();
    // Banner should NOT be shown because signal was aborted before setup
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
    r.clear();
  });

  it('banner_contrast_passes_wcag_in_all_states_both_themes', () => {
    // Auth-expired state: text is var(--oxp-fg) on danger-tinted bg
    // We check the declared color tokens, not computed CSS (jsdom doesn't compute)
    // Light: danger=#c00000 on white bg. fg=#1a1a1a on white. Both need ≥4.5:1
    const lightFg = luminance(...THEMES.light.fg);
    const lightBg = luminance(...THEMES.light.bg);
    const lightDanger = luminance(...THEMES.light.danger);

    // Text contrast: fg on bg
    expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(4.5);
    // Danger text on white bg
    expect(contrastRatio(lightDanger, lightBg)).toBeGreaterThanOrEqual(4.5);

    // Dark: danger=#ff6b6b on dark bg. fg=#ebebf5 on dark bg.
    const darkFg = luminance(...THEMES.dark.fg);
    const darkBg = luminance(...THEMES.dark.bg);
    const darkDanger = luminance(...THEMES.dark.danger);

    expect(contrastRatio(darkFg, darkBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkDanger, darkBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('retry_count_shown_in_reconnecting_banner', () => {
    const r = new Reconnector({ container, host });
    r.notifyNetworkLost(3);
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('3');
    r.clear();
  });

  it('shows_manual_reconnect_button_after_10_attempts', () => {
    const r = new Reconnector({ container, host });
    r.notifyGivenUp();
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner).not.toBeNull();
    const btn = banner!.querySelector('button');
    expect(btn).not.toBeNull();
    r.clear();
  });

  // ── Design M1: persistent banner DOM node identity ────────────────────────────

  it('banner_dom_node_identity_preserved_across_state_changes', () => {
    // Design M1: #show() must NOT remove+re-create banner — live region lost on re-create.
    // Banner div created once in ctor (or first show). State changes mutate in-place.
    const r = new Reconnector({ container, host });
    r.notifyNetworkLost(1);
    const bannerRef = container.querySelector('.oxp-reconnect-banner') as HTMLElement;
    expect(bannerRef).not.toBeNull();
    // Transition to different state — same DOM node must survive
    r.notifyNetworkLost(2);
    const bannerRef2 = container.querySelector('.oxp-reconnect-banner') as HTMLElement;
    expect(bannerRef2).toBe(bannerRef);
    // Transition to auth-expired — still same node
    r.notifyAuthExpired();
    const bannerRef3 = container.querySelector('.oxp-reconnect-banner') as HTMLElement;
    expect(bannerRef3).toBe(bannerRef);
    r.clear();
  });

  // ── CM2: AbortSignal + destroy() cleans up timers ────────────────────────────

  it('destroy_removes_banner_and_stops_timers', () => {
    vi.useFakeTimers();
    const r = new Reconnector({ container, host });
    r.notifyNetworkLost(1);
    expect(container.querySelector('.oxp-reconnect-banner')).not.toBeNull();
    r.destroy();
    // Banner removed after destroy
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
    // Advance timers — must not throw
    vi.advanceTimersByTime(10_000);
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
    vi.useRealTimers();
  });

  it('abort_signal_triggers_destroy', () => {
    const ac = new AbortController();
    const r = new Reconnector({ container, host, signal: ac.signal });
    r.notifyNetworkLost(1);
    expect(container.querySelector('.oxp-reconnect-banner')).not.toBeNull();
    // Aborting the signal must clean up (destroy) the Reconnector
    ac.abort();
    expect(container.querySelector('.oxp-reconnect-banner')).toBeNull();
  });

  // ── CM3: online/offline listeners ────────────────────────────────────────────

  it('online_event_retries_if_reconnecting', () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribe = vi.fn().mockImplementation((_roomId: string, onError: (err: unknown) => void) => {
      subscribeCalls++;
      capturedOnError = onError;
      return () => {};
    });
    const r = new Reconnector({ container, host });
    // Start reconnect loop — attempt 0 fires at delay=0
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // fire attempt 0 (subscribeCalls=1, state→connected)
    expect(capturedOnError).not.toBeNull();
    // Simulate async network error from subscribe → reschedules with increasing delay
    capturedOnError!({ status: 503 });
    // Now in reconnecting state with delay=1000ms (attempt 1). Online event should retry immediately.
    const beforeOnline = subscribeCalls;
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(0); // process the immediate retry triggered by online
    expect(subscribeCalls).toBeGreaterThan(beforeOnline);
    r.clear();
    vi.useRealTimers();
  });

  it('destroy_removes_window_listeners', () => {
    // After destroy(), window online/offline listeners must be removed
    // Verified indirectly: after destroy, online event must not interact with cleared state
    const r = new Reconnector({ container, host });
    r.destroy();
    // Must not throw
    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
    expect(() => window.dispatchEvent(new Event('offline'))).not.toThrow();
  });

  // ── Design M4 / Code M7: notifyAuthExpired stops reconnect loop ──────────────

  it('notifyAuthExpired_stops_reconnect_loop_before_showing_banner', () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    const subscribe = vi.fn().mockImplementation((_roomId: string, _onError: (err: unknown) => void) => {
      subscribeCalls++;
      return () => {};
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    // Advance to fire first attempt
    vi.advanceTimersByTime(0);
    const callsAfterStart = subscribeCalls;
    // notifyAuthExpired must stop the loop
    r.notifyAuthExpired();
    // Advance significantly — no more subscribe calls should happen
    vi.advanceTimersByTime(20_000);
    expect(subscribeCalls).toBe(callsAfterStart);
    r.clear();
    vi.useRealTimers();
  });

  it('notifyReconnected_stops_reconnect_loop', () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    const subscribe = vi.fn().mockImplementation((_roomId: string, _onError: (err: unknown) => void) => {
      subscribeCalls++;
      return () => {};
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0);
    const callsAfterStart = subscribeCalls;
    r.notifyReconnected();
    vi.advanceTimersByTime(20_000);
    expect(subscribeCalls).toBe(callsAfterStart);
    r.clear();
    vi.useRealTimers();
  });

  // ── Regression (freeze_stall): a successful reconnect must NOT tear down the
  //    subscription it just established. Prior bug: notifyReconnected() called
  //    stopReconnectLoop(), whose unsubscribe branch immediately killed the fresh
  //    SSE sub — leaving a permanently-dead room behind a false 'connected' banner.
  //    These use a NON-noop unsub spy so the teardown is observable (the old suite
  //    mocked unsub as a no-op, masking the bug).
  it('reconnect_success_keeps_the_fresh_subscription_live', () => {
    vi.useFakeTimers();
    const unsub = vi.fn();
    let subscribeCalls = 0;
    const subscribe = vi.fn().mockImplementation((_roomId: string, _onError: (err: unknown) => void) => {
      subscribeCalls++;
      return unsub; // NON-noop spy — a real SSE teardown is observable
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // fire attempt 0 → subscribe() succeeds → notifyReconnected()

    expect(subscribeCalls).toBe(1);
    // The fresh subscription MUST stay live — unsub must NOT have been called.
    expect(unsub).not.toHaveBeenCalled();

    // …and it must still be live after the 'connected' toast auto-hides (2s).
    vi.advanceTimersByTime(2_000);
    expect(unsub).not.toHaveBeenCalled();

    r.clear();
    vi.useRealTimers();
  });

  it('online_retry_success_keeps_the_fresh_subscription_live', () => {
    // Same freeze_stall regression on the #onOnline immediate-retry path.
    vi.useFakeTimers();
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribe = vi.fn().mockImplementation((_roomId: string, onError: (err: unknown) => void) => {
      capturedOnError = onError;
      const u = vi.fn();
      unsubs.push(u);
      return u;
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // attempt 0 succeeds (sub #0)
    // Network drop → reschedule (state → reconnecting)
    capturedOnError!({ status: 503 });
    // Browser back online → immediate retry establishes a fresh sub
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(0); // #onOnline retry succeeds (sub #1)

    const latest = unsubs[unsubs.length - 1]!;
    expect(latest).not.toHaveBeenCalled(); // fresh sub from the online-retry stays live
    // …and the STALE sub (sub0) must have been torn down before sub1 replaced it —
    // else its SDK decrypt-chain release is dropped and it self-reconnects (orphan leak).
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    r.clear();
    vi.useRealTimers();
  });

  it('reconnect_flap_via_timer_tears_down_stale_sub_before_replacing', () => {
    // #scheduleAttempt (timer-path) analog of the online flap: reconnect → drop →
    // backoff-timer retry reconnect. The stale sub must be released before the fresh
    // one replaces it, else the overwrite drops the prior teardown on the floor.
    vi.useFakeTimers();
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribe = vi.fn().mockImplementation((_roomId: string, onError: (err: unknown) => void) => {
      capturedOnError = onError;
      const u = vi.fn();
      unsubs.push(u);
      return u;
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // attempt 0 succeeds (sub #0)
    capturedOnError!({ status: 503 }); // network drop → reschedule (attempt 1 → delay 1000ms)
    vi.advanceTimersByTime(1_000); // backoff timer fires → retry succeeds (sub #1)

    expect(unsubs).toHaveLength(2);
    expect(unsubs[0]).toHaveBeenCalledTimes(1); // stale sub0 released before sub1 replaced it
    expect(unsubs[1]).not.toHaveBeenCalled();   // fresh sub1 stays live
    r.clear();
    vi.useRealTimers();
  });

  it('destroy_tears_down_the_live_subscription', () => {
    // Genuine-teardown path must STILL work: destroy() → clear() → stopReconnectLoop()
    // → unsubscribe(). The fix only stops notifyReconnected() from doing this.
    vi.useFakeTimers();
    const unsub = vi.fn();
    const subscribe = vi.fn().mockImplementation(() => unsub);
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // establish a live sub
    expect(unsub).not.toHaveBeenCalled();
    r.destroy();
    expect(unsub).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('clear_tears_down_the_live_subscription', () => {
    // Genuine-teardown path (room-change / reset): clear() → stopReconnectLoop() → unsubscribe().
    vi.useFakeTimers();
    const unsub = vi.fn();
    const subscribe = vi.fn().mockImplementation(() => unsub);
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // establish a live sub
    expect(unsub).not.toHaveBeenCalled();
    r.clear();
    expect(unsub).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ── Design M3: conditional focus seizure ─────────────────────────────────────

  it('notifyAuthExpired_does_not_seize_focus_when_unrelated_element_focused', () => {
    // When an unrelated element has focus, the refresh button must NOT steal it
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const r = new Reconnector({ container, host });
    r.notifyAuthExpired();
    // Focus must remain on input, not stolen by banner button
    expect(document.activeElement).toBe(input);
    r.clear();
    document.body.removeChild(input);
  });

  // ── CM1: SubscribeFn async error via onError callback ────────────────────────

  it('subscribe_fn_async_error_via_oncallback_triggers_auth_flow', () => {
    vi.useFakeTimers();
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribe = vi.fn().mockImplementation((_roomId: string, onError: (err: unknown) => void) => {
      capturedOnError = onError;
      return () => {};
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // fire first attempt
    expect(capturedOnError).not.toBeNull();
    // Simulate async auth error via callback
    capturedOnError!({ status: 401 });
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner?.getAttribute('data-state')).toBe('auth-expired');
    r.clear();
    vi.useRealTimers();
  });

  it('subscribe_fn_async_network_error_via_callback_reschedules', () => {
    vi.useFakeTimers();
    let capturedOnError: ((err: unknown) => void) | null = null;
    let subscribeCalls = 0;
    const subscribe = vi.fn().mockImplementation((_roomId: string, onError: (err: unknown) => void) => {
      capturedOnError = onError;
      subscribeCalls++;
      return () => {};
    });
    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'r1');
    vi.advanceTimersByTime(0); // fire first attempt (attempt 0 → subscribeCalls=1)
    expect(capturedOnError).not.toBeNull();
    // Simulate network error — should reschedule
    capturedOnError!({ status: 503 });
    // Advance past next retry delay
    vi.advanceTimersByTime(2000);
    expect(subscribeCalls).toBeGreaterThan(1);
    r.clear();
    vi.useRealTimers();
  });

  // ── Observability: oxpulse-chat:reconnect-exhausted event ───────────────────

  it('notifyGivenUp_dispatches_reconnect_exhausted_event_with_roomId_and_attempts', () => {
    // After MAX_ATTEMPTS (10) the Reconnector gives up. notifyGivenUp() must
    // dispatch 'oxpulse-chat:reconnect-exhausted' on the host with detail
    // {roomId, attempts} so a permanently-dead room is host-visible (contrast
    // notifyAuthExpired which dispatches oxpulse-chat:token-expired).
    vi.useFakeTimers();
    const events: CustomEvent[] = [];
    host.addEventListener('oxpulse-chat:reconnect-exhausted', (e) => events.push(e as CustomEvent));

    // subscribe fn that always THROWS synchronously with a non-auth error →
    // drives the loop to exhaustion (10 attempts) → notifyGivenUp → event.
    // A synchronous throw is used (not async onError) because a subscribe fn
    // that returns synchronously triggers notifyReconnected() + attempt=0
    // reset, preventing the loop from ever reaching MAX_ATTEMPTS.
    const subscribe = vi.fn().mockImplementation(() => {
      throw { status: 503 };
    });

    const r = new Reconnector({ container, host });
    r.startReconnectLoop(subscribe, 'room-exhausted');

    // Drive the full retry sequence: attempt 0 (delay 0) + 9 more attempts
    // with escalating backoff (1s,2s,4s,8s,8s,8s,8s,8s,8s). Advancing past
    // the sum of all delays (~57s) fires every scheduled attempt.
    vi.advanceTimersByTime(100_000);

    expect(events).toHaveLength(1);
    const detail = events[0]!.detail as { roomId: string; attempts: number };
    expect(detail.roomId).toBe('room-exhausted');
    expect(detail.attempts).toBe(10);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);

    r.clear();
    vi.useRealTimers();
  });
});
