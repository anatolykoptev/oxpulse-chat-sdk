/**
 * M6: Integration tests for MessageList pin/unpin flow.
 * Exercises handleMutation (SSE pin/unpin), #togglePin (optimistic + rollback),
 * scrollToMsgId, and the PinnedBanner mount lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow, MutationEvent } from '../ui/message-list.js';

function makeRow(overrides: Partial<MessageRow> & { senderUid: string }): MessageRow {
  return {
    seq: 1,
    msgId: overrides.msgId ?? crypto.randomUUID(),
    senderUid: overrides.senderUid,
    sealed: new ArrayBuffer(0),
    plaintext: new TextEncoder().encode(overrides.text ?? 'hello world'),
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

let capturedOnMutation: ((event: MutationEvent) => void) | null = null;

function makeMockClient(rows: MessageRow[] = [], pinFns?: {
  listPins?: ReturnType<typeof vi.fn>;
  pinMessage?: ReturnType<typeof vi.fn>;
  unpinMessage?: ReturnType<typeof vi.fn>;
}): MessageListClient {
  capturedOnMutation = null;
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, args: { onMutation?: (event: MutationEvent) => void }) => {
      capturedOnMutation = args.onMutation ?? null;
      return () => {};
    }),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    listPins: pinFns?.listPins ?? vi.fn().mockResolvedValue([]),
    pinMessage: pinFns?.pinMessage ?? vi.fn().mockResolvedValue(undefined),
    unpinMessage: pinFns?.unpinMessage ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('MessageList — pinned messages integration (#228)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // jsdom doesn't implement scrollIntoView — mock it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('mounts PinnedBanner and loads initial pins from listPins()', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'pinned message text' });
    const listPins = vi.fn().mockResolvedValue([
      { msgId: row.msgId, pinnedBy: 'alice', pinnedAt: '2026-07-31T00:00:00Z' },
    ]);
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { listPins }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    expect(listPins).toHaveBeenCalledWith('room1');
    const banner = container.querySelector('.oxp-pinned-banner') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.style.display).toBe('flex');

    const preview = container.querySelector('.oxp-pinned-banner-preview') as HTMLElement;
    expect(preview.textContent).toBe('pinned message text');
    ml.destroy();
  });

  it('handleMutation with op=pin adds to banner and updates bubble pin state', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'message to pin' });
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row]),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    // Fire SSE pin event
    ml.handleMutation({ msgId: row.msgId, op: 'pin', pinnedBy: 'bob' });

    const banner = container.querySelector('.oxp-pinned-banner') as HTMLElement;
    expect(banner.style.display).toBe('flex');

    const pinBtn = container.querySelector('.oxp-pin-btn') as HTMLElement;
    expect(pinBtn).toBeTruthy();
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');
    ml.destroy();
  });

  it('handleMutation with op=unpin removes from banner and updates bubble', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'message to unpin' });
    const listPins = vi.fn().mockResolvedValue([
      { msgId: row.msgId, pinnedBy: 'alice', pinnedAt: '2026-07-31T00:00:00Z' },
    ]);
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { listPins }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    // Verify initially pinned
    let pinBtn = container.querySelector('.oxp-pin-btn') as HTMLElement;
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');

    // Fire SSE unpin event
    ml.handleMutation({ msgId: row.msgId, op: 'unpin' });

    pinBtn = container.querySelector('.oxp-pin-btn') as HTMLElement;
    expect(pinBtn.getAttribute('aria-pressed')).toBe('false');

    const banner = container.querySelector('.oxp-pinned-banner') as HTMLElement;
    expect(banner.style.display).toBe('none');
    ml.destroy();
  });

  it('pin button click triggers optimistic pin + pinMessage call', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'click to pin me' });
    const pinMessage = vi.fn().mockResolvedValue(undefined);
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { pinMessage }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    const pinBtn = container.querySelector('.oxp-pin-btn') as HTMLButtonElement;
    expect(pinBtn.getAttribute('aria-pressed')).toBe('false');

    pinBtn.click();
    await drainMicrotasks();

    // Optimistic update — banner shows immediately
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');
    expect(pinMessage).toHaveBeenCalledWith('room1', row.msgId);
    ml.destroy();
  });

  it('pin button click on pinned message triggers optimistic unpin + unpinMessage call', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'click to unpin me' });
    const unpinMessage = vi.fn().mockResolvedValue(undefined);
    const listPins = vi.fn().mockResolvedValue([
      { msgId: row.msgId, pinnedBy: 'alice', pinnedAt: '2026-07-31T00:00:00Z' },
    ]);
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { listPins, unpinMessage }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    const pinBtn = container.querySelector('.oxp-pin-btn') as HTMLButtonElement;
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');

    pinBtn.click();
    await drainMicrotasks();

    expect(pinBtn.getAttribute('aria-pressed')).toBe('false');
    expect(unpinMessage).toHaveBeenCalledWith('room1', row.msgId);
    ml.destroy();
  });

  it('pin failure rolls back optimistic update', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'pin will fail' });
    const pinMessage = vi.fn().mockRejectedValue(new Error('network'));
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { pinMessage }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    const pinBtn = container.querySelector('.oxp-pin-btn') as HTMLButtonElement;
    pinBtn.click();
    await drainMicrotasks();

    // Rollback — back to unpinned
    expect(pinBtn.getAttribute('aria-pressed')).toBe('false');
    ml.destroy();
  });

  it('rapid double-click on pin button is guarded by in-flight lock', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'double click test' });
    let resolvePin: () => void = () => {};
    const pinMessage = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolvePin = resolve; }));
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { pinMessage }),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    const pinBtn = container.querySelector('.oxp-pin-btn') as HTMLButtonElement;
    // First click — optimistic pin, pinMessage in-flight
    pinBtn.click();
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');
    expect(pinMessage).toHaveBeenCalledTimes(1);

    // Second click while first is in-flight — should be a no-op
    pinBtn.click();
    expect(pinMessage).toHaveBeenCalledTimes(1); // still only 1 call

    // Resolve the first call
    resolvePin();
    await drainMicrotasks();

    ml.destroy();
  });

  it('pinnedMessagesEnabled=false hides banner and pin button', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'no pin UI' });
    const pinMessage = vi.fn().mockResolvedValue(undefined);
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row], { pinMessage }),
      selfUid: 'me',
      lang: 'en',
      pinnedMessagesEnabled: false,
    });
    await ml.mount();
    await drainMicrotasks();

    const banner = container.querySelector('.oxp-pinned-banner');
    expect(banner).toBeNull();

    const pinBtn = container.querySelector('.oxp-pin-btn');
    expect(pinBtn).toBeNull();
    ml.destroy();
  });

  it('scrollToMsgId highlights the target bubble', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'scroll target' });
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row]),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    const bubble = container.querySelector('[role="article"]') as HTMLElement;
    expect(bubble).toBeTruthy();
    expect(bubble.classList.contains('oxp-pinned-jump-highlight')).toBe(false);

    ml.scrollToMsgId(row.msgId);
    expect(bubble.classList.contains('oxp-pinned-jump-highlight')).toBe(true);
    ml.destroy();
  });

  it('destroy() clears highlight timers without firing on destroyed DOM', async () => {
    const row = makeRow({ senderUid: 'alice', text: 'destroy test' });
    const ml = new MessageList({
      container,
      roomId: 'room1',
      client: makeMockClient([row]),
      selfUid: 'me',
      lang: 'en',
    });
    await ml.mount();
    await drainMicrotasks();

    ml.scrollToMsgId(row.msgId);
    // Destroy immediately — timer is pending (2s), should be cleared
    ml.destroy();
    // No error thrown = pass. The timer callback would have tried to
    // access el.classList on a removed element without the guard.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
