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
import type { MessageListClient, MessageRow, RosterEntry } from '../ui/message-list.js';
import { OxpulseChatElement, defineElement } from '../element.js';

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
  roster?: Map<string, RosterEntry>;
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
    const getRosterFn = vi.fn().mockResolvedValue(new Map<string, RosterEntry>([['ep_writer1', { displayName: 'Alice', avatarUrl: null }]]));
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
    const roster = new Map<string, RosterEntry>([[writerEpid, { displayName: 'Bob Sender', avatarUrl: null }]]);
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
    const roster = new Map<string, RosterEntry>([[epid, { displayName: xssName, avatarUrl: null }]]);
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
      .mockResolvedValueOnce(new Map<string, RosterEntry>([['ep_writer1', { displayName: 'Alice', avatarUrl: null }]])); // re-fetch on signal

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
    const roster = new Map<string, RosterEntry>([[selfUid, { displayName: 'Myself from roster', avatarUrl: null }]]);
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
    const initialRoster = new Map<string, RosterEntry>(); // miss initially
    const updatedRoster = new Map<string, RosterEntry>([[epid, { displayName: 'Alice Updated', avatarUrl: null }]]);

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

// ── Element-level integration: onRosterSignal forwarded through real adapter ──

/**
 * MAJOR-2 regression guard.
 *
 * The prior bug: element.ts `widgetClient.subscribe` accepted `onRosterSignal`
 * in its arg type but did NOT forward it to `sdkClient.subscribe`. The message-list
 * tests (above) never caught this because `makeMockClient().subscribe` captures args
 * directly — it bypasses the element.ts adapter entirely.
 *
 * This test drives the REAL element.ts adapter path:
 *   OxpulseChatElement → element.ts widgetClient.subscribe → sdkClient.subscribe
 * and asserts that firing `onRosterSignal` from the sdkClient's captured args
 * triggers a second fetchRoster (roster re-fetch) in the assembled widget.
 *
 * Red-on-revert: remove `onRosterSignal: args.onRosterSignal` from the
 * sdkClient.subscribe call in element.ts and this test goes RED because
 * fetchRosterImpl is called only once (mount-time), not twice.
 */
describe('OxpulseChatElement — roster signal forwarded through element adapter (MAJOR-2 guard)', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${header}.${body}.fakesig`;
  }

  const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'ep_test' });

  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('type:"roster" SSE event triggers second fetchRoster through the real element adapter', async () => {
    // Capture args that the element.ts adapter passes to sdkClient.subscribe.
    // These are the BRIDGED args produced by element.ts, not MessageList's raw args —
    // this is the seam the original bug lived in.
    let capturedSdkSubscribeArgs: {
      onRosterSignal?: () => void;
      [k: string]: unknown;
    } | null = null;

    // Track roster endpoint HTTP calls via globalThis.fetch mock.
    // fetchRoster in the element uses globalThis.fetch (injected to roster.ts via
    // fetchImpl ?? globalThis.fetch). In jsdom, vi.spyOn(globalThis, 'fetch') intercepts it.
    let rosterFetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url instanceof URL ? url.toString() : url instanceof Request ? url.url : url);
      if (urlStr.includes('/api/sdk/roster')) {
        rosterFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ roster: {} }),
        } as unknown as Response;
      }
      // Passthrough for anything else (shouldn't hit in this test).
      return originalFetch(url as Parameters<typeof originalFetch>[0]);
    });

    // Inject a real-shaped sdkClient stub whose subscribe captures the bridged args.
    const sdkClientStub = {
      list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
      subscribe: vi.fn().mockImplementation((_roomId: string, args: Record<string, unknown>) => {
        capturedSdkSubscribeArgs = args as typeof capturedSdkSubscribeArgs;
        return () => {};
      }),
      sendText: vi.fn().mockResolvedValue({ msgId: 'msg-1' }),
      getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    };

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({
      // Cast through unknown: stub satisfies the RawClient contract within element.ts.
      // The _createClient type in WidgetConfig uses the public MessageRow import;
      // the runtime shape is what matters, not the full nominal type.
      _createClient: () => sdkClientStub as unknown as Parameters<typeof el._setCallbacks>[0] extends { _createClient?: (o: infer _O) => infer R } ? R : never,
    });
    container.appendChild(el);

    // Wait for bootstrap (list + subscribe + roster fetch).
    await new Promise((r) => setTimeout(r, 50));

    // Mount-time: element fetched the roster once via fetchRoster().
    expect(rosterFetchCount).toBe(1);

    // The real element adapter must have forwarded onRosterSignal to sdkClient.subscribe.
    // If element.ts drops the callback, this is undefined and the test fails here.
    expect(capturedSdkSubscribeArgs?.onRosterSignal).toBeDefined();

    // Simulate the SSE type:"roster" event by calling the callback the SDK would invoke.
    capturedSdkSubscribeArgs!.onRosterSignal!();

    // Wait for debounce (100ms) + re-fetch.
    await new Promise((r) => setTimeout(r, 200));

    // Re-fetch must have fired: rosterFetchCount must be 2.
    // Red-on-revert: remove `onRosterSignal: args.onRosterSignal` from element.ts
    // sdkClient.subscribe → capturedSdkSubscribeArgs.onRosterSignal is undefined →
    // test fails at the expect above, or rosterFetchCount stays at 1.
    expect(rosterFetchCount).toBe(2);

    el.destroy();
    globalThis.fetch = originalFetch;
  });
});


// ── T18-avatar: message-row avatar rendering (integration through MessageList) ─

describe('MessageList — avatar (T18-avatar)', () => {
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

  it('renders an <img> avatar with alt=display name when avatar_url present', async () => {
    const epid = 'ep_avatar_writer';
    const url = 'https://cdn.example.com/a.png';
    const roster = new Map<string, RosterEntry>([[epid, { displayName: 'Alice', avatarUrl: url }]]);
    const rows = [makeRow({ senderUid: epid, text: 'hi', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const img = container.querySelector('.oxp-bubble-avatar img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Red-on-revert: remove the createAvatarElement wiring in #createBubble → no <img>.
    // src set via property (XSS-safe); alt = display name (accessible).
    expect(img!.getAttribute('src')).toBe(url);
    expect(img!.alt).toBe('Alice');
    ml.destroy();
  });

  it('renders an initials-circle fallback when avatar_url absent', async () => {
    const epid = 'ep_noavatar';
    const roster = new Map<string, RosterEntry>([[epid, { displayName: 'Bob Smith', avatarUrl: null }]]);
    const rows = [makeRow({ senderUid: epid, text: 'hi', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const avatar = container.querySelector('.oxp-bubble-avatar') as HTMLElement | null;
    expect(avatar).not.toBeNull();
    expect(avatar!.querySelector('img')).toBeNull();
    // Initials from "Bob Smith" → "BS". Red-on-revert: drop the initials fallback.
    expect(avatar!.textContent).toBe('BS');
    ml.destroy();
  });

  it('falls back to initials when the avatar image errors (onerror)', async () => {
    const epid = 'ep_broken';
    const url = 'https://cdn.example.com/broken.png';
    const roster = new Map<string, RosterEntry>([[epid, { displayName: 'Carol', avatarUrl: url }]]);
    const rows = [makeRow({ senderUid: epid, text: 'hi', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const img = container.querySelector('.oxp-bubble-avatar img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Simulate a load failure — onerror swaps to initials.
    img!.dispatchEvent(new Event('error'));
    const avatar = container.querySelector('.oxp-bubble-avatar') as HTMLElement;
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('C'); // "Carol" → "C"
    ml.destroy();
  });

  it('does not render an avatar for own messages (WhatsApp-style)', async () => {
    const selfUid = 'ep_self';
    const roster = new Map<string, RosterEntry>([[selfUid, { displayName: 'Me', avatarUrl: 'https://cdn.example.com/me.png' }]]);
    const rows = [makeRow({ senderUid: selfUid, text: 'mine', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    // Red-on-revert: drop the `if (!isSelf)` guard and a self-avatar appears.
    expect(container.querySelector('.oxp-bubble-avatar')).toBeNull();
    ml.destroy();
  });

  it('XSS: a javascript: avatar_url is not used as <img src> — initials shown', async () => {
    const epid = 'ep_xss';
    const roster = new Map<string, RosterEntry>([[epid, { displayName: 'Mallory', avatarUrl: 'javascript:alert(1)' }]]);
    const rows = [makeRow({ senderUid: epid, text: 'hi', seq: 1 })];
    const client = makeMockClient({ rows, roster });

    const ml = new MessageList({ client, roomId: 'room1', container, lang: 'en', selfUid: 'self-uid' });
    await ml.mount();
    await new Promise((r) => setTimeout(r, 20));

    const avatar = container.querySelector('.oxp-bubble-avatar') as HTMLElement;
    expect(avatar).not.toBeNull();
    // Defensive client-side gate: non-http(s) URL rejected → no <img>, initials instead.
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('M');
    ml.destroy();
  });
});
