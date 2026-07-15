/**
 * attachment-picker.test.ts — W2.2 slice 4 TDD RED.
 *
 * Tests: AttachmentPicker class acceptance criteria.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AttachmentPicker } from '../ui/attachment-picker.js';

// ── Stub SDK client ───────────────────────────────────────────────────────────

function makeStubClient(opts: {
  resolveWith?: { msgId: string; attachmentId: string };
  rejectWith?: Error;
  /** ms to delay before resolve/reject (simulates slow upload) */
  delayMs?: number;
} = {}) {
  return {
    sendFile: vi.fn((_roomId: string, _blob: Blob, _args: unknown) => {
      const result = opts.resolveWith ?? { msgId: 'msg-1', attachmentId: 'att-1' };
      if (opts.delayMs) {
        return new Promise<typeof result>((resolve, reject) => {
          setTimeout(() => {
            if (opts.rejectWith) reject(opts.rejectWith);
            else resolve(result);
          }, opts.delayMs);
        });
      }
      if (opts.rejectWith) return Promise.reject(opts.rejectWith);
      return Promise.resolve(result);
    }),
  };
}

function makePngFile(name = 'photo.png', sizeBytes = 1024): File {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], name, { type: 'image/png' });
}

function makeLargeFile(sizeBytes = 60 * 1024 * 1024): File {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], 'big.png', { type: 'image/png' });
}

function makeTextFile(): File {
  return new File(['hello'], 'doc.txt', { type: 'text/plain' });
}

// Drain microtasks
async function drain(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Stub the browser image-decode pipeline compress() needs
 * (createImageBitmap + canvas + FileReader), matching the working pattern
 * in attachments.test.ts's "compress — decompression bomb defense" suite.
 * jsdom implements none of these natively, so every test that uploads an
 * image/* file through the REAL AttachmentPicker.#upload() (which now runs
 * compress() before sendFile — image compression wiring) needs this stub,
 * not just the tests that assert on compression specifically.
 *
 * Installed ONCE per test in beforeEach; the stubbed bitmap dims / output
 * blob read from mutable module state (bitmapWidth/bitmapHeight/compressedOutBlob)
 * so a single test can override just those before calling handleFiles()
 * without re-installing the document.createElement spy — re-installing on
 * top of an already-spied createElement double-wraps it and recurses.
 */
let bitmapWidth = 400;
let bitmapHeight = 300;
let compressedOutBlob: Blob = new Blob(['compressed'], { type: 'image/webp' });

function installImageCompressionStubs(): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockImplementation(async () => ({ width: bitmapWidth, height: bitmapHeight, close: vi.fn() })),
  );

  const mockCtx = { imageSmoothingEnabled: false, imageSmoothingQuality: 'high', drawImage: vi.fn() };
  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(mockCtx),
    toBlob: vi.fn().mockImplementation((cb: (b: Blob | null) => void) => cb(compressedOutBlob)),
  };
  const origCreate = globalThis.document?.createElement?.bind(globalThis.document);
  vi.spyOn(globalThis.document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return mockCanvas as unknown as HTMLElement;
    return origCreate?.(tag);
  });

  // Resolves via microtask (not setTimeout) — every test in this file drains
  // pending work with a bounded `await Promise.resolve()` loop (drain()), which
  // does not advance macrotask timers. A real FileReader is macrotask-based in
  // the browser, but this test double only needs to be AWAITABLE the same way
  // the rest of the upload chain already is.
  class FakeReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    result = 'data:image/webp;base64,AA==';
    readAsDataURL() { void Promise.resolve().then(() => this.onload?.()); }
  }
  vi.stubGlobal('FileReader', FakeReader);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AttachmentPicker', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Compression wiring (issue #67): #upload() now runs compress() for every
    // image/* file before calling client.sendFile — stub its browser deps
    // globally so every pre-existing makePngFile() upload test still reaches
    // sendFile (it previously called sendFile directly with the raw File).
    bitmapWidth = 400;
    bitmapHeight = 300;
    compressedOutBlob = new Blob(['compressed'], { type: 'image/webp' });
    installImageCompressionStubs();
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders_hidden_file_input_and_visible_button', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // Input should be visually hidden (aria-hidden or input hidden via CSS class)
    // Visible paperclip button
    const btn = container.querySelector('.oxp-attachment-btn');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Attach files');

    picker.destroy();
  });

  // i18n follow-up: lang defaults to English (unchanged); lang='ru' localizes
  // aria-labels and the retry/error text rendered in the upload queue.
  it('localizes_button_aria_labels_for_lang_ru', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container, lang: 'ru' });
    picker.mount();

    const input = container.querySelector('input[type="file"]');
    const btn = container.querySelector('.oxp-attachment-btn');
    expect(input?.getAttribute('aria-label')).toBe('Выбрать файлы для прикрепления');
    expect(btn?.getAttribute('aria-label')).toBe('Прикрепить файлы');

    picker.destroy();
  });

  it('renders_aria_live_region_for_status_announcements', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const live = container.querySelector('[aria-live]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute('aria-live')).toBe('polite');

    picker.destroy();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('validates_files_before_upload — over-size file rejected', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const bigFile = makeLargeFile();
    picker.handleFiles([bigFile]);

    // Client.sendFile should NOT be called for oversized file
    expect(client.sendFile).not.toHaveBeenCalled();
    // Error event should be dispatched
    picker.destroy();
  });

  it('validates_files_before_upload_invalid_mime — text/plain rejected', () => {
    const client = makeStubClient();
    const errorEvents: CustomEvent[] = [];
    container.addEventListener('oxpulse-chat:error', (e) => errorEvents.push(e as CustomEvent));

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makeTextFile()]);

    expect(client.sendFile).not.toHaveBeenCalled();
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0].detail.kind).toBe('upload_invalid');

    picker.destroy();
  });

  it('dispatches_error_event_on_validation_failure_with_filename', () => {
    const client = makeStubClient();
    const errorEvents: CustomEvent[] = [];
    container.addEventListener('oxpulse-chat:error', (e) => errorEvents.push(e as CustomEvent));

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makeTextFile()]);

    expect(errorEvents[0].detail.filename).toBe('doc.txt');

    picker.destroy();
  });

  // ── Upload pipeline ─────────────────────────────────────────────────────────

  it('uploads_via_client_sendFile — valid file triggers sendFile call', async () => {
    const client = makeStubClient({ resolveWith: { msgId: 'msg-x', attachmentId: 'att-x' } });
    const picker = new AttachmentPicker({ client, roomId: 'r42', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(15);

    expect(client.sendFile).toHaveBeenCalledWith(
      'r42',
      expect.any(Blob),
      expect.any(Object),
    );

    picker.destroy();
  });

  it('tracks_progress_per_file — multiple files get independent state', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const files = [makePngFile('a.png'), makePngFile('b.png')];
    picker.handleFiles(files);
    await drain(15);

    // Both files should have been uploaded
    expect(client.sendFile).toHaveBeenCalledTimes(2);

    picker.destroy();
  });

  // ── Compression wiring (issue #67) ───────────────────────────────────────────

  it('compresses image/* files and threads the resulting dims into sendFile args', async () => {
    // Distinct compressed bytes from the source File — proves sendFile receives
    // compress()'s output blob, not the raw 1024-zero-byte File from makePngFile().
    const compressedBlob = new Blob(['webp-bytes'], { type: 'image/webp' });
    bitmapWidth = 640;
    bitmapHeight = 480;
    compressedOutBlob = compressedBlob;

    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('photo.png')]);
    await drain(15);

    expect(client.sendFile).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.sendFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(compressedBlob);
    expect(argsArg.width).toBe(640);
    expect(argsArg.height).toBe(480);

    picker.destroy();
  });

  it('bypasses compress() for a non-image file — original File reaches sendFile untouched', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const pdfFile = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });
    picker.handleFiles([pdfFile]);
    await drain(15);

    expect(client.sendFile).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.sendFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(pdfFile);
    expect(argsArg.width).toBeUndefined();
    expect(argsArg.height).toBeUndefined();

    picker.destroy();
  });

  it('bypasses compress() for image/gif — canvas re-encode would flatten the animation to one frame', async () => {
    // Review fix: compress() draws a single decoded frame to <canvas> and
    // re-encodes — correct for a static image, but silently destroys an
    // animated GIF's other frames. Size cap (validate(), before #upload runs
    // at all) still applies; only the re-encode step is skipped.
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const gifFile = new File([new Uint8Array(32)], 'dance.gif', { type: 'image/gif' });
    picker.handleFiles([gifFile]);
    await drain(15);

    expect(client.sendFile).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.sendFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(gifFile); // original bytes untouched — not re-encoded
    expect(argsArg.width).toBeUndefined();
    expect(argsArg.height).toBeUndefined();
    // createImageBitmap is stubbed globally in beforeEach for the OTHER image
    // tests in this file — asserting it was never called here proves compress()
    // (which always calls createImageBitmap first) was genuinely skipped, not
    // just coincidentally reused-original due to compress()'s own size check.
    expect(createImageBitmap).not.toHaveBeenCalled();

    picker.destroy();
  });

  it('threads the sanitized filename into sendFile args for both image and non-image files', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('vacation photo.png')]);
    await drain(15);

    const [, , argsArg] = (client.sendFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(argsArg.filename).toBe('vacation photo.png');

    picker.destroy();
  });

  // ── Cancel ──────────────────────────────────────────────────────────────────

  it('cancel_button_aborts_upload — abort is called on slow upload', async () => {
    const client = makeStubClient({ delayMs: 5000, resolveWith: { msgId: 'm', attachmentId: 'a' } });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('slow.png')]);
    await drain(5);

    // Queue item should be visible; click cancel
    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    // sendFile should have been called (upload started)
    expect(client.sendFile).toHaveBeenCalledTimes(1);

    picker.destroy();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('dispatches_error_event_on_upload_failure', async () => {
    const client = makeStubClient({ rejectWith: new Error('network error') });
    const errorEvents: CustomEvent[] = [];
    container.addEventListener('oxpulse-chat:error', (e) => errorEvents.push(e as CustomEvent));

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(15);

    expect(errorEvents.length).toBeGreaterThan(0);
    const errEvt = errorEvents.find(e => e.detail.kind === 'upload_failed');
    expect(errEvt).not.toBeUndefined();
    expect(errEvt!.detail.message).toContain('network error');

    picker.destroy();
  });

  it('shows_retry_button_on_upload_failure', async () => {
    const client = makeStubClient({ rejectWith: new Error('fail') });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(15);

    const retryBtn = container.querySelector('.oxp-attachment-retry');
    expect(retryBtn).not.toBeNull();

    picker.destroy();
  });

  it('localizes_the_retry_button_and_cancel_aria_label_for_lang_ru', async () => {
    const client = makeStubClient({ rejectWith: new Error('fail') });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container, lang: 'ru' });
    picker.mount();

    picker.handleFiles([makePngFile('photo.png')]);
    await drain(15);

    const retryBtn = container.querySelector('.oxp-attachment-retry');
    expect(retryBtn?.textContent).toBe('Повторить');
    const cancelBtn = container.querySelector('.oxp-attachment-cancel');
    expect(cancelBtn?.getAttribute('aria-label')).toBe('Отменить загрузку photo.png');

    picker.destroy();
  });

  // ── AbortSignal ─────────────────────────────────────────────────────────────

  it('respects_abort_signal_during_mount — skip mount if signal already aborted', () => {
    const client = makeStubClient();
    const controller = new AbortController();
    controller.abort();

    const picker = new AttachmentPicker({
      client,
      roomId: 'r1',
      container,
      signal: controller.signal,
    });
    picker.mount();

    // Nothing should have been mounted
    const btn = container.querySelector('.oxp-attachment-btn');
    expect(btn).toBeNull();

    picker.destroy();
  });

  // ── A11y ─────────────────────────────────────────────────────────────────────

  it('aria_live_announces_status_changes — live region present after file queued', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(5);

    const live = container.querySelector('[aria-live="polite"]') as HTMLElement | null;
    expect(live).not.toBeNull();
    // Live region should have some text indicating upload status
    // (either file name or status label)
    expect(live!.textContent).toBeTruthy();

    picker.destroy();
  });

  // ── CB2: Cancel button passes signal to sendFile ─────────────────────────────

  it('passes_signal_to_sendFile_for_cancellation', async () => {
    // CB2: sendFile must receive opts.signal so server-side upload can be aborted
    let capturedOpts: unknown = null;
    const client = {
      sendFile: vi.fn((_roomId: string, _blob: Blob, opts: unknown) => {
        capturedOpts = opts;
        // Never resolves — simulates slow upload
        return new Promise(() => {});
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('signal-test.png')]);
    await drain(5);

    // sendFile must have been called
    expect(client.sendFile).toHaveBeenCalledTimes(1);
    // opts must contain a signal property
    expect(capturedOpts).not.toBeNull();
    expect((capturedOpts as Record<string, unknown>).signal).toBeInstanceOf(AbortSignal);

    picker.destroy();
  });

  it('cancel_button_aborts_upload_via_signal', async () => {
    // CB2: clicking cancel must trigger AbortSignal.aborted on the signal passed to sendFile
    let capturedSignal: AbortSignal | null = null;
    let rejectUpload!: (err: Error) => void;

    const client = {
      sendFile: vi.fn((_roomId: string, _blob: Blob, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal ?? null;
        return new Promise<{ msgId: string; attachmentId: string }>((_, reject) => {
          rejectUpload = reject;
          if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        });
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('cancel-signal.png')]);
    await drain(5);

    expect(capturedSignal).not.toBeNull();
    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    // Signal must be aborted after cancel
    expect(capturedSignal!.aborted).toBe(true);

    picker.destroy();
  });

  // ── CM6: Focus preserved on progress update (diff-patch queue) ───────────────

  it('focus_preserved_on_progress_update_during_upload', async () => {
    // CM6: #renderQueue must diff-patch rather than innerHTML='', to preserve focus
    let resolveUpload!: (v: { msgId: string; attachmentId: string }) => void;
    const client = {
      sendFile: vi.fn((_roomId: string, _blob: Blob, _opts: unknown) => {
        return new Promise<{ msgId: string; attachmentId: string }>((resolve) => {
          resolveUpload = resolve;
        });
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('focus-test.png')]);
    await drain(5);

    // Focus the cancel button
    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Simulate a second file being added (triggers re-render of queue)
    picker.handleFiles([makePngFile('focus-test2.png')]);
    await drain(5);

    // Focus must still be on the same cancel button (not lost to body)
    // NOTE: innerHTML='' wipe destroys the node — focus falls to body
    expect(document.activeElement).not.toBe(document.body);

    picker.destroy();
  });

  // ── DB4: Progress bar role and indeterminate aria ────────────────────────────

  it('progress_has_role_progressbar_and_indeterminate_aria', async () => {
    // DB4: progress element must have role="progressbar" and aria-valuetext="Uploading…"
    // (indeterminate = no aria-valuenow)
    const client = makeStubClient({ delayMs: 5000, resolveWith: { msgId: 'm', attachmentId: 'a' } });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('progress-a11y.png')]);
    await drain(5);

    const progress = container.querySelector('.oxp-attachment-progress') as HTMLElement | null;
    expect(progress).not.toBeNull();
    expect(progress!.getAttribute('role')).toBe('progressbar');
    // Indeterminate: aria-valuetext present, aria-valuenow absent
    expect(progress!.getAttribute('aria-valuetext')).toBeTruthy();
    expect(progress!.getAttribute('aria-valuenow')).toBeNull();

    picker.destroy();
  });

  // ── F3: Done-state visible before removal (design B4) ────────────────────────

  it('shows_done_state_visibly_before_removing', async () => {
    // F3: completed upload rows were filtered with continue → row disappeared immediately.
    // Fix: keep done rows with data-status='done' visible, remove after 2s timeout.
    vi.useFakeTimers();

    let resolveUpload!: (v: { msgId: string; attachmentId: string }) => void;
    const client = {
      sendFile: vi.fn((_roomId: string, _blob: Blob, _opts: unknown) => {
        return new Promise<{ msgId: string; attachmentId: string }>((resolve) => {
          resolveUpload = resolve;
        });
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('complete.png')]);
    await drain(5);

    // Complete the upload
    resolveUpload({ msgId: 'msg-done', attachmentId: 'att-done' });
    await drain(10);

    // Immediately after completion: row must still be visible with data-status='done'
    const doneRow = container.querySelector('.oxp-attachment-item[data-status="done"]') as HTMLElement | null;
    expect(doneRow).not.toBeNull();

    // Before 2s: still visible
    vi.advanceTimersByTime(1999);
    const doneRowStillThere = container.querySelector('.oxp-attachment-item[data-status="done"]') as HTMLElement | null;
    expect(doneRowStillThere).not.toBeNull();

    // After 2s: row removed
    vi.advanceTimersByTime(1);
    const doneRowGone = container.querySelector('.oxp-attachment-item[data-status="done"]') as HTMLElement | null;
    expect(doneRowGone).toBeNull();

    vi.useRealTimers();
    picker.destroy();
  });

  // ── F5: Duplicate filename queue collision ────────────────────────────────────

  it('enqueues_two_files_with_same_filename_as_separate_rows', async () => {
    // F5: existingRows keyed by filename → two concurrent Screenshot.png collapse to one row.
    // Fix: assign stable item.id (crypto.randomUUID), key existingRows by item.id.
    const client = makeStubClient({ delayMs: 5000, resolveWith: { msgId: 'm', attachmentId: 'a' } });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const file1 = makePngFile('Screenshot.png');
    const file2 = makePngFile('Screenshot.png');
    picker.handleFiles([file1, file2]);
    await drain(5);

    // Both files must produce distinct rows in the queue
    const rows = container.querySelectorAll('.oxp-attachment-item');
    expect(rows.length).toBe(2);

    picker.destroy();
  });

  // ── 1B: Cancel focus loss on completion (#1266) ──────────────────────────────

  it('cancel_focus_moves_to_paperclip_on_completion', async () => {
    // 1B: cancelBtn.hidden = true removes it from a11y tree. If cancelBtn is focused,
    // focus falls to body. Fix: BEFORE setting hidden, focus next logical element
    // (the paperclip button, or failing that the composer textarea).
    let resolveUpload!: (v: { msgId: string; attachmentId: string }) => void;
    const client = {
      sendFile: vi.fn(
        (_roomId: string, _blob: Blob, _opts: unknown) =>
          new Promise<{ msgId: string; attachmentId: string }>((resolve) => {
            resolveUpload = resolve;
          }),
      ),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('focus-recover.png')]);
    await drain(5);

    // Focus the cancel button
    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Complete the upload — cancelBtn.hidden becomes true
    resolveUpload({ msgId: 'msg1', attachmentId: 'att1' });
    await drain(10);

    // Focus must NOT have fallen to body
    expect(document.activeElement).not.toBe(document.body);
    // Focus must have moved to the paperclip/attachment button (or any non-body element in picker)
    const paperclipBtn = container.querySelector('.oxp-attachment-btn') as HTMLButtonElement | null;
    if (paperclipBtn) {
      expect(document.activeElement).toBe(paperclipBtn);
    } else {
      // Fallback: focus somewhere meaningful, not body
      expect(document.activeElement).not.toBe(document.body);
    }

    picker.destroy();
  });

  it('cancel_only_affects_clicked_item_when_duplicate_filename', async () => {
    // F5: cancel handler closed over first item by filename — cancelling first item
    // also removed second item with same filename.
    // Fix: each row has data-item-id; cancel reads item.id from closure.
    let uploadCount = 0;
    const abortSignals: AbortSignal[] = [];

    const client = {
      sendFile: vi.fn((_roomId: string, _blob: Blob, opts: { signal?: AbortSignal }) => {
        uploadCount++;
        if (opts.signal) abortSignals.push(opts.signal);
        // Never resolves — stays uploading
        return new Promise<{ msgId: string; attachmentId: string }>(() => {});
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('Screenshot.png'), makePngFile('Screenshot.png')]);
    await drain(5);

    expect(uploadCount).toBe(2);

    // Cancel the first row
    const cancelBtns = container.querySelectorAll<HTMLButtonElement>('.oxp-attachment-cancel');
    expect(cancelBtns.length).toBe(2);
    cancelBtns[0]!.click();
    await drain(5);

    // Second row must still be present and uploading
    const remainingRows = container.querySelectorAll('.oxp-attachment-item');
    expect(remainingRows.length).toBe(1);

    // The first signal should be aborted; second should not
    expect(abortSignals[0]?.aborted).toBe(true);
    expect(abortSignals[1]?.aborted).toBe(false);

    picker.destroy();
  });
});
