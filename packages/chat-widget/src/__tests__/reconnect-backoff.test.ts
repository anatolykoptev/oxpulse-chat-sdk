/**
 * reconnect-backoff.test.ts — TDD RED phase (W2.2 slice 5)
 *
 * Tests: exponential backoff strategy in BackoffStrategy (ui/reconnect.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackoffStrategy } from '../ui/reconnect.js';

describe('BackoffStrategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('first_attempt_immediate', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.delayMs(0)).toBe(0);
  });

  it('second_attempt_1s', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.delayMs(1)).toBe(1000);
  });

  it('third_attempt_2s', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.delayMs(2)).toBe(2000);
  });

  it('fourth_attempt_4s', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.delayMs(3)).toBe(4000);
  });

  it('fifth_attempt_8s', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.delayMs(4)).toBe(8000);
  });

  it('caps_at_8_seconds', () => {
    const strategy = new BackoffStrategy();
    // Attempt 5+ should all return 8s base (before jitter)
    expect(strategy.delayMs(5)).toBeLessThanOrEqual(8000 * 1.2);
    expect(strategy.delayMs(10)).toBeLessThanOrEqual(8000 * 1.2);
    expect(strategy.delayMs(20)).toBeLessThanOrEqual(8000 * 1.2);
  });

  it('jitter_within_20_percent_for_capped_attempts', () => {
    const strategy = new BackoffStrategy();
    // Run multiple times to verify jitter range
    for (let i = 0; i < 20; i++) {
      const delay = strategy.delayMs(5);
      expect(delay).toBeGreaterThanOrEqual(8000 * 0.8);
      expect(delay).toBeLessThanOrEqual(8000 * 1.2);
    }
  });

  it('gives_up_after_10_attempts', () => {
    const strategy = new BackoffStrategy();
    expect(strategy.shouldGiveUp(10)).toBe(true);
    expect(strategy.shouldGiveUp(9)).toBe(false);
  });

  it('resets_counter_on_success', () => {
    const strategy = new BackoffStrategy();
    strategy.reset();
    expect(strategy.delayMs(0)).toBe(0);
    expect(strategy.shouldGiveUp(10)).toBe(true);
  });

  it('does_not_retry_on_auth_error', () => {
    const strategy = new BackoffStrategy();
    // Auth errors should not use backoff — return null to signal skip
    expect(strategy.shouldRetryOnAuthError()).toBe(false);
  });
});

// ── Integration: Reconnector uses BackoffStrategy ────────────────────────────

import { Reconnector } from '../ui/reconnect.js';
import { isAuthError } from '../utils/auth.js';

describe('Reconnector backoff integration', () => {
  let container: HTMLDivElement;
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
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

  it('reconnect_attempts_use_exponential_delays', async () => {
    const callTimes: number[] = [];
    let attemptCount = 0;

    const subscribe = vi.fn().mockImplementation(() => {
      callTimes.push(Date.now());
      attemptCount++;
      // Fail with network error for first 3 attempts
      if (attemptCount <= 3) {
        // onError will be captured by Reconnector
        return () => {};
      }
      return () => {};
    });

    const r = new Reconnector({ container, host });

    // Simulate network lost — trigger reconnect loop
    r.startReconnectLoop(subscribe, 'r1');

    // First attempt: immediate
    await vi.runAllTimersAsync();
    expect(callTimes.length).toBeGreaterThanOrEqual(1);

    r.stopReconnectLoop();
    r.clear();
  });

  it('auth_error_stops_reconnect_loop_and_shows_banner', () => {
    const authErr = { status: 401, kind: 'auth_expired' };
    expect(isAuthError(authErr)).toBe(true);

    const r = new Reconnector({ container, host });
    r.notifyAuthExpired();
    const banner = container.querySelector('.oxp-reconnect-banner');
    expect(banner?.getAttribute('data-state')).toBe('auth-expired');
    r.clear();
  });
});
