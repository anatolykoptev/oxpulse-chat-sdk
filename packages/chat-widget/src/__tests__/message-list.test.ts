/**
 * message-list.test.ts — TDD RED phase (W2.2 slice 1)
 *
 * Tests: MessageList class — history fetch, live updates, chaining, tombstone, scroll.
 * Cases per W2.2 spec:
 *  1. renders_initial_history_from_client_list
 *  2. appends_new_message_on_onMessage_callback
 *  3. chains_consecutive_messages_from_same_sender_within_5min (using 4-min window from helper)
 *  4. breaks_chain_on_different_sender
 *  5. renders_tombstone_for_deleted_message
 *  6. auto_scrolls_to_bottom_on_initial_mount
 *  7. preserves_scroll_position_when_user_scrolled_up
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';

// ── SDK mock helpers ──────────────────────────────────────────────────────────

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

// Captured subscribe callbacks
let capturedOnMessage: ((row: MessageRow) => void) | null = null;
let capturedOnMutation: ((event: { msgId: string; op: string; deletedAt?: string }) => void) | null = null;

function makeMockClient(rows: MessageRow[] = []): MessageListClient {
  capturedOnMessage = null;
  capturedOnMutation = null;
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, args: {
      onMessage: (row: MessageRow) => void;
      onMutation?: (event: { msgId: string; op: string; deletedAt?: string }) => void;
    }) => {
      capturedOnMessage = args.onMessage;
      capturedOnMutation = args.onMutation ?? null;
      return () => { /* unsubscribe */ };
    }),
  };
}

// ── Mock ResizeObserver ───────────────────────────────────────────────────────
// jsdom does not implement ResizeObserver (confirmed empirically under this
// project's vitest jsdom environment). Same "stub the global, expose a way to
// fire the callback" shape as packages/chat-sdk/src/__tests__/helpers.ts's
// MockES for EventSource.

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

    observe(el: Element): void {
      this.observedElements.push(el);
    }

    unobserve(el: Element): void {
      this.observedElements = this.observedElements.filter((e) => e !== el);
    }

    disconnect(): void {
      this.disconnected = true;
    }

    trigger(): void {
      this.#callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
  }

  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  return { getLastInstance: () => instances[instances.length - 1] ?? null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MessageList', () => {
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
    capturedOnMutation = null;
  });

  it('renders_initial_history_from_client_list', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1 }),
      makeRow({ senderUid: 'u2', seq: 2 }),
      makeRow({ senderUid: 'u1', seq: 3 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(3);
    ml.destroy();
  });

  it('appends_new_message_on_onMessage_callback', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1 }),
      makeRow({ senderUid: 'u2', seq: 2 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // Simulate live message arriving
    expect(capturedOnMessage).not.toBeNull();
    capturedOnMessage!(makeRow({ senderUid: 'u1', seq: 3 }));
    await new Promise((r) => setTimeout(r, 0));

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(3);
    ml.destroy();
  });

  it('chains_consecutive_messages_from_same_sender_within_4min', async () => {
    const now = Date.now();
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, createdAt: new Date(now).toISOString() }),
      makeRow({ senderUid: 'u1', seq: 2, createdAt: new Date(now + 60_000).toISOString() }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(2);
    // Second bubble should have data-chained="true" (reduced margin)
    const second = bubbles[1] as HTMLElement;
    expect(second.getAttribute('data-chained')).toBe('true');
    ml.destroy();
  });

  it('breaks_chain_on_different_sender', async () => {
    const now = Date.now();
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, createdAt: new Date(now).toISOString() }),
      makeRow({ senderUid: 'u2', seq: 2, createdAt: new Date(now + 60_000).toISOString() }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(2);
    const second = bubbles[1] as HTMLElement;
    // Different sender → not chained
    expect(second.getAttribute('data-chained')).not.toBe('true');
    ml.destroy();
  });

  it('renders_tombstone_for_deleted_message', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, deletedAt: new Date().toISOString() }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    // Should show tombstone text, not original body
    expect(bubble!.textContent).toContain('This message was deleted');
    ml.destroy();
  });

  it('renders_distinct_placeholder_for_failed_decrypt_message', async () => {
    const rows = [
      makeRow({ senderUid: 'u2', seq: 1, plaintext: undefined, text: undefined, unsealError: 'auth' }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    // U2: failed-decrypt row must render a distinct, non-empty placeholder — never raw/empty content.
    expect(bubble!.querySelector('.oxp-unseal-error')).not.toBeNull();
    expect(bubble!.textContent).toContain("couldn't be decrypted");
    // Must not fall through to the normal empty-body render path.
    expect(bubble!.querySelector('.oxp-bubble-body')?.innerHTML).not.toBe('');
    // a11y: bubble aria-label must announce the failure, not read as empty.
    expect(bubble!.getAttribute('aria-label')).toContain("couldn't be decrypted");
    ml.destroy();
  });

  it('renders_normal_bubble_unchanged_when_unsealError_absent', async () => {
    const rows = [makeRow({ senderUid: 'u1', seq: 1, text: 'hello world' })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-unseal-error')).toBeNull();
    expect(bubble!.textContent).toContain('hello world');
    ml.destroy();
  });

  it('tombstone_wins_over_unsealError_in_body_and_aria_when_both_set', async () => {
    // design-quality-reviewer MUST-FIX: body render and aria-label priority
    // must agree — a row can theoretically carry both deletedAt (a later
    // mutation) and unsealError (from the original unseal attempt).
    const rows = [
      makeRow({
        senderUid: 'u2',
        seq: 1,
        plaintext: undefined,
        text: undefined,
        unsealError: 'auth',
        deletedAt: new Date().toISOString(),
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-tombstone')).not.toBeNull();
    expect(bubble!.querySelector('.oxp-unseal-error')).toBeNull();
    expect(bubble!.textContent).toContain('This message was deleted');
    // aria-label must match what's visually shown — not announce a different state.
    expect(bubble!.getAttribute('aria-label')).toContain('This message was deleted');
    expect(bubble!.getAttribute('aria-label')).not.toContain("couldn't be decrypted");
    ml.destroy();
  });

  it('aria_label_resyncs_on_live_dedupe_reclassification_to_unsealError', async () => {
    // review-fix HIGH#1: aria-label is computed ONLY in #createBubble; every live
    // re-render (#updateBubble, via #handleNewMessage's dedupe path or
    // #handleMutation) must ALSO refresh it, or a screen reader keeps announcing
    // stale plaintext after the SDK reclassifies the row as unseal-failed
    // (exactly the list()/subscribe decrypt-preserve mechanism this PR targets).
    const fixedId = 'fixed-msg-1';
    const rows = [makeRow({ senderUid: 'u2', seq: 1, msgId: fixedId, text: 'original plaintext' })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    let bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble!.getAttribute('aria-label')).toContain('original plaintext');

    // Live redelivery of the SAME msgId, now flagged unsealError (dedupe/upsert path).
    expect(capturedOnMessage).not.toBeNull();
    capturedOnMessage!(
      makeRow({ senderUid: 'u2', seq: 1, msgId: fixedId, plaintext: undefined, text: undefined, unsealError: 'replay' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble!.querySelector('.oxp-unseal-error')).not.toBeNull();
    expect(bubble!.getAttribute('aria-label')).toContain("couldn't be decrypted");
    expect(bubble!.getAttribute('aria-label')).not.toContain('original plaintext');
    ml.destroy();
  });

  it('aria_label_resyncs_on_live_mutation_event', async () => {
    // review-fix HIGH#1: same staleness gap via #handleMutation (delete/edit SSE).
    const fixedId = 'fixed-msg-2';
    const rows = [makeRow({ senderUid: 'u2', seq: 1, msgId: fixedId, text: 'original plaintext' })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    let bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble!.getAttribute('aria-label')).toContain('original plaintext');

    expect(capturedOnMutation).not.toBeNull();
    capturedOnMutation!({ msgId: fixedId, op: 'delete', deletedAt: new Date().toISOString() });

    bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble!.querySelector('.oxp-tombstone')).not.toBeNull();
    expect(bubble!.getAttribute('aria-label')).toContain('This message was deleted');
    expect(bubble!.getAttribute('aria-label')).not.toContain('original plaintext');
    ml.destroy();
  });

  it('auto_scrolls_to_bottom_on_initial_mount', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1 }),
      makeRow({ senderUid: 'u2', seq: 2 }),
      makeRow({ senderUid: 'u1', seq: 3 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // In jsdom, scrollTop is set directly on the container
    // We assert it equals scrollHeight (pinned to bottom)
    expect(container.scrollTop).toBe(container.scrollHeight);
    ml.destroy();
  });

  it('mount_aborted_mid_await_does_not_subscribe', async () => {
    // C1: signal.aborted check after list() resolves — subscribe must not be called
    let resolveList!: (v: { items: MessageRow[]; hasNext: boolean }) => void;
    const slowClient: MessageListClient = {
      list: vi.fn().mockReturnValue(new Promise((r) => { resolveList = r; })),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const ctrl = new AbortController();
    const ml = new MessageList({ client: slowClient, roomId: 'r1', container, lang: 'en', selfUid: 'u1', signal: ctrl.signal });
    const mountPromise = ml.mount();
    // destroy() while list() is still pending
    ml.destroy();
    // Now resolve list — mount should bail before subscribe
    resolveList({ items: [], hasNext: false });
    await mountPromise;
    expect(slowClient.subscribe).not.toHaveBeenCalled();
  });

  it('dedupes_replayed_messages_by_msgid', async () => {
    // C2: same msgId pushed twice via onMessage → single bubble
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const row = makeRow({ senderUid: 'u1', seq: 1, msgId: 'fixed-id-1' });
    capturedOnMessage!(row);
    capturedOnMessage!(row); // replay
    await new Promise((r) => setTimeout(r, 0));

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(1);
    ml.destroy();
  });

  it('chains_at_3min_59sec', async () => {
    // C4 boundary: 239_000ms → chained
    const now = Date.now();
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, createdAt: new Date(now).toISOString() }),
      makeRow({ senderUid: 'u1', seq: 2, createdAt: new Date(now + 239_000).toISOString() }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    const bubbles = container.querySelectorAll('[role="article"]');
    const second = bubbles[1] as HTMLElement;
    expect(second.getAttribute('data-chained')).toBe('true');
    ml.destroy();
  });

  it('breaks_at_4min_01sec', async () => {
    // C4 boundary: 241_000ms → not chained
    const now = Date.now();
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, createdAt: new Date(now).toISOString() }),
      makeRow({ senderUid: 'u1', seq: 2, createdAt: new Date(now + 241_000).toISOString() }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    const bubbles = container.querySelectorAll('[role="article"]');
    const second = bubbles[1] as HTMLElement;
    expect(second.getAttribute('data-chained')).not.toBe('true');
    ml.destroy();
  });

  it('bubble_has_aria_label_with_sender_time_body', async () => {
    // B4: aria-label on bubble article element
    const row = makeRow({ senderUid: 'u1', seq: 1, text: 'Hello world' });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    const label = bubble!.getAttribute('aria-label');
    expect(label).not.toBeNull();
    // Should include sender, time, and body excerpt.
    // T18: own messages (selfUid === senderUid) render as "You" in aria-label.
    expect(label).toContain('You');
    expect(label).toContain('Hello world');
    ml.destroy();
  });

  it('empty selfUid never false-positives as self, even against a row with an empty senderUid (Bug 2 — see list-helpers.isSelf)', async () => {
    // Wiring-proof: fails if #createBubble/#populateBubble/#ariaLabelFor ever
    // revert to the bare `row.senderUid === this.#selfUid` compare instead of
    // routing through the guarded isSelf() helper — '' === '' would otherwise
    // read as self.
    const row = makeRow({ senderUid: '', seq: 1, text: 'unresolved sender' });
    const client = makeMockClient([row]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: '' });
    await ml.mount();
    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute('data-self')).toBe('false');
    expect(bubble!.getAttribute('aria-label')).not.toContain('You');
    ml.destroy();
  });

  it('auto_scrolls_to_bottom_uses_listEl_not_container', async () => {
    // C3: scrollTop set on #listEl, not container
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    const listEl = container.querySelector('.oxp-message-list') as HTMLElement | null;
    expect(listEl).not.toBeNull();
    // listEl.scrollTop should equal its scrollHeight (pinned)
    expect(listEl!.scrollTop).toBe(listEl!.scrollHeight);
    ml.destroy();
  });

  it('preserves_scroll_position_when_user_scrolled_up', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1 }),
      makeRow({ senderUid: 'u2', seq: 2 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // Simulate user scrolling up by setting scrollTop well below scrollHeight
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    container.scrollTop = 0; // scrolled to top

    const scrollTopBefore = container.scrollTop;

    // New message arrives
    expect(capturedOnMessage).not.toBeNull();
    capturedOnMessage!(makeRow({ senderUid: 'u1', seq: 3 }));
    await new Promise((r) => setTimeout(r, 0));

    // scroll position unchanged — user is reading history
    expect(container.scrollTop).toBe(scrollTopBefore);
    ml.destroy();
  });

  // ── Slice 4: Attachment bubble rendering ─────────────────────────────────────

  it('renders_image_attachment_as_inline_img_with_lazy_loading', async () => {
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-1',
            url: 'https://cdn.example.com/image.png',
            mime: 'image/png',
            filename: 'photo.png',
            sizeBytes: 12345,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('loading')).toBe('lazy');
    expect(img!.src).toContain('image.png');

    ml.destroy();
  });

  it('renders_audio_attachment_as_html5_audio', async () => {
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-2',
            url: 'https://cdn.example.com/audio.webm',
            mime: 'audio/webm',
            filename: 'voice.webm',
            sizeBytes: 50000,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const audio = container.querySelector('.oxp-attachment-audio audio') as HTMLAudioElement | null;
    expect(audio).not.toBeNull();
    expect(audio!.hasAttribute('controls')).toBe(true);

    ml.destroy();
  });

  it('renders_file_attachment_as_download_link', async () => {
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-3',
            url: 'https://cdn.example.com/doc.pdf',
            mime: 'application/pdf',
            filename: 'report.pdf',
            sizeBytes: 204800,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const link = container.querySelector('.oxp-attachment-file') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.hasAttribute('download')).toBe(true);
    expect(link!.href).toContain('doc.pdf');

    ml.destroy();
  });

  it('escapes_filename_for_xss_in_alt_text', async () => {
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-4',
            url: 'https://cdn.example.com/image.png',
            mime: 'image/png',
            filename: '<script>alert(1)</script>.png',
            sizeBytes: 1000,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // CM1: img.alt is a DOM text property — the literal string is safe even with angle brackets.
    // The real security invariant: no actual <script> element exists in the DOM tree.
    const scriptEl = container.querySelector('script');
    expect(scriptEl).toBeNull();

    ml.destroy();
  });

  it('lazy_loading_attribute_present_on_image_attachments', async () => {
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-5',
            url: 'https://cdn.example.com/img.jpg',
            mime: 'image/jpeg',
            filename: 'img.jpg',
            sizeBytes: 8000,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('img[loading="lazy"]');
    expect(img).not.toBeNull();

    ml.destroy();
  });

  // ── CB1: URL scheme validation (XSS) ─────────────────────────────────────────

  it('rejects_javascript_url_in_image_attachment', async () => {
    // CB1: javascript: URL must NOT be set as img.src — XSS attack vector
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-xss-1',
            url: "javascript:fetch('/api/leak?c='+document.cookie)",
            mime: 'image/png',
            filename: 'evil.png',
            sizeBytes: 100,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    // img.src must NOT contain the javascript: scheme
    if (img) {
      expect(img.src).not.toContain('javascript:');
    }
    // container must show a placeholder (no raw img with bad URL, or img replaced by placeholder)
    const placeholder = container.querySelector('.oxp-attachment-unsafe');
    const hasPlaceholder = placeholder !== null;
    const hasSafeImg = img === null || !img.src.toLowerCase().startsWith('javascript:');
    expect(hasPlaceholder || hasSafeImg).toBe(true);

    ml.destroy();
  });

  it('rejects_data_html_url_in_attachment', async () => {
    // CB1: data:text/html is not a safe image URL — must not be assigned
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-xss-2',
            url: 'data:text/html,<script>alert(document.cookie)</script>',
            mime: 'image/png',
            filename: 'evil.png',
            sizeBytes: 100,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    if (img) {
      // Must NOT have data:text/html as src
      expect(img.src).not.toMatch(/^data:text\/html/i);
    }
    // Must show placeholder for unsafe URL
    const placeholder = container.querySelector('.oxp-attachment-unsafe');
    const hasSafeImg = img === null || !img.src.match(/^data:text/i);
    expect(placeholder !== null || hasSafeImg).toBe(true);

    ml.destroy();
  });

  it('rejects_javascript_url_in_file_attachment_href', async () => {
    // CB1: javascript: URL must NOT be assigned to anchor href
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-xss-3',
            url: 'javascript:alert(1)',
            mime: 'application/pdf',
            filename: 'evil.pdf',
            sizeBytes: 100,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const link = container.querySelector('.oxp-attachment-file') as HTMLAnchorElement | null;
    if (link) {
      expect(link.href).not.toContain('javascript:');
    }
    // Must show unsafe placeholder
    const placeholder = container.querySelector('.oxp-attachment-unsafe');
    const hasSafeLink = link === null || !link.href.toLowerCase().startsWith('javascript:');
    expect(placeholder !== null || hasSafeLink).toBe(true);

    ml.destroy();
  });

  // ── CM1: Filename double-escape fix ──────────────────────────────────────────

  it('filename_not_double_escaped_in_link_text', async () => {
    // CM1: escapeHtml(att.filename) then assigned to textContent = double-escape.
    // "Q&A.pdf" must render as "Q&A.pdf", not "Q&amp;A.pdf".
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-cm1',
            url: 'https://cdn.example.com/qa.pdf',
            mime: 'application/pdf',
            filename: 'Q&A.pdf',
            sizeBytes: 1024,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const link = container.querySelector('.oxp-attachment-file') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    // textContent must show literal & not &amp;
    expect(link!.textContent).toContain('Q&A.pdf');
    expect(link!.textContent).not.toContain('Q&amp;A.pdf');

    ml.destroy();
  });

  it('filename_not_double_escaped_in_img_alt', async () => {
    // CM1: alt is a DOM property — no HTML escaping needed. "A&B" must stay "A&B".
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-cm1b',
            url: 'https://cdn.example.com/img.png',
            mime: 'image/png',
            filename: 'A&B.png',
            sizeBytes: 1024,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // DOM property alt must show literal & not &amp;
    expect(img!.alt).toContain('A&B');
    expect(img!.alt).not.toContain('&amp;');

    ml.destroy();
  });

  // ── DM4: Lazy image dimensions for CLS prevention ────────────────────────────

  it('sets_width_and_height_on_img_when_meta_available', async () => {
    // DM4: when att.width/height available, set on img element to prevent CLS
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-dm4',
            url: 'https://cdn.example.com/wide.png',
            mime: 'image/png',
            filename: 'wide.png',
            sizeBytes: 5000,
            width: 800,
            height: 600,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.width).toBe(800);
    expect(img!.height).toBe(600);

    ml.destroy();
  });

  // ── F2: renderUnsafePlaceholder aria-label escape ─────────────────────────────

  it('renders_unsafe_placeholder_for_javascript_url_with_escaped_aria_label', async () => {
    // F2: raw filename in setAttribute('aria-label', ...) for unsafe placeholder.
    // "Q&A<>.pdf" must appear escaped as "Q&amp;A&lt;&gt;.pdf" in the attribute.
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-f2',
            url: 'javascript:alert(1)',
            mime: 'image/png',
            filename: 'Q&A<>.pdf',
            sizeBytes: 100,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const placeholder = container.querySelector('.oxp-attachment-unsafe') as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    // getAttribute reads the raw attribute string — must contain escaped chars
    const label = placeholder!.getAttribute('aria-label') ?? '';
    expect(label).toContain('&amp;');
    expect(label).toContain('&lt;');
    expect(label).toContain('&gt;');
    // Must NOT contain raw unescaped < or & in the attribute
    expect(label).not.toMatch(/[^&]&[^a-z]/); // raw & followed by non-entity chars
    expect(label).not.toContain('<');

    ml.destroy();
  });

  // ── F4: minHeight overshoot regression ───────────────────────────────────────

  it('renders_small_image_without_min_height_overshoot', async () => {
    // F4: img.style.minHeight='80px' applied unconditionally — creates grey bar
    // for small thumbnails (e.g. 40×30px icon). Fix: gate on !(att.width && att.height).
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-f4',
            url: 'https://cdn.example.com/icon.png',
            mime: 'image/png',
            filename: 'icon.png',
            sizeBytes: 512,
            width: 40,
            height: 30,
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // When width/height are provided, minHeight must be empty (no grey bar)
    expect(img!.style.minHeight).toBe('');

    ml.destroy();
  });

  it('renders_unknown_size_image_with_min_height_placeholder', async () => {
    // F4 inverse: when no att.width/height, minHeight='80px' keeps layout stable
    const rows = [
      makeRow({
        senderUid: 'u1',
        seq: 1,
        attachments: [
          {
            id: 'att-f4b',
            url: 'https://cdn.example.com/unknown.png',
            mime: 'image/png',
            filename: 'unknown.png',
            sizeBytes: 1024,
            // no width/height
          },
        ],
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Without dimensions, minHeight='80px' must be set
    expect(img!.style.minHeight).toBe('80px');

    ml.destroy();
  });
});

// ── 1D: client.list() failure UI (#1244) ─────────────────────────────────────

describe('MessageList — 1D inline error with retry on list failure', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('renders_inline_error_with_retry_on_list_failure', async () => {
    // 1D: on error, #listEl is empty — user sees blank widget.
    // Fix: add .oxp-message-list-error with message + retry button inside #listEl.
    let callCount = 0;
    const failingClient: MessageListClient = {
      list: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Network timeout'));
        return Promise.resolve({ items: [], hasNext: false });
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    const ml = new MessageList({
      client: failingClient,
      roomId: 'r1',
      container,
      lang: 'en',
      selfUid: 'u1',
    });
    await ml.mount();

    // Error element must be rendered inside the list container
    const errorEl = container.querySelector('.oxp-message-list-error') as HTMLElement | null;
    expect(errorEl).not.toBeNull();
    // Must show the error message
    expect(errorEl!.textContent).toContain('Network timeout');
    // Must have a retry button
    const retryBtn = errorEl!.querySelector('button') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();

    // Clicking retry must re-invoke mount (callCount becomes 2, succeeds)
    retryBtn!.click();
    await new Promise((r) => setTimeout(r, 10));

    // After retry succeeds, error must be gone
    expect(container.querySelector('.oxp-message-list-error')).toBeNull();
    expect(callCount).toBe(2);

    ml.destroy();
  });
});

// ── W2.2 slice 5: seq tracking + gap fill ─────────────────────────────────────

describe('MessageList — W2.2 slice 5 seq tracking', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    capturedOnMessage = null;
  });

  it('tracks_last_seen_seq_from_subscribed_messages', async () => {
    const rows = [
      makeRow({ senderUid: 'u1', seq: 5 }),
      makeRow({ senderUid: 'u2', seq: 7 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    // After mount, getLastSeq() must return the highest seq seen (7)
    expect(ml.getLastSeq()).toBe(7);

    // Receiving a new message with higher seq updates lastSeq
    capturedOnMessage!(makeRow({ senderUid: 'u1', seq: 9 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ml.getLastSeq()).toBe(9);

    ml.destroy();
  });

  it('dedupes_gap_messages_after_reconnect', async () => {
    const msgId1 = 'msg-001';
    const msgId2 = 'msg-002';
    const rows = [
      makeRow({ senderUid: 'u1', seq: 1, msgId: msgId1 }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const before = container.querySelectorAll('[role="article"]').length;
    expect(before).toBe(1);

    // Simulate gap fill: first message replayed + new message
    capturedOnMessage!(makeRow({ senderUid: 'u1', seq: 1, msgId: msgId1 })); // duplicate
    capturedOnMessage!(makeRow({ senderUid: 'u2', seq: 2, msgId: msgId2 })); // new
    await new Promise((r) => setTimeout(r, 0));

    const after = container.querySelectorAll('[role="article"]').length;
    // Duplicate must be deduped — total is 2, not 3
    expect(after).toBe(2);

    ml.destroy();
  });
});

// ── DM1: Retry button aria-label / DM2: retryMount state reset (#1280) ───────

describe('MessageList — DM1 retry aria-label + DM2 retryMount teardown', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('retry_button_in_list_error_has_descriptive_aria_label', async () => {
    // DM1 (design MAJOR): retry button in #renderListError has textContent='Retry' but no aria-label.
    // "Retry" alone is ambiguous in multi-error context. Fix: aria-label='Retry loading messages'.
    const failingClient: MessageListClient = {
      list: vi.fn().mockRejectedValue(new Error('fail')),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const ml = new MessageList({ client: failingClient, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const retryBtn = container.querySelector('.oxp-message-list-error button') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.getAttribute('aria-label')).toBe('Retry loading messages');

    ml.destroy();
  });

  it('retryMount_resets_state_before_refetch', async () => {
    // DM2 (design MAJOR): #retryMount() re-fetches but does NOT reset #rows/#order/#lastSeq/#reactions.
    // If retry runs after partial state was built, duplicate rows or stale seq values accumulate.
    // Fix: mirror destroy() teardown in #retryMount() before invoking mount logic.
    let callCount = 0;
    const msg1 = makeRow({ senderUid: 'u1', seq: 5, msgId: 'msg-first' });
    const msg2 = makeRow({ senderUid: 'u2', seq: 6, msgId: 'msg-second' });
    const failingClient: MessageListClient = {
      list: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('first fail'));
        // Second call returns fresh items — if state not reset, msg-first appears twice
        return Promise.resolve({ items: [msg1, msg2], hasNext: false });
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const ml = new MessageList({ client: failingClient, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount(); // call #1 fails → error shown

    // Trigger retry
    const retryBtn = container.querySelector('.oxp-message-list-error button') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    retryBtn!.click();
    await new Promise((r) => setTimeout(r, 20));

    // After successful retry, exactly 2 bubbles must appear (no duplicates from stale state)
    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(2);

    // getLastSeq() must reflect the retry data (seq=6), not stale values
    expect(ml.getLastSeq()).toBe(6);

    ml.destroy();
  });
});

// ── W9: Product card rendering ─────────────────────────────────────────────────

describe('MessageList — W9 product card', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  function makeProductMeta() {
    return {
      title: 'Widget Pro',
      price: '999',
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };
  }

  it('renders_product_card_when_productRef_and_productMeta_present', async () => {
    const rows = [
      makeRow({
        senderUid: 'u2',
        seq: 1,
        productRef: 'sku-1',
        productMeta: makeProductMeta(),
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    const card = bubble!.querySelector('.oxp-bubble-product');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Widget Pro');
    expect(card!.textContent).toContain('999 USD');

    const link = card!.querySelector('.oxp-product-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://example.com/p/1');

    ml.destroy();
  });

  it('does_not_render_product_card_without_productMeta', async () => {
    const rows = [makeRow({ senderUid: 'u2', seq: 1, productRef: 'sku-1', productMeta: null })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-bubble-product')).toBeNull();

    ml.destroy();
  });

  it('does_not_render_product_card_for_deleted_messages', async () => {
    const rows = [
      makeRow({
        senderUid: 'u2',
        seq: 1,
        productRef: 'sku-1',
        productMeta: makeProductMeta(),
        deletedAt: new Date().toISOString(),
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-bubble-product')).toBeNull();
    expect(bubble!.textContent).toContain('This message was deleted');

    ml.destroy();
  });

  it('does_not_render_product_card_for_unsealError_rows', async () => {
    const rows = [
      makeRow({
        senderUid: 'u2',
        seq: 1,
        productRef: 'sku-1',
        productMeta: makeProductMeta(),
        plaintext: undefined,
        text: undefined,
        unsealError: 'auth',
      }),
    ];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-bubble-product')).toBeNull();
    expect(bubble!.querySelector('.oxp-unseal-error')).not.toBeNull();

    ml.destroy();
  });

  it('renders_product_card_on_live_message', async () => {
    const client = makeMockClient([]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    expect(capturedOnMessage).not.toBeNull();
    capturedOnMessage!(
      makeRow({
        senderUid: 'u2',
        seq: 1,
        productRef: 'sku-live',
        productMeta: makeProductMeta(),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.querySelector('.oxp-bubble-product')).not.toBeNull();
    expect(bubble!.textContent).toContain('Widget Pro');

    ml.destroy();
  });

  it('omits_product_link_when_productUrl_is_unsafe', async () => {
    const meta = {
      title: 'Unsafe',
      price: '1',
      currency: 'USD',
      imageUrl: 'javascript://alert(1)',
      productUrl: 'javascript://alert(2)',
    };
    const rows = [makeRow({ senderUid: 'u2', seq: 1, productRef: 'sku-bad', productMeta: meta })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubble = container.querySelector('[role="article"]') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    const card = bubble!.querySelector('.oxp-bubble-product') as HTMLElement | null;
    expect(card).not.toBeNull();
    // Image and link should be stripped for unsafe URLs
    expect(card!.querySelector('img')).toBeNull();
    expect(card!.querySelector('.oxp-product-link')).toBeNull();
    expect(card!.textContent).toContain('Unsafe');

    ml.destroy();
  });

  it('renders_reply_button_and_fires_onSetReply', async () => {
    const rows = [makeRow({ senderUid: 'u2', seq: 1, text: 'hello' })];
    const client = makeMockClient(rows);
    const onSetReply = vi.fn();
    const ml = new MessageList({
      client,
      roomId: 'r1',
      container,
      lang: 'en',
      selfUid: 'u1',
      onSetReply,
    });
    await ml.mount();

    const replyBtn = container.querySelector('.oxp-reply-btn') as HTMLButtonElement | null;
    expect(replyBtn).not.toBeNull();
    replyBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(onSetReply).toHaveBeenCalledOnce();
    const snapshot = onSetReply.mock.calls[0][0];
    expect(snapshot.msgId).toBe(rows[0].msgId);
    expect(snapshot.sender).toBe('u2');
    expect(snapshot.body).toBe('hello');

    ml.destroy();
  });

  it('does_not_render_reply_button_when_onSetReply_unset', async () => {
    const rows = [makeRow({ senderUid: 'u2', seq: 1, text: 'hello' })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    expect(container.querySelector('.oxp-reply-btn')).toBeNull();

    ml.destroy();
  });

  it('renders_reply_quote_for_threadRootMsgId', async () => {
    const root = makeRow({ senderUid: 'u2', seq: 1, text: 'original' });
    const reply = makeRow({ senderUid: 'u1', seq: 2, text: 'response', threadRootMsgId: root.msgId });
    const client = makeMockClient([root, reply]);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const bubbles = container.querySelectorAll('[role="article"]');
    expect(bubbles.length).toBe(2);
    const replyBubble = bubbles[1] as HTMLElement;
    const quote = replyBubble.querySelector('.oxp-bubble-reply') as HTMLElement | null;
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toContain('u2');
    expect(quote!.textContent).toContain('original');

    ml.destroy();
  });
});

// ── P2: scroll re-pins when the composer resizes (reply-bar toggle) ──────────
//
// design-empirical review 2026-07-14 (starthey.com/demo): opening/closing the
// reply preview bar resizes the composer (a sibling of #listEl in the
// widgetRoot flex column). Nothing previously re-pinned the message list, so
// the newest message clipped by the resize delta (56px observed) — it only
// self-healed on the next appended message, because 56px sits under
// shouldAutoScroll's 80px threshold and #handleNewMessage's own wasPinned
// check would then read a scrollTop that's already been silently left behind.
//
// jsdom has no layout engine and does not implement ResizeObserver at all
// (confirmed empirically — `typeof ResizeObserver` is 'undefined' under this
// project's vitest jsdom environment), so both are mocked here: a
// MockResizeObserver capturing its callback (same "stub the global, expose a
// way to fire it" shape this repo already uses for EventSource in
// packages/chat-sdk/src/__tests__/helpers.ts), and Object.defineProperty on
// #listEl's scrollHeight/clientHeight/scrollTop (same technique the
// `preserves_scroll_position_when_user_scrolled_up` test above already uses).
describe('MessageList — P2 scroll re-pin on composer resize', () => {
  let container: HTMLDivElement;
  let roCtor: ReturnType<typeof installMockResizeObserver>;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
    roCtor = installMockResizeObserver();
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.unstubAllGlobals();
  });

  it('re_pins_scroll_to_bottom_when_composer_resize_shrinks_pinned_list', async () => {
    const rows = [makeRow({ senderUid: 'u1', seq: 1 })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const listEl = container.querySelector('.oxp-message-list') as HTMLElement;
    expect(listEl).not.toBeNull();

    // (a) pin to bottom: scrollHeight - scrollTop - clientHeight === 0
    Object.defineProperty(listEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    listEl.scrollTop = 600; // exactly at bottom (1000 - 600 - 400 = 0)

    // (b) simulate the composer growing (reply bar shown): #listEl's
    // clientHeight shrinks by 56px, scrollTop does NOT move (browsers never
    // auto-adjust scrollTop on a resize) — the newest message clips 56px.
    Object.defineProperty(listEl, 'clientHeight', { value: 344, configurable: true });
    expect(listEl.scrollTop).toBe(600); // unchanged by the resize itself

    // (c) fire the ResizeObserver callback registered against #listEl
    const ro = roCtor.getLastInstance();
    expect(ro).not.toBeNull();
    expect(ro!.observedElements).toContain(listEl);
    ro!.trigger();

    // (d) re-pinned: scrollTop snaps back to scrollHeight
    expect(listEl.scrollTop).toBe(listEl.scrollHeight);

    ml.destroy();
  });

  it('does_not_force_scroll_on_composer_resize_when_reader_scrolled_up', async () => {
    const rows = [makeRow({ senderUid: 'u1', seq: 1 })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const listEl = container.querySelector('.oxp-message-list') as HTMLElement;
    expect(listEl).not.toBeNull();

    // Reader has scrolled well away from bottom, reading history.
    Object.defineProperty(listEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 400, configurable: true });
    listEl.scrollTop = 50; // far from bottom (1000 - 50 - 400 = 550 >> 80 threshold)

    const scrollTopBefore = listEl.scrollTop;

    // Composer resize still fires (any reply-bar toggle triggers it
    // regardless of the reader's scroll position).
    Object.defineProperty(listEl, 'clientHeight', { value: 344, configurable: true });
    const ro = roCtor.getLastInstance();
    expect(ro).not.toBeNull();
    ro!.trigger();

    // Not pinned before the resize — reader's position must be preserved,
    // not yanked to bottom.
    expect(listEl.scrollTop).toBe(scrollTopBefore);

    ml.destroy();
  });

  it('disconnects_the_resize_observer_on_destroy', async () => {
    const rows = [makeRow({ senderUid: 'u1', seq: 1 })];
    const client = makeMockClient(rows);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    const ro = roCtor.getLastInstance();
    expect(ro).not.toBeNull();
    expect(ro!.disconnected).toBe(false);

    ml.destroy();

    expect(ro!.disconnected).toBe(true);
  });
});
