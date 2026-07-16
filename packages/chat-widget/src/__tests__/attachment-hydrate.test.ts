/**
 * attachment-hydrate.test.ts — attachment hydration cluster (review findings 2–5).
 *
 * Covers the repo-review-council findings against src/ui/message-list.ts:
 *  #2  permanent HTTP status (403/404/410) → no retry (exactly 1 fetch then fallback);
 *      transient (429) → retries as before.
 *  #3  click-handler hydrate calls (buildAttachmentImg / renderAttachment file link)
 *      thread the AbortSignal and guard signal.aborted before trackObjectUrl/window.open,
 *      so a click resolving AFTER destroy() doesn't push a fresh blob: URL into the
 *      already-swept #attachmentObjectUrls map (never revoked).
 *  #4  onAttachmentError callback fires once per attachment on FINAL failure (not per
 *      retry), deduped across re-renders of the same attachment.
 *  #5  hydration backoff reuses the existing BackoffStrategy class (reconnect.ts) —
 *      asserted via fetch call counts/ordering, not exact ms (BackoffStrategy jitter
 *      only kicks in past attempt 4, but counts stay robust).
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';

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

let capturedOnMessage: ((row: MessageRow) => void) | null = null;

function makeMockClient(fetchImpl?: (url: string, signal?: AbortSignal) => Promise<Blob>): MessageListClient {
  capturedOnMessage = null;
  const client: MessageListClient = {
    list: () => Promise.resolve({ items: [], hasNext: false }),
    subscribe: (_roomId: string, args: { onMessage: (row: MessageRow) => void }) => {
      capturedOnMessage = args.onMessage;
      return () => { /* unsubscribe */ };
    },
  };
  if (fetchImpl) client.fetchAttachmentBlob = fetchImpl;
  return client;
}

const IMG_ATT = {
  id: 'att-img-1',
  url: 'https://x.example/api/sdk/attachments/att-img-1',
  mime: 'image/png',
  filename: 'photo.png',
  sizeBytes: 100,
  width: 640,
  height: 480,
};

const FILE_ATT = {
  id: 'att-file-1',
  url: 'https://x.example/api/sdk/attachments/att-file-1',
  mime: 'application/pdf',
  filename: 'doc.pdf',
  sizeBytes: 100,
};

/** Duck-typed hydrate error carrying an HTTP status — the shape the retry loop
 *  must inspect to distinguish permanent (403/404/410) from transient failures. */
function hydrateError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe('MessageList — attachment hydration cluster', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (container.parentNode) container.parentNode.removeChild(container);
    capturedOnMessage = null;
    vi.restoreAllMocks();
  });

  // ── #2: permanent status → no retry; transient → retries ───────────────────

  it('permanent_404_skips_retries_one_fetch_then_fallback', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(hydrateError(404));
    const client = makeMockClient(fetchSpy);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm1', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();

    // Exactly ONE authed fetch — no pointless retries for a gone attachment.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Final-failure fallback: data attribute + direct URL.
    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('data-hydrate-failed')).toBe('true');
    expect(img!.src).toBe(IMG_ATT.url);
    ml.destroy();
  });

  it('permanent_403_skips_retries', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(hydrateError(403));
    const client = makeMockClient(fetchSpy);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm2', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    ml.destroy();
  });

  it('permanent_410_skips_retries', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(hydrateError(410));
    const client = makeMockClient(fetchSpy);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm3', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    ml.destroy();
  });

  it('transient_429_retries_then_falls_back', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(hydrateError(429));
    const client = makeMockClient(fetchSpy);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm4', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    // 1 initial attempt + 3 retries = 4 fetches, then final-failure fallback.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('data-hydrate-failed')).toBe('true');
    ml.destroy();
  });

  // ── #5: BackoffStrategy reuse — bounded to 3 retries (4 total attempts) ────

  it('retries_bounded_to_3_max_uses_BackoffStrategy_delays', async () => {
    // BackoffStrategy is deterministic for attempts 1–3 (delayMs(1)=1000,
    // delayMs(2)=2000, delayMs(3)=4000 — no jitter below attempt 5). Assert the
    // inter-call delays match BackoffStrategy exactly, proving the hardcoded
    // HYDRATE_BACKOFF_MS=[500,1000,2000] array was replaced by the shared class.
    // Pre-fix the array yields [500,1000,2000] → this REDs; post-fix yields
    // [1000,2000,4000] → GREENs. Exact-ms is safe here (no jitter at these attempts).
    const { BackoffStrategy } = await import('../ui/reconnect.js');
    const strategy = new BackoffStrategy();
    const expectedInterDelays = [strategy.delayMs(1), strategy.delayMs(2), strategy.delayMs(3)];

    const callTimes: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(() => {
      callTimes.push(Date.now());
      return Promise.reject(hydrateError(500));
    });
    const client = makeMockClient(fetchImpl);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm5', seq: 1, attachments: [IMG_ATT] }));

    // Advance past the longest cumulative delay (1000+2000+4000=7000) so every
    // scheduled retry fires at its real time. Date.now() advances with fake timers.
    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    expect(fetchImpl).toHaveBeenCalledTimes(4); // bounded — no 5th attempt
    expect(callTimes).toHaveLength(4);
    // Initial call at t=0; retries at cumulative BackoffStrategy delays.
    const interDelays = [
      callTimes[1]! - callTimes[0]!,
      callTimes[2]! - callTimes[1]!,
      callTimes[3]! - callTimes[2]!,
    ];
    expect(interDelays).toEqual(expectedInterDelays);
    ml.destroy();
  });

  // ── #3: abort signal threaded into click-handler hydrate calls ─────────────

  it('image_click_hydrate_after_destroy_does_not_leak_blob_url', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:click-leak');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    // fetchAttachmentBlob returns a promise we control so we can resolve it AFTER destroy().
    let resolveClick!: (b: Blob) => void;
    let resolveInitial!: (b: Blob) => void;
    const fetchImpl = vi.fn().mockImplementation(() => {
      // Distinguish the click-path call (2nd) from the initial hydrateMediaSrc call (1st)
      // by returning a fresh controllable promise each time.
      return new Promise<Blob>((res) => {
        if (fetchImpl.mock.calls.length === 1) resolveInitial = res;
        else resolveClick = res;
      });
    });
    const client = makeMockClient(fetchImpl);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm6', seq: 1, attachments: [IMG_ATT] }));
    await drainMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // initial hydrateMediaSrc in flight

    const img = container.querySelector('.oxp-attachment-image img') as HTMLImageElement | null;
    expect(img).not.toBeNull();

    // Tear down BEFORE the click resolves — signal is now aborted.
    ml.destroy();
    const createCountAfterDestroy = createSpy.mock.calls.length;

    // Click the (now detached) image — the click handler fires hydrate(att.url, signal).
    img!.click();
    await drainMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // click-path fetch issued

    // Resolve the click-path fetch AFTER destroy — must NOT create a blob URL or open a tab.
    resolveClick(new Blob(['x'], { type: 'image/png' }));
    // Also resolve the initial (guarded by hydrateMediaSrc already) — must be a no-op too.
    resolveInitial(new Blob(['x'], { type: 'image/png' }));
    await drainMicrotasks();

    expect(createSpy.mock.calls.length).toBe(createCountAfterDestroy); // no new blob: URL
    expect(openSpy).not.toHaveBeenCalled(); // no window.open after destroy
    createSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('file_link_click_hydrate_after_destroy_does_not_leak_blob_url', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:file-leak');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    // The generic file-link path does NOT hydrate on render (only images/audio
    // do) — it sets link.href and hydrates on click. So a single controllable
    // promise is enough: it captures the click-path fetch.
    let resolveClick!: (b: Blob) => void;
    const fetchImpl = vi.fn().mockImplementation(() => {
      return new Promise<Blob>((res) => { resolveClick = res; });
    });
    const client = makeMockClient(fetchImpl);
    const ml = new MessageList({ client, roomId: 'r1', container, lang: 'en', selfUid: 'u1' });
    await ml.mount();

    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm7', seq: 1, attachments: [FILE_ATT] }));
    await drainMicrotasks();
    // No render-time hydration for the file path — fetch not yet called.
    expect(fetchImpl).toHaveBeenCalledTimes(0);

    // Generic file link path — no <img>, the click handler is on the <a> element.
    const link = container.querySelector('.oxp-attachment-file') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();

    ml.destroy();
    const createCountAfterDestroy = createSpy.mock.calls.length;

    link!.click();
    await drainMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // click-path fetch issued

    resolveClick(new Blob(['x'], { type: 'application/pdf' }));
    await drainMicrotasks();

    expect(createSpy.mock.calls.length).toBe(createCountAfterDestroy); // no new blob: URL
    expect(openSpy).not.toHaveBeenCalled(); // no window.open after destroy
    createSpy.mockRestore();
    openSpy.mockRestore();
  });

  // ── #4: onAttachmentError callback — fires once on final failure, deduped ─

  it('onAttachmentError_fires_once_on_permanent_failure', async () => {
    const errors: Array<{ msgId: string; attachmentId: string }> = [];
    const client = makeMockClient(vi.fn().mockRejectedValue(hydrateError(404)));
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAttachmentError: (msgId, attachmentId) => errors.push({ msgId, attachmentId }),
    } as Partial<Parameters<typeof MessageList>[0]> & Parameters<typeof MessageList>[0]);
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm-err-1', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.msgId).toBe('m-err-1');
    expect(errors[0]!.attachmentId).toBe('att-img-1');
    ml.destroy();
  });

  it('onAttachmentError_fires_once_after_transient_retries_exhausted_not_per_retry', async () => {
    const errors: Array<{ msgId: string; attachmentId: string }> = [];
    const client = makeMockClient(vi.fn().mockRejectedValue(hydrateError(429)));
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAttachmentError: (msgId, attachmentId) => errors.push({ msgId, attachmentId }),
    } as Partial<Parameters<typeof MessageList>[0]> & Parameters<typeof MessageList>[0]);
    await ml.mount();
    capturedOnMessage!(makeRow({ senderUid: 'u1', msgId: 'm-err-2', seq: 1, attachments: [IMG_ATT] }));
    await vi.runAllTimersAsync();
    await drainMicrotasks();

    // 4 fetch attempts (1 + 3 retries) but only ONE error event — not per retry.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msgId).toBe('m-err-2');
    ml.destroy();
  });

  it('onAttachmentError_deduped_across_re_render_of_same_attachment', async () => {
    const errors: Array<{ msgId: string; attachmentId: string }> = [];
    const client = makeMockClient(vi.fn().mockRejectedValue(hydrateError(404)));
    const ml = new MessageList({
      client, roomId: 'r1', container, lang: 'en', selfUid: 'u1',
      onAttachmentError: (msgId, attachmentId) => errors.push({ msgId, attachmentId }),
    } as Partial<Parameters<typeof MessageList>[0]> & Parameters<typeof MessageList>[0]);
    await ml.mount();
    const row = makeRow({ senderUid: 'u1', msgId: 'm-err-3', seq: 1, attachments: [IMG_ATT] });
    capturedOnMessage!(row);
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    expect(errors).toHaveLength(1);

    // Re-deliver the same row (e.g. a mutation SSE re-renders the bubble) — the
    // same attachment's final failure must not fire the event a second time.
    capturedOnMessage!(row);
    await vi.runAllTimersAsync();
    await drainMicrotasks();
    expect(errors).toHaveLength(1);
    ml.destroy();
  });
});
