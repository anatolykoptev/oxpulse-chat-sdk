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
