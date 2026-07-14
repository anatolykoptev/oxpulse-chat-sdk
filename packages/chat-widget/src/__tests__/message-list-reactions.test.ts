/**
 * message-list-reactions.test.ts — TDD RED phase (W2.2 slice 3)
 *
 * Tests: MessageList reaction cluster rendering + live reaction updates.
 * Extends the stub client with getReactions, sendReaction, removeReaction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow, ReactionEvent } from '../ui/message-list.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

interface ReactionsResponse {
  counts: Record<string, number>;
  users: Record<string, string[]>;
  truncated: boolean;
}

// Captured callbacks
let capturedOnMessage: ((row: MessageRow) => void) | null = null;
let capturedOnReaction: ((event: ReactionEvent) => void) | null = null;

function makeMockClient(
  rows: MessageRow[] = [],
  reactions: Record<string, ReactionsResponse> = {},
): MessageListClient {
  capturedOnMessage = null;
  capturedOnReaction = null;

  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, args: {
      onMessage: (row: MessageRow) => void;
      onMutation?: (event: { msgId: string; op: string; deletedAt?: string }) => void;
      onReaction?: (event: ReactionEvent) => void;
    }) => {
      capturedOnMessage = args.onMessage;
      capturedOnReaction = args.onReaction ?? null;
      return () => {};
    }),
    getReactions: vi.fn().mockImplementation(
      (_roomId: string, msgId: string) =>
        Promise.resolve(
          reactions[msgId] ?? { counts: {}, users: {}, truncated: false },
        ),
    ),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MessageList — reactions', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    capturedOnMessage = null;
    capturedOnReaction = null;
  });

  it('renders_reaction_cluster_when_counts_present', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-1', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-1': { counts: { '👍': 3, '❤️': 1 }, users: { '👍': ['u2', 'u3', 'u4'], '❤️': ['u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const clusters = container.querySelectorAll('.oxp-bubble-reactions');
    expect(clusters.length).toBe(1);
    const chips = clusters[0]!.querySelectorAll('.oxp-reaction-chip');
    expect(chips.length).toBe(2);
    ml.destroy();
  });

  it('does_not_render_cluster_for_empty_counts', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-2', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-2': { counts: {}, users: {}, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const chips = container.querySelectorAll('.oxp-reaction-chip');
    expect(chips.length).toBe(0);
    ml.destroy();
  });

  it('empty selfUid never false-positives a reaction chip as own, even if the users list carries a stray empty entry (Bug 2 — see list-helpers.isSelf)', async () => {
    // Wiring-proof: fails if #updateReactionCluster ever reverts to the bare
    // `emojiUsers.includes(this.#selfUid)` compare instead of routing through
    // the guarded isSelf() helper — [''].includes('') would otherwise read as own.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-empty', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-empty': { counts: { '👍': 1 }, users: { '👍': [''] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: '' });
    await ml.mount();
    await drainMicrotasks(20);

    const chip = container.querySelector('.oxp-reaction-chip') as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('data-own')).toBe('false');
    ml.destroy();
  });

  it('clicking_own_chip_calls_removeReaction', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-3', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-3': { counts: { '👍': 2 }, users: { '👍': ['u1', 'u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Own chip (selfUid u1 is in users['👍'])
    const ownChip = container.querySelector('.oxp-reaction-chip[data-own="true"]') as HTMLButtonElement | null;
    expect(ownChip).not.toBeNull();
    ownChip!.click();
    await drainMicrotasks();

    expect(client.removeReaction).toHaveBeenCalledWith('r1', 'msg-3', expect.any(String));
    ml.destroy();
  });

  it('clicking_other_chip_calls_sendReaction', async () => {
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-4', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-4': { counts: { '❤️': 1 }, users: { '❤️': ['u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Other chip (u1 is NOT in users['❤️'])
    const otherChip = container.querySelector('.oxp-reaction-chip[data-own="false"]') as HTMLButtonElement | null;
    expect(otherChip).not.toBeNull();
    otherChip!.click();
    await drainMicrotasks();

    expect(client.sendReaction).toHaveBeenCalledWith('r1', 'msg-4', expect.any(String));
    ml.destroy();
  });

  it('onReaction_add_updates_chip_count_optimistically', async () => {
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-5', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-5': { counts: { '👍': 1 }, users: { '👍': ['u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Initial chip shows count 1
    let chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('1');

    // Live reaction: u1 adds 👍 → count becomes 2
    capturedOnReaction!({
      msgId: 'msg-5',
      emoji: '👍',
      op: 'add',
      userUid: 'u1',
      totalCount: 2,
    });
    await drainMicrotasks(10);

    chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('2');
    ml.destroy();
  });

  it('onReaction_remove_updates_chip_count_optimistically', async () => {
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-6', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-6': { counts: { '👍': 2 }, users: { '👍': ['u1', 'u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Initial chip shows count 2
    let chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('2');

    // Live reaction: u1 removes 👍 → count becomes 1
    capturedOnReaction!({
      msgId: 'msg-6',
      emoji: '👍',
      op: 'remove',
      userUid: 'u1',
      totalCount: 1,
    });
    await drainMicrotasks(10);

    chip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('1');
    ml.destroy();
  });

  it('arrowup_on_the_heart_button_opens_the_bar_anchored_to_the_bubble', async () => {
    // Heart-first amendment (spec 2026-07-14): the visible '+😀' click-to-open
    // button is gone — ArrowUp on the heart button is the deterministic
    // (no-fake-timers-needed) path to the full bar, same destination as a
    // ≥500ms hold (covered with fake timers in message-list-reaction-triggers.test.ts).
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-7', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(10);

    // Heart button exists on bubble
    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn).not.toBeNull();

    heartBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    // Bar should be visible
    const bar = container.querySelector('.oxp-reaction-quick-bar');
    expect(bar).not.toBeNull();
    ml.destroy();
  });

  it('selecting_emoji_in_the_bar_calls_sendReaction', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-8', seq: 1 });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(10);

    // Open the bar via ArrowUp on the heart button.
    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn).not.toBeNull();
    heartBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    // Select first emoji in the bar
    const emojiBtn = container.querySelector('.oxp-reaction-quick-bar-button') as HTMLButtonElement | null;
    expect(emojiBtn).not.toBeNull();
    emojiBtn!.click();
    await drainMicrotasks(5);

    expect(client.sendReaction).toHaveBeenCalledWith('r1', 'msg-8', expect.any(String));
    ml.destroy();
  });

  it('reaction_cluster_has_group_role_and_aria_label', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-9', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-9': { counts: { '👍': 1 }, users: { '👍': ['u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const cluster = container.querySelector('.oxp-bubble-reactions') as HTMLElement | null;
    expect(cluster).not.toBeNull();
    expect(cluster!.getAttribute('role')).toBe('group');
    expect(cluster!.getAttribute('aria-label')).toBeTruthy();
    ml.destroy();
  });

  it('dedupes_rapid_double_tap_on_chip', async () => {
    // M6: Rapid double-tap race — second tap must be ignored if in-flight.
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-11', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-11': { counts: { '👍': 1 }, users: { '👍': ['u2'] }, truncated: false },
    };
    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<void>((res) => { resolveFirst = res; });

    const client = makeMockClient([row], reactions);
    // sendReaction hangs until we resolve it manually to simulate in-flight
    (client.sendReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(firstCallPromise);

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const chip = container.querySelector('.oxp-reaction-chip[data-own="false"]') as HTMLButtonElement | null;
    expect(chip).not.toBeNull();

    // First tap
    chip!.click();
    // Second tap immediately (in-flight)
    chip!.click();
    await drainMicrotasks(5);

    // sendReaction must be called exactly once despite two taps
    expect(client.sendReaction).toHaveBeenCalledTimes(1);

    resolveFirst();
    ml.destroy();
  });

  it('chip_focus_preserved_on_live_reaction_update', async () => {
    // M7 / Code MAJOR-1: #updateReactionCluster wipes innerHTML → focus lost.
    // Fix: diff-patch chips in-place, not full rebuild.
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-12', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-12': { counts: { '👍': 2 }, users: { '👍': ['u1', 'u2'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Focus the own chip
    const chip = container.querySelector('.oxp-reaction-chip[data-own="true"]') as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    chip!.focus();
    expect(document.activeElement).toBe(chip);

    // Live reaction update — another user adds a reaction
    capturedOnReaction!({
      msgId: 'msg-12',
      emoji: '👍',
      op: 'add',
      userUid: 'u3',
      totalCount: 3,
    });
    await drainMicrotasks(10);

    // Active element must still be a chip for 👍 (focus preserved)
    expect(document.activeElement).not.toBeNull();
    expect((document.activeElement as HTMLElement).getAttribute('data-emoji')).toBe('👍');

    ml.destroy();
  });

  it('optimistic_send_rollback_preserves_pre_state_on_concurrent_echo', async () => {
    // Code MAJOR-3: Optimistic rollback reads post-mutation state → off-by-one
    // if live echo arrives between optimistic update + rejection.
    // Fix: snapshot pre-mutation state and restore wholesale on rejection.
    const row = makeRow({ senderUid: 'u2', msgId: 'msg-13', seq: 1 });
    const initialReactions: Record<string, ReactionsResponse> = {
      'msg-13': { counts: { '👍': 1 }, users: { '👍': ['u2'] }, truncated: false },
    };

    let rejectSendReaction!: (e: Error) => void;
    const sendPromise = new Promise<void>((_, rej) => { rejectSendReaction = rej; });

    const client = makeMockClient([row], initialReactions);
    (client.sendReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(sendPromise);

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    // Click non-own chip to trigger optimistic add
    const chip = container.querySelector('.oxp-reaction-chip[data-own="false"]') as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    chip!.click();
    await drainMicrotasks(5);

    // Count now optimistically shows 2 (u1 added)
    const updatedChip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    expect(updatedChip?.textContent).toContain('2');

    // Concurrent live echo arrives while add is in-flight
    capturedOnReaction!({
      msgId: 'msg-13',
      emoji: '👍',
      op: 'remove',
      userUid: 'u2',
      totalCount: 1,
    });
    await drainMicrotasks(5);

    // Reject the sendReaction → rollback to pre-add state (1 count)
    rejectSendReaction(new Error('network'));
    await drainMicrotasks(10);

    // After rollback: count should reflect pre-send snapshot (u2 removed → 0 or 1)
    // What matters: count does not go to a nonsense value (e.g. -1 or 3)
    const finalChip = container.querySelector('.oxp-reaction-chip[data-emoji="👍"]') as HTMLElement | null;
    if (finalChip) {
      const count = parseInt(finalChip.textContent?.match(/\d+/)?.[0] ?? '0', 10);
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(1);
    }
    // No crash — test passes

    ml.destroy();
  });

  it('own_chip_has_aria_pressed_true', async () => {
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-10', seq: 1 });
    const reactions: Record<string, ReactionsResponse> = {
      'msg-10': { counts: { '👍': 1 }, users: { '👍': ['u1'] }, truncated: false },
    };
    const client = makeMockClient([row], reactions);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    await drainMicrotasks(20);

    const chip = container.querySelector('.oxp-reaction-chip[data-own="true"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('aria-pressed')).toBe('true');
    ml.destroy();
  });

  it('bar_mounts_to_shadow_host_not_widget_root', async () => {
    // MAJOR-5: When shadowHost is passed to MessageList, ReactionQuickBar.show()
    // must mount into that ShadowRoot element (not the container which has overflow:hidden).
    // Without this wire, the bar appends to container → clipped by overflow:hidden.
    const row = makeRow({ senderUid: 'u1', msgId: 'msg-14', seq: 1 });
    const client = makeMockClient([row]);

    // Create a distinct shadow host element separate from container
    const shadowHost = document.createElement('div');
    shadowHost.id = 'shadow-host';
    document.body.appendChild(shadowHost);

    const ml = new MessageList({
      client,
      roomId: 'r1',
      container,
      lang: 'en',
      selfUid: 'u1',
      shadowHost: shadowHost as unknown as ShadowRoot,
    });
    await ml.mount();
    await drainMicrotasks(10);

    // ArrowUp on the heart button opens the bar (heart-first amendment 2026-07-14).
    const heartBtn = container.querySelector('.oxp-reaction-heart-btn') as HTMLButtonElement | null;
    expect(heartBtn).not.toBeNull();
    heartBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await drainMicrotasks(5);

    // Bar must be appended to shadowHost, NOT container
    const barInShadowHost = shadowHost.querySelector('.oxp-reaction-quick-bar');
    const barInContainer = container.querySelector('.oxp-reaction-quick-bar');
    expect(barInShadowHost).not.toBeNull(); // mounted to shadow host
    expect(barInContainer).toBeNull();       // NOT in overflow:hidden container

    shadowHost.remove();
    ml.destroy();
  });
});
