/**
 * message-list-eviction.test.ts — bound live-message DOM/memory growth.
 *
 * Production-blocking audit gap: #order/#rows and their DOM bubbles grew
 * unboundedly as live messages streamed in via #handleNewMessage — no
 * eviction existed anywhere. A design-partner central chat room expecting
 * thousands of messages/day, kept open in a visitor's tab through a busy
 * period, accumulated unbounded DOM nodes.
 *
 * These tests prove: (1) a live append past MAX_LIVE_MESSAGES evicts the
 * oldest entries down to the cap; (2) eviction is skipped while the user has
 * scrolled up reading history (no yanking content out from under a reader);
 * (3) an evicted row's in-flight reaction fetch resolving late does not
 * resurrect stale bookkeeping; (4) a fresh instance for a new room carries no
 * leaked state from a prior instance that had hit the cap; (5) normal
 * under-cap behaviour is unchanged.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { MessageList, MAX_LIVE_MESSAGES, MAX_LIVE_MESSAGES_HARD_CEILING } from '../ui/message-list.js';
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

// Captured subscribe callbacks — reset per makeMockClient() call.
let capturedOnMessage: ((row: MessageRow) => void) | null = null;
let capturedOnReaction: ((event: ReactionEvent) => void) | null = null;

function makeMockClient(
  rows: MessageRow[] = [],
  // Deliberately OPTIONAL — omitted entirely (not defaulted to a stub) unless a
  // test explicitly needs reactions. getReactions is an opt-in capability per
  // MessageListClient (`getReactions?(...)`); when absent, #handleNewMessage's
  // `if (this.#client.getReactions)` gate skips the whole reaction-fetch path.
  // That matters at N=MAX_LIVE_MESSAGES scale: #updateReactionCluster does a
  // pre-existing O(n) querySelectorAll+indexOf scan per call, so firing it once
  // per filler message would be O(n²) for tests that don't assert on reactions
  // at all (pre-existing cost in #updateReactionCluster — out of scope here).
  getReactionsImpl?: (roomId: string, msgId: string) => Promise<ReactionsResponse>,
): MessageListClient {
  capturedOnMessage = null;
  capturedOnReaction = null;
  const client: MessageListClient = {
    list: () => Promise.resolve({ items: rows, hasNext: false }),
    subscribe: (_roomId: string, args: {
      onMessage: (row: MessageRow) => void;
      onReaction?: (event: ReactionEvent) => void;
    }) => {
      capturedOnMessage = args.onMessage;
      capturedOnReaction = args.onReaction ?? null;
      return () => { /* unsubscribe */ };
    },
  };
  if (getReactionsImpl) {
    client.getReactions = getReactionsImpl;
  }
  return client;
}

/** Push `count` distinct live messages via the captured onMessage callback, id-prefixed. */
function pushMessages(prefix: string, count: number, startSeq = 1): void {
  for (let i = 0; i < count; i++) {
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: `${prefix}-${i}`, seq: startSeq + i }));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MessageList — live-message eviction', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    capturedOnMessage = null;
    capturedOnReaction = null;
  });

  function makeContainer(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.height = '400px';
    el.style.overflow = 'auto';
    document.body.appendChild(el);
    return el;
  }

  it('caps_order_and_dom_to_max_live_messages_when_pinned_to_bottom', async () => {
    container = makeContainer();
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // jsdom never lays out real content, so listEl's scrollHeight/clientHeight
    // default to 0 — shouldAutoScroll(0,0,0) is trivially "pinned". No scroll
    // simulation needed for the pinned-to-bottom case.
    const overflowBy = 5;
    pushMessages('m', MAX_LIVE_MESSAGES + overflowBy);
    await drainMicrotasks();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(MAX_LIVE_MESSAGES);

    // The oldest `overflowBy` messages must be gone…
    expect(container.querySelector('[data-msg-id="m-0"]')).toBeNull();
    expect(container.querySelector(`[data-msg-id="m-${overflowBy - 1}"]`)).toBeNull();
    // …the first surviving message is exactly the (overflowBy)-th pushed…
    expect(bubbles[0]!.getAttribute('data-msg-id')).toBe(`m-${overflowBy}`);
    // …and the most recently pushed message is still the last bubble (order preserved).
    const lastIdx = MAX_LIVE_MESSAGES + overflowBy - 1;
    expect(bubbles[bubbles.length - 1]!.getAttribute('data-msg-id')).toBe(`m-${lastIdx}`);

    ml.destroy();
  }, 30_000); // MAX_LIVE_MESSAGES filler messages each pay #updateReactionCluster's
  // pre-existing O(n) per-call scan — default 5s timeout is too tight under
  // CI load (passed locally, timed out on the shared self-hosted runner).

  it('skips_eviction_while_user_has_scrolled_up_reading_history', async () => {
    container = makeContainer();
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // Simulate "scrolled up": overrides must target #listEl (`.oxp-message-list`),
    // not the outer container — #isPinnedToBottom() reads from #listEl once mounted
    // (confirmed by the existing auto_scrolls_to_bottom_uses_listEl_not_container
    // test in message-list.test.ts). Overriding `container` instead would leave
    // #listEl's scrollHeight/clientHeight at jsdom's default 0/0, which reads as
    // trivially pinned regardless of what the test intended.
    const listEl = container.querySelector('.oxp-message-list') as HTMLElement;
    expect(listEl).not.toBeNull();
    Object.defineProperty(listEl, 'scrollHeight', { value: 10_000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    listEl.scrollTop = 0; // scrolled to the very top — far from "pinned to bottom"

    const overflowBy = 5;
    pushMessages('u', MAX_LIVE_MESSAGES + overflowBy);
    await drainMicrotasks();

    // Chosen behaviour (see PR body): skip eviction entirely for append cycles
    // where the user isn't pinned to bottom — evicting always targets the
    // oldest (top) end, exactly where a scrolled-up reader is looking, so
    // there's no "away from the viewport" region to evict from instead.
    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(MAX_LIVE_MESSAGES + overflowBy);
    expect(container.querySelector('[data-msg-id="u-0"]')).not.toBeNull();

    ml.destroy();
  }, 30_000); // Same O(n)-per-call reaction-cluster cost as the test above, at
  // MAX_LIVE_MESSAGES scale — default 5s timeout too tight under CI load.

  it('walk_away_case_still_evicts_once_the_hard_ceiling_is_crossed_while_unpinned', async () => {
    // Reviewer-flagged MAJOR (PR #41): a visitor who scrolls up once and
    // never returns to bottom saw #order/#rows/DOM grow WITHOUT LIMIT — the
    // soft MAX_LIVE_MESSAGES cap only ever trims on a pinned append, so it
    // never fired for that session. This proves the walk-away case is now
    // bounded at MAX_LIVE_MESSAGES_HARD_CEILING even while permanently
    // unpinned, while a normal-sized scrolled-up reading session (the
    // sibling test above, well under the ceiling) still isn't yanked.
    container = makeContainer();
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const listEl = container.querySelector('.oxp-message-list') as HTMLElement;
    Object.defineProperty(listEl, 'scrollHeight', { value: 10_000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    listEl.scrollTop = 0; // scrolled to the top, stays there for the whole test — never pinned

    const overflowBy = 7;
    pushMessages('w', MAX_LIVE_MESSAGES_HARD_CEILING + overflowBy);
    await drainMicrotasks();

    // Bounded at the hard ceiling — NOT unbounded (would be
    // MAX_LIVE_MESSAGES_HARD_CEILING + overflowBy if the walk-away gap were
    // still open), and NOT yanked all the way down to the tight
    // MAX_LIVE_MESSAGES soft cap either (that would over-punish a merely-large
    // reading session).
    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(MAX_LIVE_MESSAGES_HARD_CEILING);
    expect(container.querySelector('[data-msg-id="w-0"]')).toBeNull(); // oldest evicted
    const lastIdx = MAX_LIVE_MESSAGES_HARD_CEILING + overflowBy - 1;
    expect(container.querySelector(`[data-msg-id="w-${lastIdx}"]`)).not.toBeNull(); // newest survives

    ml.destroy();
  }, 60_000); // HARD_CEILING (600) is 2x the other tests' MAX_LIVE_MESSAGES
  // (300) scale, and #updateReactionCluster's per-message scan cost is O(n)
  // — double the headroom, not just matching, given CI already timed out
  // once at 30s for the smaller-scale siblings under load.

  it('evicted_rows_late_reaction_fetch_does_not_resurrect_stale_state', async () => {
    container = makeContainer();

    let resolveEvictedReactions!: (data: ReactionsResponse) => void;
    const heldOpen = new Promise<ReactionsResponse>((resolve) => {
      resolveEvictedReactions = resolve;
    });

    const client = makeMockClient([], (_roomId, msgId) =>
      msgId === 'evictee' ? heldOpen : Promise.resolve({ counts: {}, users: {}, truncated: false }),
    );
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // First live message — its getReactions() call is held open (not yet resolved).
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'evictee', seq: 1 }));
    // Push it out of the live window before its reaction fetch ever resolves.
    pushMessages('m', MAX_LIVE_MESSAGES, 2);
    await drainMicrotasks();
    expect(container.querySelector('[data-msg-id="evictee"]')).toBeNull(); // confirmed evicted

    // The stale fetch for the now-evicted row finally resolves.
    resolveEvictedReactions({ counts: { '👻': 7 }, users: { '👻': ['ghost'] }, truncated: false });
    await drainMicrotasks();

    // #reactions is a true private (#) field — there is no direct way to assert
    // "no residual entry" from outside the class. The one behaviourally-observable
    // proxy: #handleReaction reads #reactions.get(msgId) UNCONDITIONALLY (not
    // gated on #order membership), but only renders once the msgId is back in
    // #order. So: reuse the evicted msgId for a brand-new message (re-entering
    // #order), then fire a live reaction event for it *synchronously*, before its
    // own fresh getReactions() microtask can run. If the guard is missing, the
    // stale 👻 entry leaked back into #reactions and #handleReaction seeds its
    // merge from it; if the guard held, #handleReaction seeds from a clean slate.
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'evictee', seq: MAX_LIVE_MESSAGES + 2 }));
    expect(capturedOnReaction).not.toBeNull();
    capturedOnReaction!({ msgId: 'evictee', emoji: '🎉', op: 'add', userUid: 'u9', totalCount: 1 });

    const bubble = container.querySelector('[data-msg-id="evictee"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    const chips = bubble!.querySelectorAll('.oxp-reaction-chip');
    expect(chips.length).toBe(1); // only the fresh reaction — no leaked 👻 from the evicted incarnation
    expect(bubble!.querySelector('[data-emoji="🎉"]')).not.toBeNull();
    expect(bubble!.querySelector('[data-emoji="👻"]')).toBeNull();

    ml.destroy();
  }, 30_000); // MAX_LIVE_MESSAGES filler messages each pay #updateReactionCluster's
  // pre-existing O(n) per-call scan (getReactions is genuinely needed here,
  // unlike the other tests in this file) — default 5s timeout is too tight.

  it('fresh_instance_for_a_new_room_has_no_leaked_state_from_a_prior_evicting_instance', async () => {
    container = makeContainer();

    // MessageList's #roomId is constructor-immutable (set once, never reassigned) —
    // a real room switch is a fresh instance at the element.ts layer, not an
    // in-place reset. This proves eviction bookkeeping lives purely on the
    // instance, not on any module/shared state that could bleed across rooms.
    const roomAClient = makeMockClient([]);
    const roomA = new MessageList({ client: roomAClient, roomId: 'room-a', container, lang: 'en', selfUid: 'u1' });
    await roomA.mount();
    pushMessages('a', MAX_LIVE_MESSAGES + 5);
    await drainMicrotasks();
    expect(container.querySelectorAll('[role="article"]').length).toBe(MAX_LIVE_MESSAGES);
    roomA.destroy();
    expect(container.querySelector('.oxp-message-list')).toBeNull();

    // Fresh room, fresh instance, small dataset well under the cap — also covers
    // "the eviction constant doesn't fight the initial fetch" (50-row cap default
    // is well under MAX_LIVE_MESSAGES, so mount-time #fetchAndRender never evicts).
    const roomBRows = [
      makeRow({ senderUid: 'u2', msgId: 'b-0', seq: 1 }),
      makeRow({ senderUid: 'u2', msgId: 'b-1', seq: 2 }),
    ];
    const roomBClient = makeMockClient(roomBRows);
    const roomB = new MessageList({ client: roomBClient, roomId: 'room-b', container, lang: 'en', selfUid: 'u1' });
    await roomB.mount();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(2); // only room B's rows — no residue from room A
    expect(container.querySelector('[data-msg-id="a-0"]')).toBeNull();
    expect(container.querySelector('[data-msg-id="b-0"]')).not.toBeNull();
    expect(container.querySelector('[data-msg-id="b-1"]')).not.toBeNull();

    roomB.destroy();
  });

  it('does_not_evict_when_under_the_cap', async () => {
    container = makeContainer();
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const n = 50; // well under MAX_LIVE_MESSAGES (300) — regression guard
    pushMessages('n', n);
    await drainMicrotasks();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(n);
    expect(container.querySelector('[data-msg-id="n-0"]')).not.toBeNull(); // oldest still present

    ml.destroy();
  });

  // ── issue #67 review fix (MAJOR): attachment blob: URL revoked on eviction ──

  it('revokes an evicted row\'s hydrated attachment blob: URL, but not a retained row\'s', async () => {
    // Review finding: #attachmentObjectUrls was a flat Set revoked only in
    // destroy() — #evictOldMessages tears down reaction triggers/pulse timers/
    // DOM for an evicted row but never revoked ITS blob: URL, so a long-lived
    // busy room leaked one decoded image per evicted attachment message
    // (unbounded — exactly the class the surrounding eviction caps exist to
    // bound). Fix: track blob: URLs per msgId, revoke in #evictOldMessages.
    container = makeContainer();

    let urlCounter = 0;
    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:mock-${urlCounter++}`;
      createdUrls.push(url);
      return url;
    });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revokedUrls.push(url);
    });

    const client = makeMockClient([]);
    client.fetchAttachmentBlob = async () => new Blob(['x'], { type: 'image/png' });

    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const attachment = {
      id: 'a1', url: 'https://x.example/api/sdk/attachments/a1',
      mime: 'image/png', filename: 'f.png', sizeBytes: 10,
    };

    // Oldest message — carries an attachment, will be evicted below.
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'evictee-att', seq: 1, attachments: [attachment] }));
    await drainMicrotasks();
    expect(createdUrls.length).toBe(1); // hydration created exactly one blob: URL so far

    // Push past the cap — evicts 'evictee-att' (the oldest).
    pushMessages('filler', MAX_LIVE_MESSAGES, 2);
    await drainMicrotasks();
    expect(container.querySelector('[data-msg-id="evictee-att"]')).toBeNull(); // confirmed evicted

    // A retained (newest) row also carries a hydrated attachment.
    capturedOnMessage!(makeRow({
      senderUid: 'u1', msgId: 'retained-att', seq: MAX_LIVE_MESSAGES + 2, attachments: [attachment],
    }));
    await drainMicrotasks();
    expect(createdUrls.length).toBe(2);

    expect(revokedUrls).toContain(createdUrls[0]); // evicted row's URL: revoked
    expect(revokedUrls).not.toContain(createdUrls[1]); // retained row's URL: still alive

    ml.destroy();
    expect(revokedUrls).toContain(createdUrls[1]); // destroy() sweeps whatever's left

    createSpy.mockRestore();
    revokeSpy.mockRestore();
  }, 30_000); // MAX_LIVE_MESSAGES filler messages, same headroom as the sibling tests above.

  // ── F12: dedup-Set eviction sweep (#firedDecryptErrors + #firedAttachmentErrors) ──
  // These two Sets accumulated one entry per failed msgId and were cleared ONLY
  // in destroy() — unlike every sibling per-msgId Map which is swept in
  // #evictOldMessages. Without eviction sweeping, a long-lived busy room leaks
  // one Set entry per evicted failed message (unbounded — exactly the class
  // the eviction caps exist to bound), AND a msgId recycled after eviction
  // (re-entering #order as a new message) would be wrongly suppressed by the
  // stale dedup entry. The fix: delete the evicted msgId's entries from both
  // Sets in #evictOldMessages, matching how the sibling Maps are pruned. The
  // dedup contract is preserved: a still-live message's entry is never touched
  // here, so it never re-fires on re-render.

  it('sweeps #firedDecryptErrors entry for an evicted msgId; re-entry re-fires, retained still dedupes', async () => {
    container = makeContainer();
    const decryptErrors: Array<{ msgId: string; seq: number; reason: string }> = [];
    const client = makeMockClient([]);
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onDecryptError: (msgId, seq, reason) => decryptErrors.push({ msgId, seq, reason: String(reason) }),
    });
    await ml.mount();

    // 1. Send a message with unsealError → callback fires once.
    const evicteeId = 'msg-decrypt-evictee';
    capturedOnMessage!(makeRow({ senderUid: 'u2', msgId: evicteeId, seq: 1, unsealError: 'replay' }));
    await drainMicrotasks();
    expect(decryptErrors).toHaveLength(1);
    expect(decryptErrors[0]!.msgId).toBe(evicteeId);

    // 2. Re-deliver the same msgId (mutation SSE / dedupe upsert) → deduped.
    capturedOnMessage!(makeRow({ senderUid: 'u2', msgId: evicteeId, seq: 1, unsealError: 'replay' }));
    await drainMicrotasks();
    expect(decryptErrors).toHaveLength(1);

    // 3. Push past the cap — evicts evicteeId (the oldest).
    pushMessages('filler', MAX_LIVE_MESSAGES, 2);
    await drainMicrotasks();
    expect(container.querySelector(`[data-msg-id="${evicteeId}"]`)).toBeNull();

    // 4. Re-deliver the same msgId as a NEW message (re-entering #order) →
    //    the dedup entry was swept on eviction, so the callback MUST fire again.
    //    Reverting the eviction sweep makes this assertion fail (stale entry
    //    suppresses the re-fire) — the falsifiable RED-on-revert guard.
    capturedOnMessage!(makeRow({ senderUid: 'u2', msgId: evicteeId, seq: MAX_LIVE_MESSAGES + 2, unsealError: 'replay' }));
    await drainMicrotasks();
    expect(decryptErrors).toHaveLength(2);
    expect(decryptErrors[1]!.msgId).toBe(evicteeId);

    // 5. A distinct retained msgId still dedupes correctly (contract preserved).
    const retainedId = 'msg-decrypt-retained';
    capturedOnMessage!(makeRow({ senderUid: 'u2', msgId: retainedId, seq: MAX_LIVE_MESSAGES + 3, unsealError: 'auth' }));
    await drainMicrotasks();
    expect(decryptErrors).toHaveLength(3);
    capturedOnMessage!(makeRow({ senderUid: 'u2', msgId: retainedId, seq: MAX_LIVE_MESSAGES + 3, unsealError: 'auth' }));
    await drainMicrotasks();
    expect(decryptErrors).toHaveLength(3); // deduped — retained entry NOT swept

    ml.destroy();
  }, 30_000);

  it('sweeps #firedAttachmentErrors entry for an evicted msgId; re-entry re-fires, retained still dedupes', async () => {
    container = makeContainer();
    const attErrors: Array<{ msgId: string; attachmentId: string }> = [];
    const client = makeMockClient([]);
    // Permanent 404 → exactly 1 fetch, no retry, onAttachmentError fires in the
    // .catch microtask (no setTimeout involved for permanent failures).
    client.fetchAttachmentBlob = async () => {
      const err = Object.assign(new Error('HTTP 404'), { status: 404 });
      throw err;
    };
    const attachment = {
      id: 'att-evict-1', url: 'https://x.example/api/sdk/attachments/att-evict-1',
      mime: 'image/png', filename: 'f.png', sizeBytes: 10,
    };
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAttachmentError: (msgId, attachmentId) => attErrors.push({ msgId, attachmentId }),
    });
    await ml.mount();

    // 1. Send a message with an attachment that fails hydration (404) → fires once.
    const evicteeId = 'msg-att-evictee';
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: evicteeId, seq: 1, attachments: [attachment] }));
    await drainMicrotasks(20);
    expect(attErrors).toHaveLength(1);
    expect(attErrors[0]!.msgId).toBe(evicteeId);

    // 2. Re-deliver the same msgId → deduped.
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: evicteeId, seq: 1, attachments: [attachment] }));
    await drainMicrotasks(20);
    expect(attErrors).toHaveLength(1);

    // 3. Push past the cap — evicts evicteeId (the oldest).
    pushMessages('filler', MAX_LIVE_MESSAGES, 2);
    await drainMicrotasks();
    expect(container.querySelector(`[data-msg-id="${evicteeId}"]`)).toBeNull();

    // 4. Re-deliver the same msgId as a NEW message → the dedup entry was swept
    //    on eviction, so the callback MUST fire again. Reverting the eviction
    //    sweep makes this assertion fail — the falsifiable RED-on-revert guard.
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: evicteeId, seq: MAX_LIVE_MESSAGES + 2, attachments: [attachment] }));
    await drainMicrotasks(20);
    expect(attErrors).toHaveLength(2);
    expect(attErrors[1]!.msgId).toBe(evicteeId);

    // 5. A distinct retained msgId still dedupes correctly (contract preserved).
    const retainedId = 'msg-att-retained';
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: retainedId, seq: MAX_LIVE_MESSAGES + 3, attachments: [attachment] }));
    await drainMicrotasks(20);
    expect(attErrors).toHaveLength(3);
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: retainedId, seq: MAX_LIVE_MESSAGES + 3, attachments: [attachment] }));
    await drainMicrotasks(20);
    expect(attErrors).toHaveLength(3); // deduped — retained entry NOT swept

    ml.destroy();
  }, 30_000);
});
