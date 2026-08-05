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
  /** Optional callback fired whenever the staged list changes. */
  onChange?: () => void;
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
  /** Resolves when this item's upload completes (status='done'). Rejects
   *  with the upload error if status='error'. Set by #enqueue() — present
   *  on every item returned by getStaged() / detachAndAwaitUploads(). */
  donePromise?: Promise<void>;
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

  /** Review fix (HIGH, PR #88): true while Composer#send is in flight —
   *  disables every cancel/retry button so a real click can't race the send
   *  (defense-in-depth; the authoritative guard is Composer re-checking the
   *  staged list after awaitAllUploaded() resolves). */
  #sendLocked = false;

  /** Optional callback fired whenever the staged list changes. */
  readonly #onChange: (() => void) | undefined;

  constructor(opts: AttachmentPickerOptions) {
    this.#container = opts.container;
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
    this.#onChange = opts.onChange;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  mount(): void {
    if (this.#signal?.aborted) return;
    if (this.#root) return;

    const root = document.createElement('div');
    root.className = 'oxp-attachment-picker';

    // Hidden file input — the visible trigger lives in composer.ts (BUG-1 fix).
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,audio/*,application/pdf';
    input.className = 'oxp-attachment-input';
    input.setAttribute('aria-label', t('chooseFilesToAttachAria', this.#lang));
    input.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

    // Staging tray (horizontal thumbnail strip in slice 4)
    const queueEl = document.createElement('div');
    queueEl.className = 'oxp-attachment-queue';
    // Review fix (LOW, PR #88): group semantics + an accessible name — this
    // is a collection of independently-actionable cards (mirrors the
    // reactionsGroupAria role="group" convention in message-list.ts), not
    // decorative or inert.
    queueEl.setAttribute('role', 'group');
    queueEl.setAttribute('aria-label', t('attachmentTrayAria', this.#lang));
    queueEl.hidden = true;

    // Live region for a11y announcements
    const live = document.createElement('div');
    live.className = 'oxp-attachment-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap';

    root.appendChild(input);
    root.appendChild(queueEl);
    root.appendChild(live);
    this.#container.appendChild(root);

    this.#root = root;
    this.#input = input;
    this.#liveRegion = live;
    this.#queueEl = queueEl;

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

  /**
   * Review fix (HIGH, PR #88): disable/enable every cancel + retry button
   * while Composer#send is in flight. Purely a UI-level defense — Composer
   * itself re-checks the staged list after awaitAllUploaded() resolves, since
   * this alone doesn't cover every way the list could still empty out.
   */
  setSendLocked(locked: boolean): void {
    this.#sendLocked = locked;
    if (!this.#queueEl) return;
    const buttons = this.#queueEl.querySelectorAll<HTMLButtonElement>(
      '.oxp-attachment-cancel, .oxp-attachment-retry',
    );
    for (const btn of Array.from(buttons)) {
      btn.disabled = locked;
    }
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

  /**
   * Detach the currently-staged items from the tray and return a promise that
   * resolves when all their uploads complete. The tray UI is cleared immediately
   * (items removed from #items + re-rendered) but the uploads continue in the
   * background — each item's donePromise is independent of the #items array.
   *
   * Used by the non-blocking attachment send path: the composer calls this to
   * "hand off" the staged items, clears the textarea, and returns control to
   * the user while the uploads + send proceed in the background.
   *
   * Rejects if any upload fails (the rejection carries the failed file's name).
   */
  detachAndAwaitUploads(): Promise<StagedAttachment[]> {
    const snapshot = this.#items.slice();
    // Clear the tray — the items are now "detached". Their uploads continue
    // because #upload()'s async operation holds a direct reference to each
    // item object, not to the #items array.
    this.#items = [];
    this.#flushAwaiters();
    this.#renderQueue();

    if (snapshot.length === 0) {
      return Promise.resolve([]);
    }

    // Every item has a donePromise set by #enqueue(). It resolves when the
    // upload settles (success OR error) — check item.status to distinguish.
    // If any upload failed, reject with the error.
    return Promise.all(
      snapshot.map((item) => item.donePromise ?? Promise.resolve()),
    ).then(() => {
      const failed = snapshot.find((i) => i.status === 'error');
      if (failed) {
        throw new Error(failed.error ?? `Upload failed: ${failed.file.name}`);
      }
      return snapshot;
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
    // #upload() catches errors internally (sets status='error') and always
    // resolves. donePromise resolves when the upload settles (success OR error) —
    // the caller checks item.status to distinguish. This avoids unhandled
    // rejection when donePromise is set but never consumed (e.g. the user
    // removes the item before it uploads, or the test doesn't call
    // detachAndAwaitUploads).
    const uploadSettled = this.#upload(item);
    item.donePromise = uploadSettled.then(() => {});
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
      this.#dispatchError('upload_failed', item.file.name, item.error);
    }

    this.#renderQueue();
    // Review fix (HIGH, PR #88): announce AFTER renderQueue, not before — the
    // card's visible error label is ellipsis-clipped at 72px wide (see
    // renderQueue below) and its only full-text channel used to be
    // `errEl.title` (hover-only, reaches neither touch nor screen-reader
    // users). renderQueue's own status-count summary is the last thing to
    // touch the live region on every OTHER pass, so this must run after it
    // (not from inside the catch block above) or it gets clobbered immediately.
    if (item.status === 'error') {
      this.#announce(
        `${t('announceUploadFailedFile', this.#lang, { name: item.file.name })}: ${item.error}`,
      );
    }
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
   * CM6: Diff-patch tray — mutate existing card nodes in-place rather than
   * wiping innerHTML=''. This preserves focus when a progress update fires while
   * the user has a cancel/retry button focused.
   */
  #renderQueue(): void {
    const queueEl = this.#queueEl;
    if (!queueEl) return;

    const visible = this.#items;
    queueEl.hidden = visible.length === 0;

    const existingCards = new Map<string, HTMLElement>();
    for (const el of Array.from(queueEl.querySelectorAll<HTMLElement>('.oxp-attachment-item'))) {
      const key = el.getAttribute('data-item-id');
      if (key) existingCards.set(key, el);
    }

    const visibleIds = new Set(visible.map((i) => i.id));
    for (const [key, el] of existingCards) {
      if (!visibleIds.has(key)) {
        queueEl.removeChild(el);
        existingCards.delete(key);
      }
    }

    for (const item of visible) {
      const safeName = sanitizeFilename(item.file.name);
      const itemId = item.id;
      let card = existingCards.get(itemId);

      if (!card) {
        card = document.createElement('div');
        card.className = 'oxp-attachment-item';
        card.setAttribute('data-item-id', itemId);
        card.setAttribute('data-file-name', item.file.name);
        // Review fix (LOW, PR #88): 72px is exactly --oxp-spacing-unit(8px) * 9
        // — an exact multiple, so derive it from the token instead of a bare
        // magic number rather than leaving a coincidental match undocumented.
        card.style.cssText =
          'position:relative;flex:0 0 auto;width:calc(var(--oxp-spacing-unit) * 9);height:calc(var(--oxp-spacing-unit) * 9);overflow:hidden;border-radius:var(--oxp-radius);border:1px solid var(--oxp-border);background:var(--oxp-bg);display:flex;align-items:center;justify-content:center';

        const preview = document.createElement('div');
        preview.className = 'oxp-attachment-preview';
        preview.style.cssText =
          'width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden';
        card.appendChild(preview);

        const bar = document.createElement('div');
        bar.className = 'oxp-attachment-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuetext', t('uploadingProgressAria', this.#lang));
        bar.style.cssText = 'position:absolute;bottom:4px;left:4px;right:4px;height:4px;z-index:1';
        card.appendChild(bar);

        const errEl = document.createElement('span');
        errEl.className = 'oxp-attachment-error';
        // Review fix (HIGH, PR #88): a realistic error string (network
        // messages, server responses) overflows this 72px card — ellipsis it
        // visually rather than letting it clip mid-character or overlay the
        // cancel button; the full text still reaches the live region (#upload
        // catch above) and `.title` (mouse-hover only, kept as a bonus, not
        // the sole channel).
        errEl.style.cssText =
          'position:absolute;bottom:4px;left:4px;right:4px;font-size:0.65rem;text-align:center;color:var(--oxp-danger);z-index:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        errEl.hidden = true;
        card.appendChild(errEl);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'oxp-attachment-retry';
        retryBtn.textContent = t('retry', this.#lang);
        retryBtn.style.cssText =
          'position:absolute;bottom:4px;left:50%;transform:translateX(-50%);font-size:0.65rem;z-index:1';
        retryBtn.hidden = true;
        retryBtn.disabled = this.#sendLocked;
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
        card.appendChild(retryBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'oxp-attachment-cancel';
        cancelBtn.setAttribute('aria-label', t('cancelUploadOfAria', this.#lang, { name: safeName }));
        cancelBtn.textContent = '✕';
        // Review fix (CRITICAL, PR #88): min-width/min-height/padding used to be
        // set INLINE here, which outranks .oxp-attachment-cancel's class rules —
        // including the @media(hover:none),(pointer:coarse) 44px touch-target
        // rule (theme.ts) added for exactly this file's DM1 requirement. Sizing
        // now comes entirely from the class so both the >=24px desktop floor and
        // the 44px touch floor actually apply.
        cancelBtn.style.cssText = 'position:absolute;top:2px;right:2px;line-height:1;z-index:1';
        cancelBtn.disabled = this.#sendLocked;
        cancelBtn.addEventListener('click', () => {
          item.abortController.abort();
          this.#revokeItemObjectURL(item);
          const idx = this.#items.indexOf(item);
          if (idx >= 0) this.#items.splice(idx, 1);
          this.#renderQueue();
          this.#flushAwaiters();
        });
        card.appendChild(cancelBtn);

        const uploadingOverlay = document.createElement('div');
        uploadingOverlay.className = 'oxp-attachment-uploading-overlay';
        uploadingOverlay.setAttribute('aria-hidden', 'true');
        // Review fix (MEDIUM, PR #88): this used to pair a THEME-dependent
        // --oxp-fg (dark in light mode) with a fixed, weak rgba(0,0,0,0.25)
        // scrim over an ARBITRARY user photo — the photo's own luminance, not
        // the theme, is what the glyph needs to contrast against, so a
        // theme-token color guarantees nothing. Reuse this same file's
        // already-proven scrim (oxp-composer-dragover::after in theme.ts:
        // rgba(0,0,0,0.70) + fixed white) — theme-independent by design,
        // sized for arbitrary underlying content.
        uploadingOverlay.style.cssText =
          'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.70);color:#ffffff;font-size:1.2rem;z-index:2';
        uploadingOverlay.textContent = '⏳';
        uploadingOverlay.hidden = true;
        card.appendChild(uploadingOverlay);

        queueEl.appendChild(card);
      }

      card.setAttribute('data-status', item.status);

      const preview = card.querySelector('.oxp-attachment-preview') as HTMLElement | null;
      const bar = card.querySelector('.oxp-attachment-progress') as HTMLElement | null;
      const errEl = card.querySelector('.oxp-attachment-error') as HTMLElement | null;
      const retryBtn = card.querySelector('.oxp-attachment-retry') as HTMLButtonElement | null;
      const overlay = card.querySelector('.oxp-attachment-uploading-overlay') as HTMLElement | null;

      if (preview) {
        if (item.status === 'done') {
          preview.innerHTML = '';
          preview.style.flexDirection = 'row';
          if (item.mime.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = item.objectURL;
            img.alt = safeName;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
            preview.appendChild(img);
          } else {
            this.#renderNonImagePreview(preview, safeName);
          }
        } else if (item.status === 'error') {
          preview.innerHTML = '';
          preview.style.flexDirection = 'row';
          const icon = document.createElement('div');
          icon.textContent = '⚠';
          icon.style.cssText = 'color:var(--oxp-danger);font-size:1.2rem;text-align:center';
          preview.appendChild(icon);
        } else {
          preview.innerHTML = '';
          preview.style.flexDirection = 'row';
          if (item.mime.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = item.objectURL;
            img.alt = safeName;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;opacity:0.6';
            preview.appendChild(img);
          } else {
            this.#renderNonImagePreview(preview, safeName);
          }
        }
      }

      if (item.status === 'done') {
        if (bar) bar.hidden = true;
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
        if (overlay) overlay.hidden = true;
      } else if (item.status === 'error') {
        if (bar) bar.hidden = true;
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = item.error ?? t('uploadFailed', this.#lang);
          errEl.title = item.error ?? t('uploadFailed', this.#lang);
        }
        if (retryBtn) retryBtn.hidden = false;
        if (overlay) overlay.hidden = true;
      } else {
        if (bar) { bar.hidden = false; bar.style.width = `${item.progress}%`; }
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
        if (overlay) overlay.hidden = false;
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

    this.#onChange?.();
  }

  /**
   * Review fix (MEDIUM, PR #88): the non-image preview (📎 icon + filename)
   * used to be byte-identical duplicated code in the 'done' and 'uploading'
   * branches above — only the image branch has a real per-status diff
   * (opacity:0.6 while uploading), which stays inline at each call site.
   */
  #renderNonImagePreview(preview: HTMLElement, safeName: string): void {
    const icon = document.createElement('div');
    icon.textContent = '📎';
    icon.style.cssText = 'font-size:1.5rem;text-align:center';
    preview.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'oxp-attachment-name';
    name.textContent = safeName;
    name.style.cssText =
      'font-size:0.65rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;padding:0 2px';
    preview.appendChild(name);
    preview.style.flexDirection = 'column';
    preview.style.gap = '2px';
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
