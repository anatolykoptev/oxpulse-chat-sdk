/**
 * message-list-write-401.test.ts — TDD RED phase (write-401 fix, issue #78).
 *
 * demo-reactions RCA 2026-07-14: a write op (sendReaction/removeReaction)
 * failing with 401 silently rolled back with only a console.warn — the host
 * never learned the JWT had expired (the token-expired signal only fired on
 * a subscribe-path auth error, never on a WRITE failure).
 *
 * Tests:
 *  (a) an auth-expired write failure fires the SAME onAuthExpired signal the
 *      subscribe path uses, and delays the optimistic rollback by
 *      WRITE_AUTH_ROLLBACK_DELAY_MS so a fast host refresh + remount never
 *      flashes the chip away and back.
 *  (b) a non-auth failure keeps the existing immediate-rollback behaviour
 *      and still reports a reason via onWriteFailure.
 *  (d) destroy() clears the pending delayed-rollback timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList, WRITE_AUTH_ROLLBACK_DELAY_MS } from '../ui/message-list.js';
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

function makeMockClient(rows: MessageRow[] = []): MessageListClient {
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };
}

/** Auth-shaped rejection matching the real SDKChatError shape (statusCode + code). */
function authError(): Error {
  return Object.assign(new Error('unauthorized'), { statusCode: 401, code: 'unauthorized' });
}

/** Network-shaped rejection matching the real SDKChatError shape. */
function networkError(): Error {
  return Object.assign(new Error('fetch failed'), { code: 'network' });
}

describe('MessageList — write-401 (issue #78)', () => {
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

  it('sendReaction_401_signals_auth_expired_and_delays_rollback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-1', seq: 1 });
    const client = makeMockClient([row]);
    (client.sendReaction as ReturnType<typeof vi.fn>).mockRejectedValue(authError());

    const onAuthExpired = vi.fn();
    const onWriteFailure = vi.fn();
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAuthExpired, onWriteFailure,
    });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(10);

    // Signal fires immediately on the 401 — same as the subscribe path.
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(onWriteFailure).toHaveBeenCalledWith('reaction_add', 'auth_expired', expect.any(String));

    // Rollback delayed: chip is still present right after the failure.
    let chip = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(chip).not.toBeNull();

    // Still present short of the delay window.
    await vi.advanceTimersByTimeAsync(1000);
    chip = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(chip).not.toBeNull();

    // Rolled back once the full delay elapses.
    await vi.advanceTimersByTimeAsync(WRITE_AUTH_ROLLBACK_DELAY_MS - 1000);
    chip = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(chip).toBeNull();

    ml.destroy();
  });

  it('sendReaction_network_failure_rolls_back_immediately_with_reason', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-2', seq: 1 });
    const client = makeMockClient([row]);
    (client.sendReaction as ReturnType<typeof vi.fn>).mockRejectedValue(networkError());

    const onAuthExpired = vi.fn();
    const onWriteFailure = vi.fn();
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAuthExpired, onWriteFailure,
    });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(10);

    // No auth signal for a network failure — existing behaviour preserved.
    expect(onAuthExpired).not.toHaveBeenCalled();
    // Failure still reported, with the correct reason.
    expect(onWriteFailure).toHaveBeenCalledWith('reaction_add', 'network', expect.any(String));

    // Immediate rollback — no fake timers installed in this test, so a chip
    // still present here would mean rollback did NOT happen synchronously.
    const chip = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(chip).toBeNull();

    ml.destroy();
  });

  it('destroy_clears_pending_rollback_timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-3', seq: 1 });
    const client = makeMockClient([row]);
    (client.sendReaction as ReturnType<typeof vi.fn>).mockRejectedValue(authError());

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(10);

    // Find the rollback timer's id among every setTimeout scheduled by the
    // click (the heart-pulse animation also schedules its own, shorter, timer).
    const rollbackCallIndex = setTimeoutSpy.mock.calls.findIndex(
      (call) => call[1] === WRITE_AUTH_ROLLBACK_DELAY_MS,
    );
    expect(rollbackCallIndex).toBeGreaterThanOrEqual(0);
    const rollbackTimerId = setTimeoutSpy.mock.results[rollbackCallIndex]!.value;

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    ml.destroy();

    expect(clearSpy).toHaveBeenCalledWith(rollbackTimerId);

    setTimeoutSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
