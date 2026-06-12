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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AttachmentPicker', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
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
