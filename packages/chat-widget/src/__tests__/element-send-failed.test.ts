/**
 * element-send-failed.test.ts — R3: failed-message affordances are usable.
 *
 * F1 — dismiss a failed message, reload, and it is gone.
 *   Journey: user clicks dismiss on a failed bubble → the outbox entry is
 *   durably dequeued → on re-mount the bubble does NOT reappear.
 *   Mutation: drop the dismissFailedOutboxEntry call in #dismissFailedMessage
 *   → RED (the entry survives in the store, re-mount re-renders the bubble).
 *
 * F3 — retry on a failed message leaves the failure visible until a re-send
 *   is actually dispatched.
 *   Journey: user clicks retry on a send-failed bubble → the failure stays
 *   visible (the caption is restored to the composer for re-staging, but the
 *   failed bubble is NOT removed until the user actually re-sends or dismisses).
 *   Mutation: restore the eager removeRow in #retrySendFailed → RED (the
 *   bubble is gone immediately after retry, before any re-send is dispatched).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement } from '../element.js';

// fetchRoster is called unconditionally on mount; jsdom has no roster server.
// Stub to resolve an empty roster so mount completes deterministically.
// #261: the durability signal is driven from the tests. Declared via vi.hoisted
// because vi.mock is hoisted above the file body.
const outboxState = vi.hoisted(() => ({
  degradation: null as null | { op: string },
  disposed: 0,
  /** The widget's live listener, so a test can drive a degradation that happens
   *  AFTER subscribe — F5 only ever covered the replay path. */
  listener: null as null | ((d: { op: string }) => void),
}));

vi.mock('@oxpulse/chat-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxpulse/chat-sdk')>();
  return {
    ...actual,
    fetchRoster: vi.fn().mockResolvedValue(new Map()),
    // Mirrors the real contract: a listener registered after the failure is
    // called immediately, and registration returns a disposer.
    onOutboxDegraded: (fn: (d: { op: string }) => void) => {
      outboxState.listener = fn;
      if (outboxState.degradation) fn(outboxState.degradation);
      return () => {
        outboxState.disposed += 1;
        outboxState.listener = null;
      };
    },
  };
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u1' });

/** Wait for the element's oxpulse-chat:ready event (fires after mount + failed-outbox read). */
function waitForReady(el: OxpulseChatElement, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oxpulse-chat:ready timed out')), timeoutMs);
    el.addEventListener('oxpulse-chat:ready', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Stub image compression so paste-driven image staging works under jsdom. */
function stubImageCompression(): void {
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
  const mockCtx = { imageSmoothingEnabled: false, imageSmoothingQuality: 'high', drawImage: vi.fn() };
  const compressedBlob = new Blob(['compressed'], { type: 'image/webp' });
  const origCreate = globalThis.document.createElement.bind(globalThis.document);
  vi.spyOn(globalThis.document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag) as HTMLElement & {
      getContext: (c: string) => unknown;
      toBlob: (cb: (b: Blob | null) => void, type?: string, q?: number) => void;
    };
    if (tag === 'canvas') {
      el.getContext = vi.fn().mockReturnValue(mockCtx) as unknown as typeof el.getContext;
      el.toBlob = vi.fn().mockImplementation((cb: (b: Blob | null) => void) => cb(compressedBlob));
    }
    return el;
  });
  class FakeReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    result: string | ArrayBuffer = 'data:image/webp;base64,AA==';
    readAsDataURL() { void Promise.resolve().then(() => this.onload?.()); }
    readAsArrayBuffer() { this.result = new ArrayBuffer(8); void Promise.resolve().then(() => this.onload?.()); }
  }
  vi.stubGlobal('FileReader', FakeReader);
}

/** Minimal mock client for F1: list + subscribe + sendText + failed-outbox surface. */
function makeFailedOutboxClient(failedStore: Array<{ msgId: string; senderUid: string; pendingAttachments?: { body: string }; sendFailed?: { reason: string; failedAt: number }; threadRootMsgId?: string; productRef?: string; productMeta?: unknown }>) {
  return {
    list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock' }),
    getFailedOutboxEntries: vi.fn(async () => [...failedStore]),
    dismissFailedOutboxEntry: vi.fn(async (_roomId: string, msgId: string) => {
      const idx = failedStore.findIndex((e) => e.msgId === msgId);
      if (idx >= 0) failedStore.splice(idx, 1);
    }),
    flushOutbox: vi.fn(async () => {}),
  };
}

/** Mount an element with the given client and wait for ready. */
async function mountWithClient(client: unknown): Promise<OxpulseChatElement> {
  const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
  el.setAttribute('app-id', 'app1');
  el.setAttribute('jwt', LOCALHOST_JWT);
  el.setAttribute('room-id', 'room1');
  el._setCallbacks({ _createClient: () => client });
  document.body.appendChild(el);
  await waitForReady(el);
  return el;
}

/** #257: Build a client for the live send-failure journey (paste → send →
 *  reject done). The caller spreads extra methods (e.g. a dismiss spy) via
 *  `extra`. Returns the client plus the reject handle for failing the send. */
function makeLiveFailureClient(extra: Record<string, unknown> = {}): {
  client: Record<string, unknown>;
  rejectDone: (err: Error) => void;
} {
  let rejectDone!: (err: Error) => void;
  const donePromise = new Promise<{ seq: number; msgId: string }>((_, reject) => {
    rejectDone = reject;
  });
  const client = {
    list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock' }),
    send: vi.fn().mockResolvedValue({ seq: 1, msgId: 'mock' }),
    baseUrl: 'https://chat.example.com',
    jwt: 'test-jwt',
    assertRoomNotPoisoned: vi.fn(),
    uploadAttachment: vi.fn().mockResolvedValue({
      attachmentId: 'att-1',
      attachment: { id: 'att-1', mime: 'image/png', filename: 'photo.png', sizeBytes: 100 },
    }),
    sendAttachmentMessageOptimistic: vi.fn((_roomId: string, args: { msgId: string }) => ({
      msgId: args.msgId,
      done: donePromise,
      onPending: () => {},
      onSucceeded: () => {},
      onFailed: () => {},
    })),
    getFailedOutboxEntries: vi.fn(async () => []),
    flushOutbox: vi.fn(async () => {}),
    ...extra,
  };
  return { client, rejectDone };
}

/** #257: Drive the live send-failure journey: stub compression/fetch, mount,
 *  paste an image, type a caption, send, and reject the handle's done promise
 *  to produce a retryable failed bubble. Returns the element, textarea, and
 *  the failed bubble (with its msgId). */
async function liveSendFailureJourney(
  client: Record<string, unknown>,
  caption: string,
  rejectDone: (err: Error) => void,
): Promise<{ el: OxpulseChatElement; textarea: HTMLTextAreaElement; failedBubble: HTMLElement; msgId: string }> {
  stubImageCompression();
  vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia: vi.fn() } });

  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const urlStr = String(url);
    if (urlStr === 'https://chat.example.com/api/sdk/attachments/presign') {
      return { ok: true, status: 200, json: async () => ({ attachment_id: 'att-1', upload_url: '/api/sdk/attachments/att-1?t=tok' }) } as Response;
    }
    if (urlStr.startsWith('https://chat.example.com/api/sdk/attachments/att-1')) {
      return { ok: true, status: 204, json: async () => null } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  const el = await mountWithClient(client);

  const textarea = el.shadowRoot!.querySelector('.oxp-composer-input') as HTMLTextAreaElement;
  expect(textarea).not.toBeNull();
  const pngFile = new File([new Uint8Array(16)], 'photo.png', { type: 'image/png' });
  const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [pngFile] }, configurable: true });
  textarea.dispatchEvent(pasteEvent);
  await new Promise((r) => setTimeout(r, 30));

  textarea.value = caption;
  textarea.dispatchEvent(new Event('input'));
  const sendBtn = el.shadowRoot!.querySelector('.oxp-composer-send') as HTMLButtonElement;
  sendBtn.click();
  await new Promise((r) => setTimeout(r, 30));

  rejectDone(new Error('upload failed'));
  await new Promise((r) => setTimeout(r, 30));

  const failedBubble = el.shadowRoot!.querySelector('[data-send-failed="true"]') as HTMLElement;
  expect(failedBubble).not.toBeNull();
  const msgId = failedBubble.getAttribute('data-msg-id')!;
  expect(msgId).toBeTruthy();

  return { el, textarea, failedBubble, msgId };
}

describe('OxpulseChatElement — failed-message affordances (R3)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    outboxState.degradation = null;
    outboxState.disposed = 0;
    outboxState.listener = null;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    // #261: reset on the way OUT as well as in. The mock factory closes over
    // outboxState, so leaving it "degraded" made element.test.ts mount with an
    // extra onError and fail two attachment cases in the full-suite run while
    // passing alone. Symmetric reset keeps the state inside this file.
    // (An earlier version of this comment blamed vitest's `pool: 'vmForks'`.
    // That setting belongs to oxpulse-chat's web/ suite, not to this repo —
    // no vitest config here sets a pool. The leak was real; the mechanism
    // named for it was borrowed from the wrong repository.)
    // Every field beforeEach clears, cleared here too. It said "symmetric" and
    // was not: `disposed` and `listener` leaked out of this file, and `listener`
    // holds a closure over an element from it. Asserting a property the code
    // does not have is the defect this whole PR is about.
    outboxState.degradation = null;
    outboxState.disposed = 0;
    outboxState.listener = null;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── F1: dismiss is durable ──────────────────────────────────────────────
  //
  // Journey: user dismisses a failed message → the outbox entry is durably
  // dequeued (dismissFailedOutboxEntry called) → on re-mount the bubble is
  // gone.
  // Mutation: drop the dismissFailedOutboxEntry call in #dismissFailedMessage
  // → RED (the entry survives in the store, re-mount re-renders the bubble).
  it('F1_dismiss_durable_failed_bubble_gone_after_reload', async () => {
    const failedStore = [
      {
        msgId: 'fail-dismiss-1',
        senderUid: 'u1',
        pendingAttachments: { body: 'lost photo caption' },
        sendFailed: { reason: 'Upload interrupted', failedAt: Date.now() },
      },
    ];
    const client = makeFailedOutboxClient(failedStore);

    // 1. Mount — the failed bubble appears (from getFailedOutboxEntries).
    const el1 = await mountWithClient(client);
    const bubble1 = el1.shadowRoot!.querySelector('[data-msg-id="fail-dismiss-1"]');
    expect(bubble1).not.toBeNull();
    expect(bubble1!.getAttribute('data-send-failed')).toBe('true');

    // 2. Click the dismiss button.
    const dismissBtn = bubble1!.querySelector('.oxp-send-failed-dismiss') as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();
    dismissBtn.click();
    // Allow the async dismiss handler + removeRow to settle.
    await new Promise((r) => setTimeout(r, 30));

    // 3. The SDK's dismissFailedOutboxEntry was called — this is the durable
    //    dequeue that makes the dismiss survive a reload.
    expect(client.dismissFailedOutboxEntry).toHaveBeenCalledWith('room1', 'fail-dismiss-1');

    // 4. The bubble is removed from the DOM (removeRow).
    expect(el1.shadowRoot!.querySelector('[data-msg-id="fail-dismiss-1"]')).toBeNull();

    // 5. "Reload" — destroy + re-mount with the same client/store. The entry
    //    was dequeued from the store by dismissFailedOutboxEntry, so
    //    getFailedOutboxEntries returns [] and the bubble does NOT reappear.
    el1.remove();
    vi.mocked(client.getFailedOutboxEntries).mockClear();
    const el2 = await mountWithClient(client);
    expect(client.getFailedOutboxEntries).toHaveBeenCalledWith('room1');
    expect(el2.shadowRoot!.querySelector('[data-msg-id="fail-dismiss-1"]')).toBeNull();

    el1.remove();
    el2.remove();
  });

  // ── F3: retry keeps the failure visible ──────────────────────────────────
  //
  // Journey: user clicks retry on a send-failed bubble → the failure stays
  // visible (the caption is restored to the composer for re-staging, but the
  // failed bubble is NOT removed until a re-send is actually dispatched or the
  // user dismisses it).
  // Mutation: restore the eager removeRow(msgId) in #retrySendFailed → RED
  // (the bubble is gone immediately after retry, before any re-send).
  it('F3_retry_keeps_failure_visible_until_resend_dispatched', async () => {
    stubImageCompression();
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia: vi.fn() } });

    // Stub fetch for the element's uploadAttachment bridge (presign + PUT).
    // Routed by URL — the roster fetch (fetchRoster mock) is already stubbed
    // at the module level; this handles the attachment-specific calls.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr === 'https://chat.example.com/api/sdk/attachments/presign') {
        return { ok: true, status: 200, json: async () => ({ attachment_id: 'att-1', upload_url: '/api/sdk/attachments/att-1?t=tok' }) } as Response;
      }
      if (urlStr.startsWith('https://chat.example.com/api/sdk/attachments/att-1')) {
        return { ok: true, status: 204, json: async () => null } as Response;
      }
      return { ok: false, status: 404, json: async () => null, text: async () => '' } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    // Controllable handle: we reject `done` to simulate a send failure.
    let rejectDone!: (err: Error) => void;
    const donePromise = new Promise<{ seq: number; msgId: string }>((_, reject) => {
      rejectDone = reject;
    });

    const client = {
      list: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
      subscribe: vi.fn().mockImplementation(() => () => {}),
      sendText: vi.fn().mockResolvedValue({ msgId: 'mock' }),
      send: vi.fn().mockResolvedValue({ seq: 1, msgId: 'mock' }),
      baseUrl: 'https://chat.example.com',
      jwt: 'test-jwt',
      assertRoomNotPoisoned: vi.fn(),
      uploadAttachment: vi.fn().mockResolvedValue({
        attachmentId: 'att-1',
        attachment: { id: 'att-1', mime: 'image/png', filename: 'photo.png', sizeBytes: 100 },
      }),
      sendAttachmentMessageOptimistic: vi.fn((_roomId: string, args: { msgId: string }) => ({
        msgId: args.msgId,
        done: donePromise,
        onPending: () => {},
        onSucceeded: () => {},
        onFailed: () => {},
      })),
    };

    const el = await mountWithClient(client);

    // 1. Paste an image into the composer textarea (stages it).
    const textarea = el.shadowRoot!.querySelector('.oxp-composer-input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const pngFile = new File([new Uint8Array(16)], 'photo.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [pngFile] }, configurable: true });
    textarea.dispatchEvent(pasteEvent);
    await new Promise((r) => setTimeout(r, 30));

    // 2. Type a caption and click send — triggers sendAttachmentMessageOptimistic.
    textarea.value = 'retry me caption';
    textarea.dispatchEvent(new Event('input'));
    const sendBtn = el.shadowRoot!.querySelector('.oxp-composer-send') as HTMLButtonElement;
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // The optimistic send was called (populating #pendingRetries).
    expect(client.sendAttachmentMessageOptimistic).toHaveBeenCalled();

    // 3. Fail the send — reject the handle's done promise → oxpulse-chat:send-failed
    //    event → markSendFailed(retryable=true) → bubble shows retry button.
    rejectDone(new Error('upload failed'));
    await new Promise((r) => setTimeout(r, 30));

    // Find the failed bubble. The msgId is a UUID generated by the element
    // wrapper — locate it by data-send-failed.
    const failedBubble = el.shadowRoot!.querySelector('[data-send-failed="true"]') as HTMLElement;
    expect(failedBubble).not.toBeNull();

    // The retry button is present (retryable=true from the send-failed event).
    const retryBtn = failedBubble.querySelector('.oxp-send-failed-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    // 4. Click retry — #retrySendFailed fires.
    retryBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // 5. F3 core invariant: the failure is STILL visible after retry. The
    //    caption was restored to the composer, but the failed bubble was NOT
    //    removed — the user can see the failure until they actually re-send
    //    or dismiss it.
    const bubbleAfterRetry = el.shadowRoot!.querySelector('[data-send-failed="true"]');
    expect(bubbleAfterRetry).not.toBeNull();

    el.remove();
  });

  // ── F12: retry dequeues the original outbox entry (#257) ──────────────────
  //
  // Journey: user clicks retry on a send-failed bubble → the original outbox
  // entry is dequeued before the caption is restored → the next flushOutbox
  // (mount/reconnect) does NOT re-send the original, so one user intent =
  // one message. Without this, the original stays queued and the re-send
  // (new msgId) produces a duplicate.
  // Mutation: delete the dismissFailedOutboxEntry call in #retrySendFailed
  // → RED (the spy is never called).
  it('F12_retry_dequeues_original_outbox_entry', async () => {
    const dismissSpy = vi.fn(async (_roomId: string, _msgId: string) => {});
    const { client, rejectDone } = makeLiveFailureClient({
      dismissFailedOutboxEntry: dismissSpy,
    });

    const { el, failedBubble, msgId } = await liveSendFailureJourney(
      client, 'retry me caption', rejectDone,
    );

    // Click retry — #retrySendFailed fires.
    const retryBtn = failedBubble.querySelector('.oxp-send-failed-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // THE GATE: the SDK's dequeue seam was called with this room and msgId.
    // Without this call, the original outbox entry stays queued and the next
    // flushOutbox re-sends it alongside the user's new send.
    expect(dismissSpy).toHaveBeenCalledWith('room1', msgId);

    el.remove();
  });

  // ── F13: CONTROL — dismiss still dequeues and removes the row ─────────────
  //
  // Without this, F12 would pass against a widget that dequeues unconditionally
  // on every path. Dismiss must still dequeue AND remove the row — retry
  // dequeues but does NOT remove the row (F14). The two paths are distinct.
  // Mutation: delete the removeRow call in #dismissFailedMessage → RED (the
  // row survives in the DOM).
  it('F13_CONTROL_dismiss_still_dequeues_and_removes_row', async () => {
    const failedStore = [
      {
        msgId: 'fail-dismiss-ctrl',
        senderUid: 'u1',
        pendingAttachments: { body: 'lost photo caption' },
        sendFailed: { reason: 'Upload interrupted', failedAt: Date.now() },
      },
    ];
    const client = makeFailedOutboxClient(failedStore);

    const el = await mountWithClient(client);
    const bubble = el.shadowRoot!.querySelector('[data-msg-id="fail-dismiss-ctrl"]');
    expect(bubble).not.toBeNull();

    const dismissBtn = bubble!.querySelector('.oxp-send-failed-dismiss') as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();
    dismissBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // Dismiss dequeued the outbox entry.
    expect(client.dismissFailedOutboxEntry).toHaveBeenCalledWith('room1', 'fail-dismiss-ctrl');
    // Dismiss removed the row from the DOM.
    expect(el.shadowRoot!.querySelector('[data-msg-id="fail-dismiss-ctrl"]')).toBeNull();

    el.remove();
  });

  // ── F14: CONTROL — retry restores caption and keeps bubble visible ────────
  //
  // The dequeue must not break the existing retry behaviour: the caption is
  // restored to the composer and the failed bubble stays visible until a
  // re-send is actually dispatched. A fix that quietly removes the bubble is
  // a regression, not a fix.
  // Mutation: add this.#messageList?.removeRow(msgId) in #retrySendFailed →
  // RED (the bubble is gone immediately after retry).
  it('F14_CONTROL_retry_restores_caption_and_keeps_bubble_visible', async () => {
    const { client, rejectDone } = makeLiveFailureClient({
      dismissFailedOutboxEntry: vi.fn(async () => {}),
    });

    const { el, textarea, failedBubble } = await liveSendFailureJourney(
      client, 'retry me caption', rejectDone,
    );

    // Click retry.
    const retryBtn = failedBubble.querySelector('.oxp-send-failed-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    // The caption was restored to the composer.
    expect(textarea.value).toBe('retry me caption');

    // The failed bubble is STILL visible (not removed by retry).
    expect(el.shadowRoot!.querySelector('[data-send-failed="true"]')).not.toBeNull();

    el.remove();
  });

  // ── H3/F2: flushOutbox is called on mount ───────────────────────────────
  //
  // flushOutbox retries queued outbox messages (transient failures from a
  // prior session) and marks orphaned pendingAttachments as sendFailed. Without
  // a driver it is dead code — nothing calls it. The widget must call it on
  // mount so queued messages are retried when the user returns.
  //
  // Mutation: delete the flushOutbox call in #bootstrap → RED (the spy is
  // never called).
  it('F2_flushOutbox_called_on_mount', async () => {
    const client = makeFailedOutboxClient([]);
    const el = await mountWithClient(client);

    // flushOutbox was called with the room ID on mount.
    expect(client.flushOutbox).toHaveBeenCalledWith('room1');

    el.remove();
  });

  // ── #261: the widget surfaces the loss of durability ──────────────────────
  //
  // Journey: an integrator embeds the widget on a partner site and the visitor
  // is in Safari private browsing. Sending keeps working, but nothing is
  // persisted — so a "we lost your message" support ticket cannot be told apart
  // from "durability was never available in this browser". The widget must say
  // so once, through the error channel that already exists.
  it('F5_widget_reports_lost_durability_once_through_config_onError', async () => {
    outboxState.degradation = { op: 'enqueue' };
    const onError = vi.fn();
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => makeFailedOutboxClient([]), onError });
    document.body.appendChild(el);
    await waitForReady(el);

    const codes = onError.mock.calls.map((c) => (c[0] as { code?: string })?.code);
    expect(codes.filter((c) => c === 'OUTBOX_UNAVAILABLE')).toHaveLength(1);
    el.remove();
  });

  it('F8_removing_the_element_disposes_the_outbox_subscription', async () => {
    // Review of #264: both teardown paths dismantled everything EXCEPT this
    // subscription, so the listener outlived its element and a re-mount stacked
    // another one in the SDK's module-level set, which nothing else clears.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => makeFailedOutboxClient([]) });
    document.body.appendChild(el);
    await waitForReady(el);

    expect(outboxState.disposed).toBe(0);
    el.remove();
    expect(outboxState.disposed).toBe(1);
  });

  it('F9_degradation_after_mount_is_reported_live_not_only_on_replay', async () => {
    // Review of #264 finding 8: F5 drove degradation BEFORE subscribe, so it
    // only ever exercised the replay branch. The live path — storage fails while
    // the widget is already mounted — was the primary one and had no gate.
    const onError = vi.fn();
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => makeFailedOutboxClient([]), onError });
    document.body.appendChild(el);
    await waitForReady(el);

    expect(onError.mock.calls.map((c) => (c[0] as { code?: string })?.code))
      .not.toContain('OUTBOX_UNAVAILABLE');

    // Storage dies now, with the widget already up.
    expect(outboxState.listener, 'widget must have subscribed').not.toBeNull();
    outboxState.listener!({ op: 'enqueue' });

    const errs = onError.mock.calls
      .map((c) => c[0] as { code?: string; outboxOp?: string })
      .filter((e) => e?.code === 'OUTBOX_UNAVAILABLE');
    expect(errs).toHaveLength(1);
    // Finding 6b: the op is a field, not something to parse out of the message.
    expect(errs[0]!.outboxOp).toBe('enqueue');
    el.remove();
  });

  it('F10_outbox_unavailable_is_dispatched_as_a_dom_event_too', async () => {
    // Finding 8: F5 asserted only the onError callback. An integrator listening
    // on the element — the documented route in docs/embedding.md — was ungated,
    // so dropping the dispatchEvent would have kept every test green.
    const seen: Array<{ code?: string; outboxOp?: string }> = [];
    document.addEventListener('oxpulse-chat:error', (e) => {
      seen.push((e as CustomEvent).detail);
    });
    outboxState.degradation = { op: 'dequeue' };
    const el = await mountWithClient(makeFailedOutboxClient([]));

    const hits = seen.filter((d) => d?.code === 'OUTBOX_UNAVAILABLE');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.outboxOp).toBe('dequeue');
    el.remove();
  });

  it('F11_a_remount_does_not_report_the_same_degradation_twice', async () => {
    // Finding 3a: the SDK latches the first transition but replays it to every
    // new subscriber, so re-mounting re-reported and the docs' "once per page"
    // was false. Dedup is per element instance.
    outboxState.degradation = { op: 'pending' };
    const onError = vi.fn();
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => makeFailedOutboxClient([]), onError });
    document.body.appendChild(el);
    await waitForReady(el);

    const count = () =>
      onError.mock.calls.filter((c) => (c[0] as { code?: string })?.code === 'OUTBOX_UNAVAILABLE')
        .length;
    expect(count()).toBe(1);

    el.remove();
    document.body.appendChild(el);
    await waitForReady(el);

    expect(count(), 'a re-mount must not re-report the same degradation').toBe(1);
    el.remove();
  });

  it('F6_CONTROL_no_degradation_no_report', async () => {
    // Without this, F5 would pass against a widget that reports unconditionally.
    outboxState.degradation = null;
    const onError = vi.fn();
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el._setCallbacks({ _createClient: () => makeFailedOutboxClient([]), onError });
    document.body.appendChild(el);
    await waitForReady(el);

    const codes = onError.mock.calls.map((c) => (c[0] as { code?: string })?.code);
    expect(codes).not.toContain('OUTBOX_UNAVAILABLE');
    el.remove();
  });

});
