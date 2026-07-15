/**
 * attachment-picker.test.ts — staged attachment tray (slice 3).
 *
 * Tests: AttachmentPicker stages files, uploads via uploadAttachment, and does
 * NOT send messages. getStaged/hasStaged/clearStaged/awaitAllUploaded wired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AttachmentPicker } from '../ui/attachment-picker.js';
import { THEME_CSS } from '../ui/theme.js';
import type { EnvelopeAttachment } from '../utils/attachment-envelope.js';

// ── Stub SDK client ───────────────────────────────────────────────────────────

function makeStubAttachment(args: {
  attachmentId?: string;
  blob?: Blob;
  mimeType?: string;
  filename?: string;
  width?: number;
  height?: number;
} = {}): { attachmentId: string; attachment: EnvelopeAttachment } {
  const attachmentId = args.attachmentId ?? 'att-1';
  const blob = args.blob ?? new Blob(['x'], { type: 'image/png' });
  return {
    attachmentId,
    attachment: {
      id: attachmentId,
      mime: args.mimeType ?? blob.type,
      filename: args.filename ?? 'file',
      sizeBytes: blob.size,
      width: args.width,
      height: args.height,
    },
  };
}

function makeStubClient(opts: {
  resolveWith?: { attachmentId: string; attachment: EnvelopeAttachment };
  rejectWith?: Error;
  delayMs?: number;
} = {}) {
  return {
    uploadAttachment: vi.fn((_roomId: string, blob: Blob, args: unknown) => {
      const a = args as {
        mimeType?: string;
        filename?: string;
        width?: number;
        height?: number;
      };
      const result = opts.resolveWith ?? makeStubAttachment({
        blob,
        mimeType: a.mimeType,
        filename: a.filename,
        width: a.width,
        height: a.height,
      });
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
    sendAttachmentMessage: vi.fn(),
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

async function drain(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

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

  it('renders_hidden_file_input_and_staging_tray', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // BUG-1: picker must not render its own visible button; composer.ts supplies the trigger.
    const btn = container.querySelector('.oxp-attachment-btn');
    expect(btn).toBeNull();
    const tray = container.querySelector('.oxp-attachment-queue');
    expect(tray).not.toBeNull();

    picker.destroy();
  });

  it('localizes_input_aria_label_for_lang_ru', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container, lang: 'ru' });
    picker.mount();

    const input = container.querySelector('input[type="file"]');
    expect(input?.getAttribute('aria-label')).toBe('Выбрать файлы для прикрепления');

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

  // ── Review fix (LOW, PR #88): tray group semantics ──────────────────────────
  it('staging_tray_has_group_role_and_an_accessible_name', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container, lang: 'ru' });
    picker.mount();

    const tray = container.querySelector('.oxp-attachment-queue');
    expect(tray?.getAttribute('role')).toBe('group');
    expect(tray?.getAttribute('aria-label')).toBe('Вложения для отправки');

    picker.destroy();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('validates_files_before_upload — over-size file rejected', () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makeLargeFile()]);
    expect(client.uploadAttachment).not.toHaveBeenCalled();

    picker.destroy();
  });

  it('validates_files_before_upload_invalid_mime — text/plain rejected', () => {
    const client = makeStubClient();
    const errorEvents: CustomEvent[] = [];
    container.addEventListener('oxpulse-chat:error', (e) => errorEvents.push(e as CustomEvent));

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makeTextFile()]);

    expect(client.uploadAttachment).not.toHaveBeenCalled();
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

  // ── Staging / upload pipeline ───────────────────────────────────────────────

  it('stages_and_uploads_but_does_not_send_a_message', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r42', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(15);

    expect(client.uploadAttachment).toHaveBeenCalledWith('r42', expect.any(Blob), expect.any(Object));
    expect(client.sendAttachmentMessage).not.toHaveBeenCalled();

    picker.destroy();
  });

  it('getStaged_reflects_done_items_with_attachmentId', async () => {
    const client = makeStubClient({ resolveWith: { attachmentId: 'att-x', attachment: { id: 'att-x', mime: 'image/png', filename: 'photo.png', sizeBytes: 100 } } });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile()]);
    await drain(15);

    const staged = picker.getStaged();
    expect(staged.length).toBe(1);
    expect(staged[0].status).toBe('done');
    expect(staged[0].attachmentId).toBe('att-x');

    picker.destroy();
  });

  it('tracks_progress_per_file — multiple files get independent uploads', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('a.png'), makePngFile('b.png')]);
    await drain(15);

    expect(client.uploadAttachment).toHaveBeenCalledTimes(2);

    picker.destroy();
  });

  it('compresses_image_files_and_threads_the_resulting_dims_into_uploadAttachment_args', async () => {
    const compressedBlob = new Blob(['webp-bytes'], { type: 'image/webp' });
    bitmapWidth = 640;
    bitmapHeight = 480;
    compressedOutBlob = compressedBlob;

    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('photo.png')]);
    await drain(15);

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(compressedBlob);
    expect(argsArg.width).toBe(640);
    expect(argsArg.height).toBe(480);

    picker.destroy();
  });

  it('bypasses_compress_for_a_non-image_file — original File reaches uploadAttachment untouched', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const pdfFile = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });
    picker.handleFiles([pdfFile]);
    await drain(15);

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(pdfFile);
    expect(argsArg.width).toBeUndefined();
    expect(argsArg.height).toBeUndefined();

    // Review fix (MEDIUM, PR #88): non-image preview (📎 + filename) is
    // shared between the 'uploading' and 'done' branches via
    // #renderNonImagePreview — assert the rendered card actually shows it
    // once uploaded, not just that upload args were correct.
    const nameEl = container.querySelector('.oxp-attachment-name');
    expect(nameEl?.textContent).toBe('doc.pdf');
    const card = container.querySelector('.oxp-attachment-item[data-status="done"]');
    expect(card?.textContent).toContain('📎');

    picker.destroy();
  });

  it('bypasses_compress_for_image_gif — canvas re-encode would_flatten_animation', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const gifFile = new File([new Uint8Array(32)], 'dance.gif', { type: 'image/gif' });
    picker.handleFiles([gifFile]);
    await drain(15);

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    const [, blobArg, argsArg] = (client.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(blobArg).toBe(gifFile);
    expect(argsArg.width).toBeUndefined();
    expect(argsArg.height).toBeUndefined();
    expect(createImageBitmap).not.toHaveBeenCalled();

    picker.destroy();
  });

  it('threads_the_sanitized_filename_into_uploadAttachment_args', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('vacation photo.png')]);
    await drain(15);

    const [, , argsArg] = (client.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Blob,
      Record<string, unknown>,
    ];
    expect(argsArg.filename).toBe('vacation photo.png');

    picker.destroy();
  });

  // ── Cancel / remove ─────────────────────────────────────────────────────────

  it('cancel_button_aborts_upload', async () => {
    const client = makeStubClient({ delayMs: 5000 });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('slow.png')]);
    await drain(5);

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(picker.hasStaged()).toBe(false);

    picker.destroy();
  });

  it('removing_a_staged_item_revokes_its_objectURL', async () => {
    const client = makeStubClient();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('remove.png')]);
    await drain(15);

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    expect(revokeSpy).toHaveBeenCalled();
    expect(picker.hasStaged()).toBe(false);

    picker.destroy();
  });

  // ── Review fix (LOW, PR #88): non-image objectURL isn't consumed by the
  // rendered preview (#renderNonImagePreview never reads item.objectURL —
  // only the image branch does) but IS still created for every file
  // regardless of mime type. Confirmed by reading every removal path
  // (destroy/clearStaged/cancel all call #revokeAllObjectURLs or
  // #revokeItemObjectURL unconditionally) that this is wasted-but-not-leaked;
  // these tests make that a regression guard instead of a one-time read.
  it('non_image_file_objectURL_is_revoked_on_cancel_even_though_the_preview_never_reads_it', async () => {
    const client = makeStubClient();
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const pdfFile = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });
    picker.handleFiles([pdfFile]);
    await drain(15);

    expect(createSpy).toHaveBeenCalledWith(pdfFile);
    const createdUrl = createSpy.mock.results[0]?.value as string;

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    expect(revokeSpy).toHaveBeenCalledWith(createdUrl);
    expect(picker.hasStaged()).toBe(false);

    picker.destroy();
  });

  it('non_image_file_objectURL_is_revoked_on_destroy', async () => {
    const client = makeStubClient();
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const pdfFile = new File(['%PDF-1.4'], 'doc2.pdf', { type: 'application/pdf' });
    picker.handleFiles([pdfFile]);
    await drain(15);

    const createdUrl = createSpy.mock.results[0]?.value as string;
    picker.destroy();

    expect(revokeSpy).toHaveBeenCalledWith(createdUrl);
  });

  // ── Review fix (CRITICAL, PR #88): computed style, not string-match ─────────
  //
  // theme.test.ts's cancel_retry_buttons_44px_on_mobile only string-matches the
  // CSS source text — it would stay green even while cancelBtn's inline
  // cssText hardcoded min-width/min-height:20px, because an inline style
  // always outranks a class rule regardless of what the class rule says. This
  // test renders the REAL THEME_CSS against a REAL staged cancelBtn and reads
  // getComputedStyle, which DOES reflect inline-vs-class specificity.
  //
  // jsdom does not implement the hover/pointer media features (verified
  // empirically: a @media(pointer:coarse) block never matches in jsdom), so
  // the touch 44px floor can't be exercised here — that remains
  // theme.test.ts's job. What IS fully verifiable in jsdom, and is exactly
  // what broke: whether the inline style still hardcodes a min-width/
  // min-height that would defeat ANY class rule, touch or not.
  it('cancel_button_min_size_comes_from_the_class_not_an_inline_override', async () => {
    const styleEl = document.createElement('style');
    styleEl.textContent = THEME_CSS;
    document.head.appendChild(styleEl);

    try {
      const client = makeStubClient();
      const picker = new AttachmentPicker({ client, roomId: 'r1', container });
      picker.mount();
      picker.handleFiles([makePngFile('cancel-size.png')]);
      await drain(15);

      const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
      expect(cancelBtn).not.toBeNull();

      // The bug: an inline min-width/min-height here always wins, so the class
      // rule (24px desktop, 44px touch) never gets a chance to apply.
      expect(cancelBtn!.style.minWidth).toBe('');
      expect(cancelBtn!.style.minHeight).toBe('');

      const computed = getComputedStyle(cancelBtn!);
      expect(computed.minWidth).toBe('24px');
      expect(computed.minHeight).toBe('24px');

      picker.destroy();
    } finally {
      styleEl.remove();
    }
  });

  it('clearStaged_revokes_all_remaining_objectURLs', async () => {
    const client = makeStubClient();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('a.png'), makePngFile('b.png')]);
    await drain(15);

    expect(picker.getStaged().length).toBe(2);
    picker.clearStaged();
    expect(picker.hasStaged()).toBe(false);
    expect(revokeSpy).toHaveBeenCalledTimes(2);

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

    const errEvt = errorEvents.find((e) => e.detail.kind === 'upload_failed');
    expect(errEvt).not.toBeUndefined();
    expect(errEvt!.detail.message).toContain('network error');

    picker.destroy();
  });

  // ── Review fix (HIGH, PR #88): realistic error text ─────────────────────────
  it('error_label_is_ellipsis_clipped_and_the_full_message_reaches_the_live_region', async () => {
    // A realistic error string is much longer than the 72px card can show —
    // the visible label must be safely clipped (not overflow the card or
    // overlap the cancel button), and the FULL text must still reach a
    // non-hover channel (the aria-live region), not just errEl.title.
    const longError = 'Upload rejected: the storage backend returned HTTP 413 Payload Too Large for this file';
    const client = makeStubClient({ rejectWith: new Error(longError) });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('big-error.png')]);
    await drain(15);

    const errEl = container.querySelector('.oxp-attachment-error') as HTMLElement | null;
    expect(errEl).not.toBeNull();
    expect(errEl!.style.overflow).toBe('hidden');
    expect(errEl!.style.textOverflow).toBe('ellipsis');
    expect(errEl!.style.whiteSpace).toBe('nowrap');

    const live = container.querySelector('[aria-live="polite"]') as HTMLElement | null;
    expect(live).not.toBeNull();
    expect(live!.textContent).toContain(longError);

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
    expect(live!.textContent).toBeTruthy();

    picker.destroy();
  });

  it('passes_signal_to_uploadAttachment_for_cancellation', async () => {
    let capturedOpts: unknown = null;
    const client = {
      uploadAttachment: vi.fn((_roomId: string, _blob: Blob, opts: unknown) => {
        capturedOpts = opts;
        return new Promise(() => {});
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('signal-test.png')]);
    await drain(5);

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(capturedOpts).not.toBeNull();
    expect((capturedOpts as Record<string, unknown>).signal).toBeInstanceOf(AbortSignal);

    picker.destroy();
  });

  it('cancel_button_aborts_upload_via_signal', async () => {
    let capturedSignal: AbortSignal | null = null;
    let rejectUpload!: (err: Error) => void;

    const client = {
      uploadAttachment: vi.fn((_roomId: string, _blob: Blob, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal ?? null;
        return new Promise<{ attachmentId: string; attachment: EnvelopeAttachment }>((_, reject) => {
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

    expect(capturedSignal!.aborted).toBe(true);

    picker.destroy();
  });

  // ── CM6: Focus preserved on progress update (diff-patch queue) ───────────────

  it('focus_preserved_on_progress_update_during_upload', async () => {
    let resolveUpload!: (v: { attachmentId: string; attachment: EnvelopeAttachment }) => void;
    const client = {
      uploadAttachment: vi.fn((_roomId: string, _blob: Blob, _opts: unknown) => {
        return new Promise<{ attachmentId: string; attachment: EnvelopeAttachment }>((resolve) => {
          resolveUpload = resolve;
        });
      }),
    };

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('focus-test.png')]);
    await drain(5);

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.focus();
    expect(document.activeElement).toBe(cancelBtn);

    picker.handleFiles([makePngFile('focus-test2.png')]);
    await drain(5);

    expect(document.activeElement).not.toBe(document.body);

    picker.destroy();
  });

  // ── DB4: Progress bar role and indeterminate aria ────────────────────────────

  it('progress_has_role_progressbar_and_indeterminate_aria', async () => {
    const client = makeStubClient({ delayMs: 5000 });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('progress-a11y.png')]);
    await drain(5);

    const progress = container.querySelector('.oxp-attachment-progress') as HTMLElement | null;
    expect(progress).not.toBeNull();
    expect(progress!.getAttribute('role')).toBe('progressbar');
    expect(progress!.getAttribute('aria-valuetext')).toBeTruthy();
    expect(progress!.getAttribute('aria-valuenow')).toBeNull();

    picker.destroy();
  });

  // ── Review fix (MEDIUM, PR #88): uploading overlay contrast ─────────────────
  it('uploading_overlay_uses_a_theme_independent_scrim_not_a_theme_fg_token', async () => {
    // The overlay sits on top of an ARBITRARY user photo — a theme token
    // (dark in light mode) guarantees nothing about contrast against the
    // photo's own luminance. Must use the same fixed, high-opacity
    // dark-scrim + white-glyph pairing this file already uses for
    // .oxp-composer-dragover::after (theme-independent by design).
    const client = makeStubClient({ delayMs: 5000 });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('overlay-contrast.png')]);
    await drain(5);

    const overlay = container.querySelector('.oxp-attachment-uploading-overlay') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay!.style.color).not.toContain('var(');
    expect(overlay!.style.color).toBe('rgb(255, 255, 255)');
    expect(overlay!.style.background).toContain('0.7');

    picker.destroy();
  });

  // ── F5: Duplicate filename queue collision ────────────────────────────────────

  it('enqueues_two_files_with_same_filename_as_separate_rows', async () => {
    const client = makeStubClient({ delayMs: 5000 });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const file1 = makePngFile('Screenshot.png');
    const file2 = makePngFile('Screenshot.png');
    picker.handleFiles([file1, file2]);
    await drain(5);

    const rows = container.querySelectorAll('.oxp-attachment-item');
    expect(rows.length).toBe(2);

    picker.destroy();
  });

  // ── Done-state stays staged (not auto-removed) ───────────────────────────────

  it('done_item_remains_in_staged_list', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();
    picker.handleFiles([makePngFile('complete.png')]);
    await drain(15);

    expect(picker.getStaged().length).toBe(1);
    expect(picker.getStaged()[0].status).toBe('done');

    picker.destroy();
  });

  // ── Multi-add and MAX_ATTACHMENTS ───────────────────────────────────────────

  it('multi_add_appends_across_handleFiles_calls', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('first.png')]);
    await drain(5);
    picker.handleFiles([makePngFile('second.png')]);
    await drain(5);

    expect(picker.getStaged().length).toBe(2);
    expect(client.uploadAttachment).toHaveBeenCalledTimes(2);

    picker.destroy();
  });

  it('max_attachments_rejects_extras', async () => {
    const client = makeStubClient();
    const errorEvents: CustomEvent[] = [];
    container.addEventListener('oxpulse-chat:error', (e) => errorEvents.push(e as CustomEvent));

    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    const files = Array.from({ length: 11 }, (_, i) => makePngFile(`img${i}.png`));
    picker.handleFiles(files);
    await drain(15);

    expect(picker.getStaged().length).toBe(10);
    expect(client.uploadAttachment).toHaveBeenCalledTimes(10);
    expect(errorEvents.some((e) => e.detail.kind === 'upload_invalid')).toBe(true);

    picker.destroy();
  });

  // ── awaitAllUploaded ─────────────────────────────────────────────────────────

  it('awaitAllUploaded_resolves_when_all_uploads_done', async () => {
    const client = makeStubClient();
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('a.png'), makePngFile('b.png')]);
    const promise = picker.awaitAllUploaded();
    await drain(15);

    await expect(promise).resolves.toBeUndefined();

    picker.destroy();
  });

  it('awaitAllUploaded_rejects_when_any_upload_fails', async () => {
    const client = makeStubClient({ rejectWith: new Error('fail') });
    const picker = new AttachmentPicker({ client, roomId: 'r1', container });
    picker.mount();

    picker.handleFiles([makePngFile('fail.png')]);
    const promise = picker.awaitAllUploaded();
    await drain(15);

    await expect(promise).rejects.toBeDefined();

    picker.destroy();
  });
});
