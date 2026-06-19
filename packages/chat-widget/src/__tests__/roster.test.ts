/**
 * roster.test.ts — T18 widget-side roster consumption.
 *
 * Tests:
 *   1. roster fetched on mount — getRoster called after initial list()
 *   2. name from roster rendered in bubble (OTHER writer, not self)
 *   3. miss fallback — epid short-form when name not in roster
 *   4. XSS safety — roster name with <script> renders inert via textContent
 *   5. onRosterSignal triggers re-fetch of getRoster
 *   6. "You" shown for own messages (not roster name)
 *   7. roster re-render: after refetch names update in DOM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<MessageRow> & { senderUid: string; seq?: number }): MessageRow {
  return {
    seq: overrides.seq ?? 1,
    msgId: crypto.randomUUID(),
    senderUid: overrides.senderUid,
    sealed: new ArrayBuffer(0),
    plaintext: new TextEncoder().encode(overrides.text ?? 'hello'),
    createdAt: new Date().toISOString(),
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    ...overrides,
  };
}

type CapturedSubscribeArgs = {
  onMessage: (row: MessageRow) => void;
  onMutation?: (event: { msgId: string; op: string; deletedAt?: string }) => void;
  onReaction?: (event: { msgId: string; emoji: string; op: string; userUid: string; totalCount: number }) => void;
  onRosterSignal?: () => void;
};

let capturedSubscribeArgs: CapturedSubscribeArgs | null = null;

function makeMockClient(opts: {
  rows?: MessageRow[];
  roster?: Map<string, string>;
  getRosterFn?: ReturnType<typeof vi.fn>;
}): MessageListClient {
  capturedSubscribeArgs = null;
  const { rows = [], roster = new Map(), getRosterFn } = opts;

  const getRoster = getRosterFn ?? vi.fn().mockResolvedValue(roster);

  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation((_roomId: string, args: CapturedSubscribeArgs) => {
      capturedSubscribeArgs = args;
      return () => {};
    }),
    getRoster,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MessageList — roster (T18)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.height = '400px';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    capturedSubscribeArgs = null;
  });

  // ── 1: roster fetched on mount ──────────────────────────────────────────────

  it('getRoster called on mount after initial list()', async () => {
    const getRosterFn = vi.fn().mockResolvedValue(new Map([['ep_writer1', 'Alice']]));
    const client = makeMockClient({ getRosterFn });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    // getRoster must be called once on mount.
    // Red-on-revert: remove the #fetchRoster call from #fetchAndRender and this fails.
    expect(getRosterFn).toHaveBeenCalledOnce();
    expect(getRosterFn).toHaveBeenCalledWith('room1');
    ml.destroy();
  });

  // ── 2: name rendered from roster for other writers ──────────────────────────

  it('renders roster display name for messages from other writers', async () => {
    const writerEpid = 'ep_writer_abc123def456';
    const roster = new Map([[writerEpid, 'Bob Sender']]);
    const rows = [makeRow({ senderUid: writerEpid, text: 'hello', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    // Sender label must show the roster name, not the raw epid.
    // Red-on-revert: revert the roster lookup in #populateBubble and the raw epid appears.
    const senderEl = container.querySelector('.oxp-bubble-sender');
    expect(senderEl).not.toBeNull();
    expect(senderEl!.textContent).toBe('Bob Sender');
    ml.destroy();
  });

  // ── 3: miss fallback — epid short-form ─────────────────────────────────────

  it('renders epid short-form (first 8 chars) when epid not in roster', async () => {
    const epid = 'ep_unknownwriter999';
    const rows = [makeRow({ senderUid: epid, text: 'hi', seq: 1 })];
    const client = makeMockClient({ rows, roster: new Map() }); // empty roster

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const senderEl = container.querySelector('.oxp-bubble-sender');
    expect(senderEl).not.toBeNull();
    // Short-form: first 8 chars of epid.
    // Red-on-revert: revert the slice fallback and full epid appears (no crash, but wrong format).
    expect(senderEl!.textContent).toBe('ep_unkno');
    ml.destroy();
  });

  // ── 4: XSS safety ──────────────────────────────────────────────────────────

  it('XSS: roster name with <script> is inert — not executed, not injected as HTML', async () => {
    const epid = 'ep_attacker';
    const xssName = '<script>window.__xssHit=1</script>';
    const roster = new Map([[epid, xssName]]);
    const rows = [makeRow({ senderUid: epid, text: 'msg', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const senderEl = container.querySelector('.oxp-bubble-sender');
    expect(senderEl).not.toBeNull();

    // SEC-CR-003 / FF3: textContent is the correct sink — it treats the value as literal text,
    // not HTML. If innerHTML were used instead, the <script> would execute.
    //
    // Red-on-revert: change senderEl.textContent to senderEl.innerHTML and the script
    // tag becomes live HTML (the test would fail because the content would be parsed).
    //
    // We verify: the literal angle-bracket string is present in textContent (treated as text),
    // and no child <script> element was injected.
    expect(senderEl!.textContent).toContain('<script>');  // stored as literal text
    expect(senderEl!.querySelector('script')).toBeNull();  // not parsed as DOM
    // Also: global xssHit must not have been set.
    expect((window as unknown as Record<string, unknown>)['__xssHit']).toBeUndefined();
    ml.destroy();
  });

  // ── 5: onRosterSignal triggers re-fetch ────────────────────────────────────

  it('onRosterSignal triggers debounced re-fetch of getRoster', async () => {
    const getRosterFn = vi.fn()
      .mockResolvedValueOnce(new Map())       // initial fetch
      .mockResolvedValueOnce(new Map([['ep_writer1', 'Alice']])); // re-fetch on signal

    const client = makeMockClient({ getRosterFn });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20)); // initial fetch settles

    expect(getRosterFn).toHaveBeenCalledOnce();

    // Fire the roster SSE signal via the captured subscribe callback.
    // Red-on-revert: remove the onRosterSignal wiring in #fetchAndRender and getRosterFn
    // will NOT be called a second time.
    expect(capturedSubscribeArgs?.onRosterSignal).toBeDefined();
    capturedSubscribeArgs!.onRosterSignal!();

    // Wait for debounce (100ms) + fetch to settle.
    await new Promise((r) => setTimeout(r, 200));

    expect(getRosterFn).toHaveBeenCalledTimes(2);
    ml.destroy();
  });

  // ── 6: own messages show "You" (not roster name) ───────────────────────────

  it('own messages show "You" — roster name not used for self', async () => {
    const selfUid = 'ep_self_uid_123';
    // Even if roster has a name for selfUid, "You" must be shown.
    const roster = new Map([[selfUid, 'Myself from roster']]);
    const rows = [makeRow({ senderUid: selfUid, text: 'my msg', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const senderEl = container.querySelector('.oxp-bubble-sender');
    expect(senderEl).not.toBeNull();
    // Red-on-revert: remove the isSelf branch and "Myself from roster" appears.
    expect(senderEl!.textContent).toBe('You');
    ml.destroy();
  });

  // ── 7: after roster re-fetch names update in DOM ───────────────────────────

  it('names update in DOM after roster re-fetch via signal', async () => {
    const epid = 'ep_writer_refresh';
    const initialRoster = new Map<string, string>(); // miss initially
    const updatedRoster = new Map([[epid, 'Alice Updated']]);

    const getRosterFn = vi.fn()
      .mockResolvedValueOnce(initialRoster)
      .mockResolvedValueOnce(updatedRoster);

    const rows = [makeRow({ senderUid: epid, text: 'hello', seq: 1 })];
    const client = makeMockClient({ rows, getRosterFn });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20)); // initial fetch settles

    // Initially: epid short-form (miss)
    const senderBefore = container.querySelector('.oxp-bubble-sender');
    expect(senderBefore!.textContent).toBe('ep_write'); // first 8 chars

    // Fire roster signal
    capturedSubscribeArgs!.onRosterSignal!();
    await new Promise((r) => setTimeout(r, 200)); // debounce + re-render

    // After re-fetch: full name from roster.
    // Red-on-revert: remove #renderAll() from #fetchRoster() and the DOM stays stale.
    const senderAfter = container.querySelector('.oxp-bubble-sender');
    expect(senderAfter!.textContent).toBe('Alice Updated');
    ml.destroy();
  });
});
