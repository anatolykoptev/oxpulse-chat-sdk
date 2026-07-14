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
 *  (c) [pr-review-council #80 MAJOR fix] the delayed rollback reconciles via
 *      server truth (getReactions), not a blind wholesale snapshot-restore —
 *      an SSE reaction event for the same message landing during the delay
 *      window must survive, not get clobbered by the stale pre-optimistic
 *      snapshot.
 *  (d) destroy() clears the pending delayed-rollback timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList, WRITE_AUTH_ROLLBACK_DELAY_MS } from '../ui/message-list.js';
import type { MessageListClient, MessageRow, ReactionEvent } from '../ui/message-list.js';

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

// Captured by makeMockClient's subscribe() mock — lets a test fire a live
// SSE reaction event via #handleReaction, same pattern as
// message-list-reactions.test.ts.
let capturedOnReaction: ((event: ReactionEvent) => void) | null = null;

function makeMockClient(rows: MessageRow[] = []): MessageListClient {
  capturedOnReaction = null;
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, args: { onReaction?: (event: ReactionEvent) => void }) => {
      capturedOnReaction = args.onReaction ?? null;
      return () => {};
    }),
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
    capturedOnReaction = null;
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

    // getReactions was already called once at mount() time (#fetchAllReactions)
    // — capture the count here so the post-delay assertion below proves a NEW
    // call happened (not just that it was ever called, which is already true).
    const callsBeforeDelay = (client.getReactions as ReturnType<typeof vi.fn>).mock.calls.length;

    // Rolled back once the full delay elapses — reconciled via a FRESH
    // getReactions call (the mock's default empty response), not a
    // synchronous restore of the captured snapshot.
    await vi.advanceTimersByTimeAsync(WRITE_AUTH_ROLLBACK_DELAY_MS - 1000);
    await drainMicrotasks(10);
    expect((client.getReactions as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBeforeDelay);
    chip = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(chip).toBeNull();

    ml.destroy();
  });

  it('sendReaction_401_delayed_rollback_reconciles_via_server_not_stale_snapshot_on_SSE_collision', async () => {
    // pr-review-council #80 MAJOR fix: a naive "restore the pre-optimistic
    // snapshot wholesale" rollback would silently drop an SSE reaction event
    // that landed DURING the 3s delay window — exactly the scenario this
    // feature targets (write-JWT dead, SSE healthy → concurrent reactions
    // from other users are expected). The delayed rollback must reconcile
    // via #scheduleReactionRefresh (server truth), never clobber it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-4', seq: 1 });
    const client = makeMockClient([row]);
    (client.sendReaction as ReturnType<typeof vi.fn>).mockRejectedValue(authError());
    // FIRST getReactions call is the mount-time #fetchAllReactions fetch —
    // must return empty so the click's preSnapshot is genuinely "no
    // reactions yet" (NOT pre-contaminated with u2's 👍, which would let a
    // buggy wholesale-restore accidentally "survive" it and make this test
    // vacuously pass regardless of the fix). Every call AFTER that
    // (the delayed rollback's reconcile) simulates the server having since
    // recorded u2's SSE-delivered 👍.
    const getReactionsMock = client.getReactions as ReturnType<typeof vi.fn>;
    getReactionsMock.mockResolvedValueOnce({ counts: {}, users: {}, truncated: false });
    getReactionsMock.mockResolvedValue({
      counts: { '👍': 1 },
      users: { '👍': ['u2'] },
      truncated: false,
    });

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement;
    heartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drainMicrotasks(10);

    // SSE echo for a DIFFERENT user's reaction lands mid-window — merged
    // in-place by #handleReaction (does NOT itself call getReactions, since
    // totalCount is supplied), so this is the ONLY source of the 👍 chip
    // until the delayed rollback's own reconcile call.
    expect(capturedOnReaction).not.toBeNull();
    capturedOnReaction!({ msgId: 'msg-4', emoji: '👍', op: 'add', userUid: 'u2', totalCount: 1 });
    await drainMicrotasks(5);

    let chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]');
    expect(chip?.textContent).toContain('1');
    expect(getReactionsMock.mock.calls.length).toBe(1); // still just the mount-time call

    // Delayed rollback fires — must reconcile via a FRESH getReactions call,
    // not clobber the SSE-delivered 👍 with the stale (empty) pre-optimistic
    // snapshot captured at click time.
    await vi.advanceTimersByTimeAsync(WRITE_AUTH_ROLLBACK_DELAY_MS);
    await drainMicrotasks(10);

    expect(getReactionsMock.mock.calls.length).toBeGreaterThan(1);
    expect(getReactionsMock).toHaveBeenCalledWith('r1', 'msg-4');
    chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('1');
    // Self's failed heart add is gone (server truth wins — self never actually added it).
    const heart = container.querySelector('.oxp-reaction-chip[data-emoji="❤️"]');
    expect(heart).toBeNull();

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
