/**
 * message-list-send-failed.test.ts — D1/D2: send-failed bubble rendering.
 *
 * F3: When an upload fails while the page is open, the message bubble must
 * render a failure state with a retry affordance. The `oxpulse-chat:send-failed`
 * event is dispatched by element.ts; the MessageList's `markSendFailed` method
 * updates the row and re-renders the bubble.
 *
 * Mutation: remove the `oxpulse-chat:send-failed` listener in element.ts
 * (or remove the `markSendFailed` call) → RED (the bubble never shows the
 * failed state, no retry button appears).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';
import { THEME_CSS } from '../ui/theme.js';

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

function makeMockClient(rows: MessageRow[] = []): MessageListClient {
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, _args: {
      onMessage: (row: MessageRow) => void;
    }) => () => { /* unsubscribe */ }),
  };
}

// ── Mock ResizeObserver (same as message-list.test.ts) ────────────────────────

interface MockRoInstance {
  readonly observedElements: Element[];
  disconnected: boolean;
  trigger(): void;
}

function installMockResizeObserver(): { getLastInstance: () => MockRoInstance | null } {
  const instances: MockRoInstance[] = [];
  class MockResizeObserver {
    #callback: ResizeObserverCallback;
    observedElements: Element[] = [];
    disconnected = false;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
      instances.push(this);
    }
    observe(el: Element) { this.observedElements.push(el); }
    unobserve(_el: Element) { /* no-op */ }
    disconnect() { this.disconnected = true; }
    trigger() { this.#callback(this.observedElements, this); }
  }
  const orig = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  return {
    getLastInstance: () => instances[instances.length - 1] ?? null,
  };
}

describe('MessageList — send-failed (D2/F3)', () => {
  let container: HTMLElement;
  let mockClient: MessageListClient;
  let origRO: unknown;
  let roHelper: ReturnType<typeof installMockResizeObserver>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = `<style>${THEME_CSS}</style><div id="list"></div>`;
    mockClient = makeMockClient();
    roHelper = installMockResizeObserver();
    origRO = globalThis.ResizeObserver;
  });

  afterEach(() => {
    container.remove();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = origRO;
    vi.restoreAllMocks();
  });

  it('F3_markSendFailed_renders_failed_bubble_with_retry_and_dismiss', async () => {
    const retryCalls: string[] = [];
    const dismissCalls: string[] = [];

    const selfUid = 'user-self';
    const row = makeRow({
      senderUid: selfUid,
      text: 'my photo caption',
      msgId: 'msg-fail-1',
    });

    const ml = new MessageList({
      client: mockClient,
      roomId: 'room-1',
      container: container.querySelector('#list') as HTMLElement,
      selfUid,
      onRetrySendFailed: (msgId: string) => retryCalls.push(msgId),
      onDismissFailedMessage: (msgId: string) => dismissCalls.push(msgId),
    });
    await ml.mount();

    // Insert the optimistic row (simulates the composer's optimistic echo).
    ml.handleMessage(row);

    // Verify the bubble renders normally first (no send-failed state).
    let bubble = container.querySelector('[data-msg-id="msg-fail-1"]') as HTMLElement;
    expect(bubble).toBeTruthy();
    expect(bubble.getAttribute('data-send-failed')).toBeNull();

    // Mark the message as send-failed (simulates the send-failed listener firing).
    ml.markSendFailed('msg-fail-1', 'Upload failed', true);

    // The bubble now has the data-send-failed attribute.
    bubble = container.querySelector('[data-msg-id="msg-fail-1"]') as HTMLElement;
    expect(bubble.getAttribute('data-send-failed')).toBe('true');

    // The failure notice is rendered.
    const failEl = bubble.querySelector('.oxp-send-failed');
    expect(failEl).toBeTruthy();

    // The reason text is rendered.
    const reasonEl = failEl!.querySelector('.oxp-send-failed-reason');
    expect(reasonEl).toBeTruthy();
    expect(reasonEl!.textContent).toContain('Upload failed');

    // The retry button is rendered (retryable=true).
    const retryBtn = failEl!.querySelector('.oxp-send-failed-retry') as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    // The dismiss button is rendered.
    const dismissBtn = failEl!.querySelector('.oxp-send-failed-dismiss') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();

    // Click retry → onRetrySendFailed fires.
    retryBtn.click();
    expect(retryCalls).toEqual(['msg-fail-1']);

    // Click dismiss → onDismissFailedMessage fires.
    dismissBtn.click();
    expect(dismissCalls).toEqual(['msg-fail-1']);

    ml.destroy();
  });

  it('F3_non_retryable_failed_bubble_shows_dismiss_only', async () => {
    const retryCalls: string[] = [];
    const dismissCalls: string[] = [];

    const selfUid = 'user-self';
    const row = makeRow({
      senderUid: selfUid,
      text: 'interrupted caption',
      msgId: 'msg-fail-2',
    });

    const ml = new MessageList({
      client: mockClient,
      roomId: 'room-1',
      container: container.querySelector('#list') as HTMLElement,
      selfUid,
      onRetrySendFailed: (msgId: string) => retryCalls.push(msgId),
      onDismissFailedMessage: (msgId: string) => dismissCalls.push(msgId),
    });
    await ml.mount();

    ml.handleMessage(row);

    // Mark as non-retryable (reload case — blob is gone).
    ml.markSendFailed('msg-fail-2', 'Upload interrupted', false);

    const bubble = container.querySelector('[data-msg-id="msg-fail-2"]') as HTMLElement;
    const failEl = bubble.querySelector('.oxp-send-failed');
    expect(failEl).toBeTruthy();

    // No retry button (non-retryable).
    const retryBtn = failEl!.querySelector('.oxp-send-failed-retry');
    expect(retryBtn).toBeNull();

    // Dismiss button is present.
    const dismissBtn = failEl!.querySelector('.oxp-send-failed-dismiss') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();
    dismissBtn.click();
    expect(dismissCalls).toEqual(['msg-fail-2']);

    ml.destroy();
  });

  it('F3_removeRow_removes_bubble_from_dom', async () => {
    const selfUid = 'user-self';
    const row = makeRow({
      senderUid: selfUid,
      text: 'to be dismissed',
      msgId: 'msg-fail-3',
    });

    const ml = new MessageList({
      client: mockClient,
      roomId: 'room-1',
      container: container.querySelector('#list') as HTMLElement,
      selfUid,
    });
    await ml.mount();

    ml.handleMessage(row);
    expect(container.querySelector('[data-msg-id="msg-fail-3"]')).toBeTruthy();

    ml.removeRow('msg-fail-3');
    expect(container.querySelector('[data-msg-id="msg-fail-3"]')).toBeNull();

    ml.destroy();
  });
});
