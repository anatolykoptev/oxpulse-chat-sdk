/**
 * @oxpulse/chat-widget — AttachmentPicker (W2.2 slice 4).
 *
 * Renders a hidden file input + visible paperclip button.
 * Handles file validation, upload pipeline via client.sendFile,
 * per-file progress tracking, cancel via AbortController, and retry on error.
 *
 * Uses theme tokens exclusively — no inline hex.
 * Dispatches `oxpulse-chat:error` events on validation/upload failures.
 */

import { validate, sanitizeFilename } from '../utils/attachments.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal SDK surface required by AttachmentPicker. */
export interface AttachmentPickerClient {
  sendFile(
    roomId: string,
    blob: Blob,
    args: { senderUid?: string; sha256?: string; mimeType?: string; signal?: AbortSignal },
  ): Promise<{ msgId: string; attachmentId: string }>;
}

export interface AttachmentPickerOptions {
  client: AttachmentPickerClient;
  roomId: string;
  container: HTMLElement;
  signal?: AbortSignal;
}

/** Per-file upload state. */
export interface UploadItem {
  /** F5: stable UUID assigned at enqueue time — used as queue row key instead of filename. */
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  msgId?: string;
  attachmentId?: string;
  abortController: AbortController;
}

// ── AttachmentPicker ───────────────────────────────────────────────────────────

export class AttachmentPicker {
  readonly #container: HTMLElement;
  readonly #client: AttachmentPickerClient;
  readonly #roomId: string;
  readonly #signal: AbortSignal | undefined;

  #root: HTMLElement | null = null;
  #input: HTMLInputElement | null = null;
  #liveRegion: HTMLElement | null = null;
  #queueEl: HTMLElement | null = null;
  #destroyed = false;
  /** F3: per-item done-state removal timers — cleared on destroy to avoid dangling refs. */
  #doneTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** All in-flight and completed upload items. */
  #items: UploadItem[] = [];

  constructor(opts: AttachmentPickerOptions) {
    this.#container = opts.container;
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#signal = opts.signal;
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
    input.setAttribute('aria-label', 'Choose files to attach');
    input.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

    // Visible paperclip button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oxp-attachment-btn';
    btn.setAttribute('aria-label', 'Attach files');
    btn.textContent = '📎';

    // Queue list (popover)
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

    // F3: clear all pending done-state removal timers
    for (const timer of this.#doneTimers.values()) {
      clearTimeout(timer);
    }
    this.#doneTimers.clear();

    // Abort all in-flight uploads
    for (const item of this.#items) {
      if (item.status === 'uploading' || item.status === 'queued') {
        item.abortController.abort();
      }
    }
    this.#items = [];

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

  /** Validate files and start the upload pipeline. */
  handleFiles(files: FileList | File[]): void {
    const arr = Array.from(files);
    for (const file of arr) {
      const result = validate({ type: file.type, size: file.size, name: file.name });
      if (!result.ok) {
        this.#dispatchError('upload_invalid', file.name, result.reason);
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
    // F5: assign stable id so two files with same filename get distinct queue rows.
    // crypto.randomUUID() is available in all modern browsers + jsdom.
    const id = crypto.randomUUID();
    const item: UploadItem = {
      id,
      file,
      status: 'queued',
      progress: 0,
      abortController: new AbortController(),
    };
    this.#items.push(item);
    this.#renderQueue();
    void this.#upload(item);
  }

  async #upload(item: UploadItem): Promise<void> {
    if (this.#destroyed) return;

    item.status = 'uploading';
    this.#renderQueue();
    this.#announce(`Uploading ${item.file.name}`);

    try {
      // CB2: pass AbortSignal so server-side upload can be cancelled when user clicks ✕.
      // If the real SDK does not yet support signal, abort() is still called on the
      // AbortController (client-side cleanup) even if the server ignores it.
      const result = await this.#client.sendFile(
        this.#roomId,
        item.file,
        { mimeType: item.file.type, signal: item.abortController.signal },
      );
      if (this.#destroyed) return;
      item.status = 'done';
      item.progress = 100;
      item.msgId = result.msgId;
      item.attachmentId = result.attachmentId;
      this.#announce(`${item.file.name} uploaded`);
      // F3: show done row for 2s before removing, so user sees completion feedback.
      this.#renderQueue();
      const timer = setTimeout(() => {
        this.#doneTimers.delete(item.id);
        const idx = this.#items.indexOf(item);
        if (idx >= 0) this.#items.splice(idx, 1);
        this.#renderQueue();
      }, 2000);
      this.#doneTimers.set(item.id, timer);
      return; // skip final renderQueue below — already called above
    } catch (err) {
      if (this.#destroyed) return;
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      this.#announce(`Upload failed: ${item.file.name}`);
      this.#dispatchError('upload_failed', item.file.name, item.error);
    }

    this.#renderQueue();
  }

  /**
   * CM6: Diff-patch queue — mutate existing row nodes in-place rather than
   * wiping innerHTML=''. This preserves focus when a progress update fires while
   * the user has a cancel/retry button focused (innerHTML wipe → focus lost to body).
   *
   * DB4: Progress bar uses role="progressbar" + indeterminate CSS animation
   * (aria-valuetext="Uploading…", no aria-valuenow until SDK provides real progress).
   *
   * F3: done items are included in the visible set for their 2s timeout window.
   * F5: rows keyed by item.id (not filename) so two files with same name get distinct rows.
   */
  #renderQueue(): void {
    const queueEl = this.#queueEl;
    if (!queueEl) return;

    // F3: include done items — they stay visible for 2s before the timer removes them.
    const visible = this.#items;
    queueEl.hidden = visible.length === 0;

    // F5: Build a map of currently rendered rows keyed by item.id (stable UUID).
    const existingRows = new Map<string, HTMLElement>();
    for (const el of Array.from(queueEl.querySelectorAll<HTMLElement>('.oxp-attachment-item'))) {
      const key = el.getAttribute('data-item-id');
      if (key) existingRows.set(key, el);
    }

    // Remove rows for items no longer in the visible list
    const visibleIds = new Set(visible.map(i => i.id));
    for (const [key, el] of existingRows) {
      if (!visibleIds.has(key)) {
        queueEl.removeChild(el);
        existingRows.delete(key);
      }
    }

    for (const item of visible) {
      const safeName = sanitizeFilename(item.file.name);
      // F5: key by item.id — filename is just the visible label
      const itemId = item.id;
      let row = existingRows.get(itemId);

      if (!row) {
        // New item — create row
        row = document.createElement('div');
        row.className = 'oxp-attachment-item';
        // F5: store id as DOM attribute so the key remains accessible after creation
        row.setAttribute('data-item-id', itemId);
        // filename attribute kept for legacy test compatibility (selectors by name still work)
        row.setAttribute('data-file-name', item.file.name);

        const nameEl = document.createElement('span');
        nameEl.className = 'oxp-attachment-name';
        nameEl.textContent = safeName;
        row.appendChild(nameEl);

        // DB4: Progress bar with role + indeterminate aria
        const bar = document.createElement('div');
        bar.className = 'oxp-attachment-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuetext', 'Uploading…');
        row.appendChild(bar);

        const errEl = document.createElement('span');
        errEl.className = 'oxp-attachment-error';
        errEl.hidden = true;
        row.appendChild(errEl);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'oxp-attachment-retry';
        retryBtn.textContent = 'Retry';
        retryBtn.hidden = true;
        retryBtn.addEventListener('click', () => {
          item.status = 'queued';
          item.error = undefined;
          item.abortController = new AbortController();
          this.#renderQueue();
          void this.#upload(item);
        });
        row.appendChild(retryBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'oxp-attachment-cancel';
        cancelBtn.setAttribute('aria-label', `Cancel upload of ${safeName}`);
        cancelBtn.textContent = '✕';
        cancelBtn.addEventListener('click', () => {
          // F5: cancel by item reference (captured in closure) — not by filename.
          // This ensures only the clicked item is cancelled when two files share a name.
          item.abortController.abort();
          const idx = this.#items.indexOf(item);
          if (idx >= 0) this.#items.splice(idx, 1);
          this.#renderQueue();
        });
        row.appendChild(cancelBtn);

        queueEl.appendChild(row);
      }

      // Mutate in-place — preserves focus on existing nodes
      // F3: stamp data-status so tests (and CSS) can observe done state
      row.setAttribute('data-status', item.status);

      const bar = row.querySelector('.oxp-attachment-progress') as HTMLElement | null;
      const errEl = row.querySelector('.oxp-attachment-error') as HTMLElement | null;
      const retryBtn = row.querySelector('.oxp-attachment-retry') as HTMLElement | null;

      if (item.status === 'done') {
        // F3: show checkmark in name span; hide progress/error/buttons
        const nameEl = row.querySelector('.oxp-attachment-name') as HTMLElement | null;
        if (nameEl) nameEl.textContent = `✓ ${safeName}`;
        if (bar) bar.hidden = true;
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
        const cancelBtn = row.querySelector('.oxp-attachment-cancel') as HTMLElement | null;
        if (cancelBtn) {
          // 1B: BEFORE hiding cancelBtn, move focus to paperclip button if cancelBtn is active.
          // Setting hidden=true removes from a11y tree and drops focus to body.
          if (document.activeElement === cancelBtn) {
            const paperclipBtn = this.#root?.querySelector('.oxp-attachment-btn') as HTMLElement | null;
            if (paperclipBtn) {
              paperclipBtn.focus();
            }
          }
          cancelBtn.hidden = true;
        }
      } else if (item.status === 'error') {
        if (bar) bar.hidden = true;
        if (errEl) { errEl.hidden = false; errEl.textContent = item.error ?? 'Upload failed'; }
        if (retryBtn) retryBtn.hidden = false;
      } else {
        if (bar) { bar.hidden = false; bar.style.width = `${item.progress}%`; }
        if (errEl) errEl.hidden = true;
        if (retryBtn) retryBtn.hidden = true;
      }
    }

    // Update live region with current queue summary
    if (this.#liveRegion && this.#items.length > 0) {
      const uploading = this.#items.filter(i => i.status === 'uploading').length;
      const done = this.#items.filter(i => i.status === 'done').length;
      const errors = this.#items.filter(i => i.status === 'error').length;
      const parts: string[] = [];
      if (uploading > 0) parts.push(`${uploading} uploading`);
      if (done > 0) parts.push(`${done} done`);
      if (errors > 0) parts.push(`${errors} failed`);
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
