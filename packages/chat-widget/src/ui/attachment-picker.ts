/**
 * @oxpulse/chat-widget — AttachmentPicker (staged attachment tray slice 3).
 *
 * Renders a hidden file input + staging tray (horizontal thumbnail strip in
 * slice 4). Stages files on pick/paste/drop, eagerly uploads each in the
 * background, and exposes the staged list to Composer for send-time batching.
 *
 * Uses theme tokens exclusively — no inline hex.
 * Dispatches `oxpulse-chat:error` events on validation/upload failures.
 */

import { validate, sanitizeFilename, compress } from '../utils/attachments.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import { generateUUID } from '@oxpulse/chat-sdk';
import { MAX_ATTACHMENTS, type EnvelopeAttachment } from '../utils/attachment-envelope.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal SDK surface required by AttachmentPicker. */
export interface AttachmentPickerClient {
  uploadAttachment(
    roomId: string,
    blob: Blob,
    args: {
      mimeType?: string;
      filename?: string;
      width?: number;
      height?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ attachmentId: string; attachment: EnvelopeAttachment }>;
}

export interface AttachmentPickerOptions {
  client: AttachmentPickerClient;
  roomId: string;
  container: HTMLElement;
  signal?: AbortSignal;
  /** BCP-47 tag or an already-resolved Locale. Optional — defaults via resolveLocale(). */
  lang?: string;
}

/** Per-file staged attachment state. */
export interface StagedAttachment {
  /** F5: stable UUID assigned at enqueue time. */
  id: string;
  file: File;
  /** Object URL for a local thumbnail preview; revoked on remove/clear/destroy. */
  objectURL: string;
  status: 'uploading' | 'done' | 'error';
  // NB: no 'queued' state — files start as 'uploading' immediately because
  // handleFiles/#upload runs synchronously after enqueue.
  progress: number;
  error?: string;
  /** Populated once uploadAttachment resolves. */
  attachmentId?: string;
  mime: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  abortController: AbortController;
}

type Awaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

// ── AttachmentPicker ───────────────────────────────────────────────────────────

export class AttachmentPicker {
  readonly #container: HTMLElement;
  readonly #client: AttachmentPickerClient;
  readonly #roomId: string;
  readonly #signal: AbortSignal | undefined;
  readonly #lang: Locale;

  #root: HTMLElement | null = null;
  #input: HTMLInputElement | null = null;
  #liveRegion: HTMLElement | null = null;
  #queueEl: HTMLElement | null = null;
  #destroyed = false;

  /** All staged attachments (in-flight, done, or error). */
  #items: StagedAttachment[] = [];

  /** Pending awaiters for awaitAllUploaded(). */
  #awaiters: Awaiter[] = [];

  constructor(opts: AttachmentPickerOptions) {
    this.#container = opts.container;
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  mount(): void {
    if (this.#signal?.aborted) return;
    if (this.#root) return;

    const root = document.createElement('div');
    root.className = 'oxp-attachment-picker';

    // Hidden file input
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,audio/*,application/pdf';
    input.className = 'oxp-attachment-input';
    input.setAttribute('aria-label', t('chooseFilesToAttachAria', this.#lang));
    input.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

    // Visible paperclip button (BUG-1 removed in slice 4; composer.ts:207 attachBtn stays the sole trigger).
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oxp-attachment-btn';
    btn.setAttribute('aria-label', t('attachFilesAria', this.#lang));
    btn.textContent = '📎';

    // Queue list (replaced by horizontal tray in slice 4)
    const queueEl = document.createElement('div');
    queueEl.className = 'oxp-attachment-queue';
    queueEl.hidden = true;

    // Live region for a11y announcements
    const live = document.createElement('div');
    live.className = 'oxp-attachment-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap';

    root.appendChild(input);
    root.appendChild(btn);
    root.appendChild(queueEl);
    root.appendChild(live);
    this.#container.appendChild(root);

    this.#root = root;
    this.#input = input;
    this.#liveRegion = live;
    this.#queueEl = queueEl;

    btn.addEventListener('click', this.#onBtnClick);
    input.addEventListener('change', this.#onInputChange);

    this.#signal?.addEventListener('abort', () => this.destroy(), { once: true });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    // Abort all in-flight uploads
    for (const item of this.#items) {
      if (item.status === 'uploading') {
        item.abortController.abort();
      }
    }

    this.#revokeAllObjectURLs();
    this.#items = [];
    this.#awaiters = [];

    if (this.#root?.parentNode) {
      this.#root.parentNode.removeChild(this.#root);
    }
    this.#root = null;
    this.#input = null;
    this.#liveRegion = null;
    this.#queueEl = null;
  }

  openFileDialog(): void {
    this.#input?.click();
  }

  /** Returns a snapshot of the current staged attachment list. */
  getStaged(): StagedAttachment[] {
    return this.#items.slice();
  }

  /** Whether there is at least one staged attachment. */
  hasStaged(): boolean {
    return this.#items.length > 0;
  }

  /** Revoke every objectURL and clear the staged list. */
  clearStaged(): void {
    // Abort anything still in-flight before clearing.
    for (const item of this.#items) {
      if (item.status === 'uploading') {
        item.abortController.abort();
      }
    }
    this.#revokeAllObjectURLs();
    this.#items = [];
    this.#flushAwaiters();
    this.#renderQueue();
  }

  /**
   * Resolves once every staged item is done. Rejects immediately if any item is
   * in the 'error' state, or if a later upload fails while this is pending.
   * Pending awaiters are cleared when the staged list is cleared/destroyed.
   */
  awaitAllUploaded(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const failed = this.#items.find((i) => i.status === 'error');
      if (failed) {
        reject(new Error(`Upload failed: ${failed.file.name}`));
        return;
      }
      if (this.#items.length > 0 && this.#items.every((i) => i.status === 'done')) {
        resolve();
        return;
      }
      if (this.#items.length === 0) {
        resolve();
        return;
      }
      this.#awaiters.push({ resolve, reject });
    });
  }

  /** Validate files and stage them for upload (append to existing staged list). */
  handleFiles(files: FileList | File[]): void {
    const arr = Array.from(files);
    for (const file of arr) {
      const result = validate({ type: file.type, size: file.size, name: file.name });
      if (!result.ok) {
        this.#dispatchError('upload_invalid', file.name, result.reason);
        continue;
      }
      if (this.#items.length >= MAX_ATTACHMENTS) {
        this.#dispatchError('upload_invalid', file.name, `Too many attachments (max ${MAX_ATTACHMENTS})`);
        continue;
      }
      this.#enqueue(file);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  readonly #onBtnClick = (): void => {
    this.openFileDialog();
  };

  readonly #onInputChange = (): void => {
    if (this.#input?.files) {
      this.handleFiles(this.#input.files);
      // Reset so the same file can be selected again
      this.#input.value = '';
    }
  };

  #enqueue(file: File): void {
    const id = generateUUID();
    const item: StagedAttachment = {
      id,
      file,
      objectURL: URL.createObjectURL(file),
      status: 'uploading',
      progress: 0,
      mime: file.type,
      sizeBytes: file.size,
      abortController: new AbortController(),
    };
    this.#items.push(item);
    this.#renderQueue();
    void this.#upload(item);
  }

  async #upload(item: StagedAttachment): Promise<void> {
    if (this.#destroyed) return;

    item.status = 'uploading';
    this.#renderQueue();
    this.#announce(t('announceUploadingFile', this.#lang, { name: item.file.name }));

    try {
      let uploadBlob: Blob = item.file;
      let width: number | undefined;
      let height: number | undefined;
      if (item.file.type.startsWith('image/') && item.file.type !== 'image/gif') {
        const compressed = await compress(item.file);
        uploadBlob = compressed.blob;
        width = compressed.width;
        height = compressed.height;
      }

      const { attachmentId, attachment } = await this.#client.uploadAttachment(
        this.#roomId,
        uploadBlob,
        {
          mimeType: uploadBlob.type || item.file.type,
          filename: sanitizeFilename(item.file.name),
          width,
          height,
          signal: item.abortController.signal,
        },
      );
      if (this.#destroyed) return;
      item.status = 'done';
      item.progress = 100;
      item.attachmentId = attachmentId;
      item.mime = attachment.mime;
      item.sizeBytes = attachment.sizeBytes;
      item.width = attachment.width;
      item.height = attachment.height;
      this.#announce(t('announceFileUploaded', this.#lang, { name: item.file.name }));
      this.#renderQueue();
      this.#flushAwaiters();
      return;
    } catch (err) {
      if (this.#destroyed) return;
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.#announce(t('announceUploadFailedFile', this.#lang, { name: item.file.name }));
      this.#dispatchError('upload_failed', item.file.name, item.error);
    }

    this.#renderQueue();
    this.#flushAwaiters();
  }

  #flushAwaiters(): void {
    if (this.#awaiters.length === 0) return;

    const failed = this.#items.filter((i) => i.status === 'error');
    if (failed.length > 0) {
      const names = failed.map((i) => i.file.name).join(', ');
      const err = new Error(`Upload failed: ${names}`);
      for (const a of this.#awaiters) a.reject(err);
      this.#awaiters = [];
      return;
    }

    if (this.#items.every((i) => i.status === 'done')) {
      for (const a of this.#awaiters) a.resolve();
      this.#awaiters = [];
    }
  }

  #revokeAllObjectURLs(): void {
    for (const item of this.#items) {
      URL.revokeObjectURL(item.objectURL);
    }
  }

  #revokeItemObjectURL(item: StagedAttachment): void {
    URL.revokeObjectURL(item.objectURL);
  }

  /**
   * CM6: Diff-patch queue — mutate existing row nodes in-place rather than
   * wiping innerHTML=''. This preserves focus when a progress update fires while
   * the user has a cancel/retry button focused.
   */
  #renderQueue(): void {
    const queueEl = this.#queueEl;
    if (!queueEl) return;

    const visible = this.#items;
    queueEl.hidden = visible.length === 0;

    const existingRows = new Map<string, HTMLElement>();
    for (const el of Array.from(queueEl.querySelectorAll<HTMLElement>('.oxp-attachment-item'))) {
      const key = el.getAttribute('data-item-id');
      if (key) existingRows.set(key, el);
    }

    const visibleIds = new Set(visible.map((i) => i.id));
    for (const [key, el] of existingRows) {
      if (!visibleIds.has(key)) {
        queueEl.removeChild(el);
        existingRows.delete(key);
      }
    }

    for (const item of visible) {
      const safeName = sanitizeFilename(item.file.name);
      const itemId = item.id;
      let row = existingRows.get(itemId);

      if (!row) {
        row = document.createElement('div');
        row.className = 'oxp-attachment-item';
        row.setAttribute('data-item-id', itemId);
        row.setAttribute('data-file-name', item.file.name);

        const nameEl = document.createElement('span');
        nameEl.className = 'oxp-attachment-name';
        nameEl.textContent = safeName;
        row.appendChild(nameEl);

        const bar = document.createElement('div');
        bar.className = 'oxp-attachment-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuetext', t('uploadingProgressAria', this.#lang));
        row.appendChild(bar);

        const errEl = document.createElement('span');
        errEl.className = 'oxp-attachment-error';
        errEl.hidden = true;
        row.appendChild(errEl);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'oxp-attachment-retry';
        retryBtn.textContent = t('retry', this.#lang);
        retryBtn.hidden = true;
        retryBtn.addEventListener('click', () => {
          item.status = 'uploading';
          item.error = undefined;
          item.attachmentId = undefined;
          item.width = undefined;
          item.height = undefined;
          item.abortController = new AbortController();
          this.#renderQueue();
          void this.#upload(item);
        });
        row.appendChild(retryBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'oxp-attachment-cancel';
        cancelBtn.setAttribute('aria-label', t('cancelUploadOfAria', this.#lang, { name: safeName }));
        cancelBtn.textContent = '✕';
        cancelBtn.addEventListener('click', () => {
          item.abortController.abort();
          this.#revokeItemObjectURL(item);
          const idx = this.#items.indexOf(item);
          if (idx >= 0) this.#items.splice(idx, 1);
          this.#renderQueue();
          this.#flushAwaiters();
        });
        row.appendChild(cancelBtn);

        queueEl.appendChild(row);
      }

      row.setAttribute('data-status', item.status);

      const bar = row.querySelector('.oxp-attachment-progress') as HTMLElement | null;
      const errEl = row.querySelector('.oxp-attachment-error') as HTMLElement | null;
      const retryBtn = row.querySelector('.oxp-attachment-retry') as HTMLElement | null;

      if (item.status === 'done') {
        const nameEl = row.querySelector('.oxp-attachment-name') as HTMLElement | null;
        if (nameEl) nameEl.textContent = `✓ ${safeName}`;
        if (bar) bar.hidden = true;
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
      } else if (item.status === 'error') {
        if (bar) bar.hidden = true;
        if (errEl) { errEl.hidden = false; errEl.textContent = item.error ?? t('uploadFailed', this.#lang); }
        if (retryBtn) retryBtn.hidden = false;
      } else {
        if (bar) { bar.hidden = false; bar.style.width = `${item.progress}%`; }
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
      }
    }

    if (this.#liveRegion && this.#items.length > 0) {
      const uploading = this.#items.filter((i) => i.status === 'uploading').length;
      const done = this.#items.filter((i) => i.status === 'done').length;
      const errors = this.#items.filter((i) => i.status === 'error').length;
      const parts: string[] = [];
      if (uploading > 0) parts.push(t('queueUploadingCount', this.#lang, { n: uploading }));
      if (done > 0) parts.push(t('queueDoneCount', this.#lang, { n: done }));
      if (errors > 0) parts.push(t('queueFailedCount', this.#lang, { n: errors }));
      this.#liveRegion.textContent = parts.join(', ');
    }
  }

  #announce(msg: string): void {
    if (!this.#liveRegion) return;
    this.#liveRegion.textContent = msg;
  }

  #dispatchError(kind: string, filename: string, message: string): void {
    this.#container.dispatchEvent(
      new CustomEvent('oxpulse-chat:error', {
        bubbles: true,
        composed: true,
        detail: { kind, filename, message },
      }),
    );
  }
}
