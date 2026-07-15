/**
 * @oxpulse/chat-widget — Composer (W2.2 slice 2, fix-loop).
 *
 * Plain-text message input + send path.
 * Dispatches `oxpulse-chat:error` on send failure + renders inline error chip.
 * Uses theme tokens exclusively — no inline hex.
 */

import { shouldShowCounter, isCmdEnter, MAX_BODY_CHARS, autogrowHeightPx } from '../utils/textfield-helpers.js';
import { AttachmentPicker } from './attachment-picker.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import type { ProductMeta } from '../types.js';
import { formatBodyPreview, type ReplySnapshot } from '../utils/reply-helpers.js';
import { sanitizeFilename } from '../utils/attachments.js';
import type { EnvelopeAttachment } from '../utils/attachment-envelope.js';
import { createVoiceRecorder, validateVoiceBlob, MAX_VOICE_MS, type VoiceRecorder, type VoiceRecorderResult } from '../utils/voice.js';
import { formatDuration } from '../utils/list-helpers.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Optional args forwarded to the SDK sendText call. */
export interface SendTextArgs {
  /** W7: thread reply — UUID of the message being replied to. */
  threadRootMsgId?: string;
  productRef?: string;
  productMeta?: ProductMeta;
}

/** Minimal SDK client surface required by Composer. */
interface ComposerClient {
  sendText(roomId: string, text: string, args?: SendTextArgs): Promise<{ msgId: string }>;
  sendTextOptimistic?(roomId: string, text: string, args?: SendTextArgs): Promise<{ msgId: string }>;
  e2ee?: unknown;
  /** Stage-then-send split (slice 4): upload an attachment and return its id + envelope metadata. */
  uploadAttachment?(
    roomId: string,
    blob: Blob,
    args: { mimeType?: string; filename?: string; width?: number; height?: number; signal?: AbortSignal },
  ): Promise<{ attachmentId: string; attachment: EnvelopeAttachment }>;
  /** Stage-then-send split (slice 4): send a message with the given caption + attachment envelope. */
  sendAttachmentMessage?(
    roomId: string,
    body: string,
    attachments: readonly EnvelopeAttachment[],
    args?: SendTextArgs,
  ): Promise<{ msgId: string }>;
}

export interface ComposerOptions {
  client: ComposerClient;
  roomId: string;
  container: HTMLElement;
  signal?: AbortSignal;
  /** M5: Optional placeholder text. Default: the localized 'composerPlaceholder' key. */
  placeholder?: string;
  /** BCP-47 tag or an already-resolved Locale. Optional — defaults via resolveLocale(). */
  lang?: string;
}

// ── Composer ──────────────────────────────────────────────────────────────────

export class Composer {
  // B1: true ECMAScript private field (not quoted-string pseudo-private)
  readonly #container: HTMLElement;
  #client: ComposerClient;
  #roomId: string;
  #signal: AbortSignal | undefined;
  #placeholder: string;
  #lang: Locale;

  // DOM refs — set during mount()
  #root: HTMLElement | null = null;
  #textarea: HTMLTextAreaElement | null = null;
  #sendBtn: HTMLButtonElement | null = null;
  #counter: HTMLElement | null = null;
  #errorChip: HTMLElement | null = null;

  /** Tracks in-flight send so destroy can suppress clear. */
  #sending = false;
  /** Whether destroy has been called — prevents post-send state mutation. */
  #destroyed = false;
  /** Last successfully-typed text — for retry after error. */
  #lastText = '';
  /** CM1: initial text to pre-fill textarea on mount — set via setInitialText() before mount(). */
  #initialText = '';
  /** W2.2 slice 4: attachment picker — present when client supports uploadAttachment + sendAttachmentMessage. */
  #attachmentPicker: AttachmentPicker | null = null;
  /** W9: optional product card to attach to the next outgoing text message. */
  #productRef: string | null = null;
  #productMeta: ProductMeta | null = null;
  /** W7: snapshot of the message being replied to, or null when not replying. */
  #replyTarget: ReplySnapshot | null = null;
  /** W7: reply preview bar container — created in mount(), populated by setReplyTarget(). */
  #replyEl: HTMLDivElement | null = null;

  // P0: voice recording
  #main: HTMLElement | null = null;
  #footer: HTMLElement | null = null;
  #micBtn: HTMLButtonElement | null = null;
  #recordingEl: HTMLElement | null = null;
  #recordingTimerEl: HTMLElement | null = null;
  #voiceRecorder: VoiceRecorder | null = null;
  #recordingTimer: ReturnType<typeof setInterval> | null = null;
  #recordingAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
  #isRecording = false;

  constructor(opts: ComposerOptions) {
    this.#container = opts.container;
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
    this.#placeholder = opts.placeholder ?? t('composerPlaceholder', this.#lang);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * CM1: Pre-fill the textarea with an initial value before mount().
   * Must be called before mount(). #updateState() in mount() will reflect this value
   * so the send button and counter start in the correct state.
   */
  setInitialText(text: string): void {
    this.#initialText = text;
  }

  /**
   * W9: Attach a product card to the next outgoing text message.
   * The product ref and metadata are forwarded to sendText/sendTextOptimistic
   * and are cleared once the message is sent.
   *
   * E2EE posture: `productMeta` (title/price/imageUrl/productUrl) travels
   * UNSEALED in the wire payload and is server-visible even in E2EE rooms —
   * by design, mirroring the sendProductCard contract to enable marketplace
   * search. Only `productRef` is opaque. Do not put sensitive data in
   * `productMeta`.
   */
  setProductCard(productRef: string, productMeta: ProductMeta): void {
    this.#productRef = productRef;
    this.#productMeta = productMeta;
  }

  /** Clear a previously set product card without sending. */
  clearProductCard(): void {
    this.#productRef = null;
    this.#productMeta = null;
  }

  /**
   * W7: Set the message to reply to. The composer renders a preview bar and
   * sends the next message with `threadRootMsgId` populated. Pass `null` to clear.
   */
  setReplyTarget(target: ReplySnapshot | null): void {
    this.#replyTarget = target;
    this.#renderReplyTarget();
  }

  mount(): void {
    // M3: early abort check — if signal already fired, skip mounting entirely
    if (this.#signal?.aborted) return;
    if (this.#root) return; // idempotent

    const root = document.createElement('div');
    root.className = 'oxp-composer';

    const textarea = document.createElement('textarea');
    textarea.className = 'oxp-composer-input';
    textarea.setAttribute('aria-label', t('messageInputAria', this.#lang));
    textarea.rows = 1;
    // M5: placeholder text
    textarea.placeholder = this.#placeholder;
    // M2: browser-native cap prevents paste beyond limit
    textarea.setAttribute('maxlength', String(MAX_BODY_CHARS));

    // M10: hidden hint for disabled-button screen reader context
    const sendHint = document.createElement('span');
    sendHint.id = 'oxp-send-hint';
    sendHint.className = 'oxp-sr-only';
    sendHint.textContent = t('messageEmpty', this.#lang);

    // W7: reply preview bar — hidden until setReplyTarget() is called.
    const replyEl = document.createElement('div');
    replyEl.className = 'oxp-composer-reply';
    // review pr-review-council 2026-07-14: role="status" carries an implicit
    // polite live region — no separate aria-live, and no landmark noise from
    // a bar that appears/disappears with every reply (unlike role="region",
    // meant for significant persistent sections).
    replyEl.setAttribute('role', 'status');
    replyEl.setAttribute('aria-label', t('replyingToMessageAria', this.#lang));
    replyEl.hidden = true;

    const replyContent = document.createElement('div');
    replyContent.className = 'oxp-composer-reply-content';

    const replyLabel = document.createElement('span');
    replyLabel.className = 'oxp-composer-reply-label';

    const replyBody = document.createElement('span');
    replyBody.className = 'oxp-composer-reply-body';

    replyContent.appendChild(replyLabel);
    replyContent.appendChild(replyBody);
    replyEl.appendChild(replyContent);

    const replyCancel = document.createElement('button');
    replyCancel.type = 'button';
    replyCancel.className = 'oxp-composer-reply-cancel';
    replyCancel.setAttribute('aria-label', t('cancelReply', this.#lang));
    replyCancel.textContent = '×';
    replyCancel.addEventListener('click', () => this.#clearReplyTarget());
    replyEl.appendChild(replyCancel);

    this.#replyEl = replyEl;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'oxp-composer-send';
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', t('sendMessageAria', this.#lang));
    sendBtn.setAttribute('aria-describedby', 'oxp-send-hint');
    sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22,2 15,22 11,13 2,9 22,2"></polygon></svg>`;
    sendBtn.disabled = true;

    // M9: input row — textarea + send button side by side.
    const main = document.createElement('div');
    main.className = 'oxp-composer-main';

    const hasAttachment =
      typeof this.#client.uploadAttachment === 'function' &&
      typeof this.#client.sendAttachmentMessage === 'function';
    const hasMediaDevices =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices === 'object' &&
      navigator.mediaDevices !== null;

    // W2.2 slice 4: paperclip attachment button (only when client supports uploadAttachment + sendAttachmentMessage)
    if (hasAttachment) {
      const attachBtn = document.createElement('button');
      attachBtn.type = 'button';
      attachBtn.className = 'oxp-composer-attachment-btn';
      attachBtn.setAttribute('aria-label', t('attachFilesAria', this.#lang));
      attachBtn.textContent = '📎';
      attachBtn.addEventListener('click', () => {
        this.#attachmentPicker?.openFileDialog();
      });
      main.appendChild(attachBtn);
    }

    // P0: voice recording trigger (same attachment capability + navigator.mediaDevices)
    let micBtn: HTMLButtonElement | null = null;
    if (hasAttachment && hasMediaDevices) {
      micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'oxp-composer-mic-btn';
      micBtn.setAttribute('aria-label', t('recordVoiceMessageAria', this.#lang));
      micBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
      micBtn.addEventListener('click', this.#onMicClick);
      main.appendChild(micBtn);
    }

    main.appendChild(textarea);
    main.appendChild(sendBtn);

    // Counter row sits below the input row.
    const footer = document.createElement('div');
    footer.className = 'oxp-composer-footer';

    const counter = document.createElement('span');
    counter.className = 'oxp-composer-counter';
    counter.setAttribute('aria-live', 'polite');
    counter.hidden = true;

    footer.appendChild(counter);

    // P0: voice recording UI — hidden until the user starts recording
    const recordingEl = document.createElement('div');
    recordingEl.className = 'oxp-composer-recording';
    recordingEl.setAttribute('role', 'status');
    recordingEl.setAttribute('aria-live', 'off');
    recordingEl.setAttribute(
      'aria-label',
      t('recordingLabel', this.#lang, { duration: formatDuration(0) }),
    );
    recordingEl.hidden = true;

    const recordingDot = document.createElement('span');
    recordingDot.className = 'oxp-recording-dot';
    recordingDot.setAttribute('aria-hidden', 'true');

    const recordingTimerEl = document.createElement('span');
    recordingTimerEl.className = 'oxp-recording-timer';
    recordingTimerEl.textContent = formatDuration(0);

    const recordingControls = document.createElement('div');
    recordingControls.style.display = 'flex';
    recordingControls.style.flexDirection = 'row';
    recordingControls.style.gap = 'calc(var(--oxp-spacing-unit) * 0.5)';

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'oxp-recording-stop-btn';
    stopBtn.setAttribute('aria-label', t('stopRecordingAria', this.#lang));
    stopBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    stopBtn.addEventListener('click', this.#onStopRecording);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'oxp-recording-cancel-btn';
    cancelBtn.setAttribute('aria-label', t('cancelRecordingAria', this.#lang));
    cancelBtn.textContent = '×';
    cancelBtn.addEventListener('click', this.#onCancelRecording);

    recordingControls.appendChild(stopBtn);
    recordingControls.appendChild(cancelBtn);
    recordingEl.appendChild(recordingDot);
    recordingEl.appendChild(recordingTimerEl);
    recordingEl.appendChild(recordingControls);

    root.appendChild(sendHint);
    root.appendChild(replyEl);
    root.appendChild(main);
    root.insertBefore(recordingEl, main);
    root.appendChild(footer);
    this.#container.appendChild(root);

    this.#root = root;
    this.#main = main;
    this.#footer = footer;
    this.#textarea = textarea;
    this.#sendBtn = sendBtn;
    this.#counter = counter;
    this.#micBtn = micBtn;
    this.#recordingEl = recordingEl;
    this.#recordingTimerEl = recordingTimerEl;

    // Event listeners
    textarea.addEventListener('input', this.#onInput);
    textarea.addEventListener('keydown', this.#onKeydown);
    sendBtn.addEventListener('click', this.#onSendClick);

    // W2.2 slice 4: paste + drag-drop (only when client supports uploadAttachment + sendAttachmentMessage)
    if (
      typeof this.#client.uploadAttachment === 'function' &&
      typeof this.#client.sendAttachmentMessage === 'function'
    ) {
      // Mount picker inside composer root for tray display
      const pickerContainer = document.createElement('div');
      root.insertBefore(pickerContainer, main);
      // uploadAttachment/sendAttachmentMessage existence is already guarded above; cast is safe
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#attachmentPicker = new AttachmentPicker({
        client: this.#client as any,
        roomId: this.#roomId,
        container: pickerContainer,
        signal: this.#signal,
        lang: this.#lang,
        onChange: () => this.#updateState(),
      });
      this.#attachmentPicker.mount();

      textarea.addEventListener('paste', this.#onPaste);
      root.addEventListener('dragover', this.#onDragover);
      root.addEventListener('dragleave', this.#onDragleave);
      root.addEventListener('drop', this.#onDrop);
    }

    // M3: { once: true } prevents double-destroy; early aborted already handled above
    this.#signal?.addEventListener('abort', () => this.destroy(), { once: true });

    // Focus textarea when mounted (if visible)
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        if (!this.#destroyed) textarea.focus();
      });
    }

    // CM1: apply pre-filled initial text (set via setInitialText() before mount)
    if (this.#initialText && textarea) {
      textarea.value = this.#initialText;
    }
    // 1F: initialize state on mount so counter + send-hint reflect initial value
    this.#updateState();
    // W7: render any reply target set before mount() was called.
    this.#renderReplyTarget();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#stopRecordingTimers();
    this.#voiceRecorder?.cancel();
    this.#voiceRecorder = null;

    if (this.#textarea) {
      this.#textarea.removeEventListener('input', this.#onInput);
      this.#textarea.removeEventListener('keydown', this.#onKeydown);
      this.#textarea.removeEventListener('paste', this.#onPaste);
    }
    if (this.#sendBtn) {
      this.#sendBtn.removeEventListener('click', this.#onSendClick);
    }
    if (this.#micBtn) {
      this.#micBtn.removeEventListener('click', this.#onMicClick);
    }
    if (this.#root) {
      this.#root.removeEventListener('dragover', this.#onDragover);
      this.#root.removeEventListener('dragleave', this.#onDragleave);
      this.#root.removeEventListener('drop', this.#onDrop);
    }

    this.#attachmentPicker?.destroy();
    this.#attachmentPicker = null;

    if (this.#root && this.#root.parentNode) {
      this.#root.parentNode.removeChild(this.#root);
    }

    this.#root = null;
    this.#main = null;
    this.#footer = null;
    this.#textarea = null;
    this.#sendBtn = null;
    this.#counter = null;
    this.#errorChip = null;
    this.#replyEl = null;
    this.#micBtn = null;
    this.#recordingEl = null;
    this.#recordingTimerEl = null;
  }

  // ── Private handlers ────────────────────────────────────────────────────────

  readonly #onInput = (): void => {
    this.#updateState();
    // M8: autogrow textarea height on input
    if (this.#textarea) {
      this.#textarea.style.height = 'auto';
      this.#textarea.style.height = `${autogrowHeightPx(this.#textarea.scrollHeight, 144)}px`;
    }
  };

  // W2.2 slice 4: paste handler — forward image files to picker.
  // Typed as Event so jsdom plain Event dispatches work in tests;
  // clipboardData is accessed via a type-safe cast to handle both ClipboardEvent and test stubs.
  readonly #onPaste = (ev: Event): void => {
    const clipboardData = (ev as { clipboardData?: { files?: FileList } }).clipboardData;
    const files = clipboardData?.files;
    if (!files || files.length === 0) return;
    // Only intercept if there are actual file items (not plain text)
    let hasFile = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f && f.size > 0) { hasFile = true; break; }
    }
    if (!hasFile) return;
    ev.preventDefault();
    this.#attachmentPicker?.handleFiles(files);
  };

  // W2.2 slice 4: drag-drop handlers
  // Typed as Event (not DragEvent) so jsdom plain Event dispatches work in tests.
  readonly #onDragover = (ev: Event): void => {
    ev.preventDefault();
    this.#root?.classList.add('oxp-composer-dragover');
  };

  readonly #onDragleave = (_ev: Event): void => {
    this.#root?.classList.remove('oxp-composer-dragover');
  };

  readonly #onDrop = (ev: Event): void => {
    ev.preventDefault();
    this.#root?.classList.remove('oxp-composer-dragover');
    // dataTransfer is available on DragEvent and also on our test stub via Object.defineProperty
    const dataTransfer = (ev as { dataTransfer?: { files?: FileList } }).dataTransfer;
    const files = dataTransfer?.files;
    if (files && files.length > 0) {
      this.#attachmentPicker?.handleFiles(files);
    }
  };

  readonly #onKeydown = (ev: KeyboardEvent): void => {
    // isCmdEnter already guards isComposing (M7)
    if (isCmdEnter(ev)) {
      ev.preventDefault();
      void this.#send();
    }
    // W7: Escape cancels the active reply target.
    if (ev.key === 'Escape' && this.#replyTarget) {
      ev.preventDefault();
      this.#clearReplyTarget();
    }
    // Plain Enter: default textarea behavior (newline) — no action needed
  };

  readonly #onSendClick = (): void => {
    void this.#send();
  };

  // P0: voice recording handlers
  readonly #onMicClick = (): void => {
    void this.#startRecording();
  };

  readonly #onStopRecording = (): void => {
    void this.#stopRecording();
  };

  readonly #onCancelRecording = (): void => {
    this.#cancelRecording();
  };

  async #startRecording(): Promise<void> {
    if (this.#isRecording || this.#sending || !this.#client.uploadAttachment || !this.#client.sendAttachmentMessage) {
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return;
    }

    let recorder: VoiceRecorder;
    try {
      recorder = await createVoiceRecorder();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#container.dispatchEvent(
        new CustomEvent('oxpulse-chat:error', {
          bubbles: true,
          composed: true,
          detail: { kind: 'voice_record_failed', message },
        }),
      );
      this.#renderErrorChip(message);
      return;
    }

    this.#voiceRecorder = recorder;
    this.#isRecording = true;
    this.#clearErrorChip();

    this.#recordingEl?.setAttribute(
      'aria-label',
      t('recordingLabel', this.#lang, { duration: formatDuration(0) }),
    );
    if (this.#recordingTimerEl) this.#recordingTimerEl.textContent = formatDuration(0);

    if (this.#main) this.#main.hidden = true;
    if (this.#footer) this.#footer.hidden = true;
    if (this.#recordingEl) this.#recordingEl.hidden = false;
    if (this.#replyEl) this.#replyEl.hidden = true;

    this.#updateRecordingUI();
    this.#recordingTimer = setInterval(() => this.#updateRecordingUI(), 250);
    this.#recordingAutoStopTimer = setTimeout(() => {
      void this.#stopRecording();
    }, MAX_VOICE_MS);
  }

  async #stopRecording(): Promise<void> {
    if (!this.#isRecording || !this.#voiceRecorder) return;

    const recorder = this.#voiceRecorder;
    this.#voiceRecorder = null;
    this.#stopRecordingTimers();

    let result: VoiceRecorderResult;
    try {
      result = await recorder.stop();
    } catch (err) {
      this.#resetRecordingUI();
      this.#handleRecordingError(err);
      return;
    }

    const valid = validateVoiceBlob({ size: result.blob.size, durationMs: result.durationMs });
    if (!valid.ok) {
      this.#resetRecordingUI();
      this.#renderErrorChip(valid.reason);
      return;
    }

    this.#sending = true;
    this.#resetRecordingUI();
    this.#updateState();

    try {
      const { attachment } = await this.#client.uploadAttachment!(this.#roomId, result.blob, {
        mimeType: result.mime,
        filename: sanitizeFilename(this.#voiceFilenameForMime(result.mime)),
      });
      const voiceAttachment = { ...attachment, durationMs: result.durationMs };
      await this.#client.sendAttachmentMessage!(this.#roomId, '', [voiceAttachment]);

      if (!this.#destroyed) {
        this.#clearReplyTarget();
        this.#clearErrorChip();
        if (this.#textarea) this.#textarea.value = '';
        this.#lastText = '';
        this.#productRef = null;
        this.#productMeta = null;
      }
    } catch (err) {
      this.#handleRecordingError(err);
    } finally {
      this.#sending = false;
      if (!this.#destroyed) this.#updateState();
    }
  }

  #cancelRecording(): void {
    if (!this.#isRecording || !this.#voiceRecorder) return;
    this.#voiceRecorder.cancel();
    this.#voiceRecorder = null;
    this.#resetRecordingUI();
  }

  #resetRecordingUI(): void {
    this.#isRecording = false;
    this.#stopRecordingTimers();
    this.#voiceRecorder = null;
    if (this.#recordingEl) this.#recordingEl.hidden = true;
    if (this.#main) this.#main.hidden = false;
    if (this.#footer) this.#footer.hidden = false;
    this.#renderReplyTarget();
    if (!this.#destroyed) this.#updateState();
  }

  #updateRecordingUI(): void {
    if (!this.#recordingTimerEl || !this.#recordingEl || !this.#voiceRecorder) return;
    const durationMs = this.#voiceRecorder.durationMs();
    const text = formatDuration(durationMs);
    this.#recordingTimerEl.textContent = text;
    this.#recordingEl.setAttribute('aria-label', t('recordingLabel', this.#lang, { duration: text }));
  }

  #stopRecordingTimers(): void {
    if (this.#recordingTimer) {
      clearInterval(this.#recordingTimer);
      this.#recordingTimer = null;
    }
    if (this.#recordingAutoStopTimer) {
      clearTimeout(this.#recordingAutoStopTimer);
      this.#recordingAutoStopTimer = null;
    }
  }

  #handleRecordingError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#container.dispatchEvent(
      new CustomEvent('oxpulse-chat:error', {
        bubbles: true,
        composed: true,
        detail: { kind: 'send_failed', message },
      }),
    );
    this.#renderErrorChip(message);
  }

  #voiceFilenameForMime(mime: string): string {
    return mime.includes('mp4') ? 'voice.mp4' : 'voice.webm';
  }

  // ── State updates ───────────────────────────────────────────────────────────

  #updateState(): void {
    if (!this.#textarea || !this.#sendBtn || !this.#counter) return;

    const text = this.#textarea.value;
    const len = text.length;
    const trimmed = text.trim();
    const hasStaged = this.#attachmentPicker?.hasStaged() ?? false;

    const overLimit = len > MAX_BODY_CHARS;
    const empty = trimmed.length === 0 && !hasStaged;
    this.#sendBtn.disabled = empty || overLimit || this.#sending;

    // M10 / 1G: update send-hint text for screen readers.
    // During #sending=true, hint reads "Sending message…" so SR announces correct state.
    const hint = this.#root?.querySelector('#oxp-send-hint');
    if (hint) {
      if (this.#sending) {
        hint.textContent = t('sendingMessage', this.#lang);
      } else if (overLimit) {
        hint.textContent = t('messageExceedsLimit', this.#lang);
      } else if (!empty) {
        hint.textContent = t('sendMessageAria', this.#lang);
      } else {
        hint.textContent = t('messageEmpty', this.#lang);
      }
    }

    // Counter visibility + M2: clamp display to 0 (never show negative)
    const showCounter = shouldShowCounter(len, MAX_BODY_CHARS);
    this.#counter.hidden = !showCounter;
    if (showCounter) {
      const remaining = Math.max(MAX_BODY_CHARS - len, 0);
      // M10: announce units for screen readers
      this.#counter.textContent = t('charactersRemaining', this.#lang, { remaining });
      this.#counter.dataset['overLimit'] = overLimit ? 'true' : 'false';
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────────

  /** Plain-text send (optimistic when e2ee is configured). Shared by the
   *  no-attachment path and the every-staged-item-got-cancelled fallback. */
  async #sendPlainText(text: string, sendArgs: SendTextArgs): Promise<void> {
    // M1: Boolean() truthy check — e2ee=false must NOT trigger optimistic path
    const useOptimistic =
      typeof this.#client.sendTextOptimistic === 'function' &&
      Boolean(this.#client.e2ee);

    if (useOptimistic) {
      await this.#client.sendTextOptimistic!(this.#roomId, text, sendArgs);
    } else {
      await this.#client.sendText(this.#roomId, text, sendArgs);
    }
  }

  async #send(textOverride?: string): Promise<void> {
    if (!this.#textarea || !this.#sendBtn) return;

    const text = textOverride ?? this.#textarea.value.trim();
    const hasStaged = this.#attachmentPicker?.hasStaged() ?? false;
    if (text.length === 0 && !hasStaged) return;
    if (text.length > MAX_BODY_CHARS) return;

    // Save for retry before the send attempt
    this.#lastText = text;

    this.#sending = true;
    this.#sendBtn.disabled = true;
    // 1E: disable textarea during send to prevent data-loss race.
    // CM3: textarea disabled during send prevents all user input — the preserve-branch
    // ("user typed new content while send was in-flight") is unreachable because
    // the browser blocks keyboard input to disabled elements. The user's typed content
    // cannot be lost by clearing a textarea they cannot type into.
    if (this.#textarea) this.#textarea.disabled = true;
    // Review fix (HIGH, PR #88): defense-in-depth — a real user can no longer
    // click ✕ mid-send once this is wired (jsdom-verified: a disabled
    // button's native .click() no-ops the activation, matching real browsers).
    // The re-check below is the actual guard, since setSendLocked alone
    // wouldn't cover every way #items could still empty out mid-await.
    this.#attachmentPicker?.setSendLocked(true);
    // 1G: update hint to "Sending message…" while in-flight
    this.#updateState();
    // Clear any previous error chip
    this.#clearErrorChip();

    try {
      const sendArgs: SendTextArgs = {};
      if (this.#replyTarget) {
        sendArgs.threadRootMsgId = this.#replyTarget.msgId;
      }
      if (this.#productRef && this.#productMeta) {
        sendArgs.productRef = this.#productRef;
        sendArgs.productMeta = this.#productMeta;
      }

      if (hasStaged) {
        // Await any in-flight uploads; on error awaitAllUploaded rejects and the
        // tray stays visible with the failed item(s) so the user can retry/remove.
        await this.#attachmentPicker!.awaitAllUploaded();
        // Review fix (HIGH, PR #88): re-read the staged list rather than
        // trusting the `hasStaged` snapshot taken above — every item can be
        // removed while this await is in flight, and awaitAllUploaded()
        // resolves vacuously once the list is empty ([].every(...) === true).
        // Without this re-check, sendAttachmentMessage(text, []) would
        // broadcast a sealed envelope with zero attachments, which peers
        // render as raw JSON text instead of decoding as an attachment message.
        const staged = this.#attachmentPicker!.getStaged();
        if (staged.length === 0 && text.length === 0) {
          return;
        }
        if (staged.length === 0) {
          // Every staged attachment was cancelled mid-send but the caption
          // survives — send it as a plain text message instead of dropping it.
          await this.#sendPlainText(text, sendArgs);
        } else {
          const attachments = staged.map((item) => ({
            id: item.attachmentId!,
            mime: item.mime,
            filename: sanitizeFilename(item.file.name),
            sizeBytes: item.sizeBytes,
            width: item.width,
            height: item.height,
          }));
          await this.#client.sendAttachmentMessage!(this.#roomId, text, attachments, sendArgs);
        }
      } else {
        await this.#sendPlainText(text, sendArgs);
      }

      // 1E: Clear only if not destroyed during the send.
      // CM3: textarea was disabled during send — user cannot type new content mid-flight,
      // so textarea.value is still the sent text. Safe to clear unconditionally.
      if (!this.#destroyed && this.#textarea) {
        this.#textarea.disabled = false;
        this.#textarea.value = '';
        this.#lastText = '';
        this.#productRef = null;
        this.#productMeta = null;
        this.#clearReplyTarget();
        this.#attachmentPicker?.clearStaged();
        this.#updateState();
      }
    } catch (err) {
      // Dispatch error event on the container (bubbles up to shadow root)
      const message = err instanceof Error ? err.message : String(err);
      const detail: { kind: string; message: string; msgId?: string } = {
        kind: 'send_failed',
        message,
      };
      this.#container.dispatchEvent(
        new CustomEvent('oxpulse-chat:error', {
          bubbles: true,
          composed: true,
          detail,
        }),
      );

      // B2: Render inline error chip with retry button
      if (!this.#destroyed) {
        this.#renderErrorChip(message);
      }
    } finally {
      this.#sending = false;
      // 1E: re-enable textarea (in case catch path ran without re-enabling in try)
      if (!this.#destroyed && this.#textarea && this.#textarea.disabled) {
        this.#textarea.disabled = false;
      }
      if (!this.#destroyed) this.#attachmentPicker?.setSendLocked(false);
      if (!this.#destroyed) this.#updateState();
    }
  }

  // ── Error chip ──────────────────────────────────────────────────────────────

  #renderErrorChip(message: string): void {
    this.#clearErrorChip();
    if (!this.#root) return;

    const chip = document.createElement('div');
    chip.className = 'oxp-composer-error';
    chip.setAttribute('role', 'alert');
    chip.setAttribute('aria-live', 'assertive');

    const msg = document.createElement('span');
    msg.textContent = message;

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = t('retry', this.#lang);
    retryBtn.setAttribute('aria-label', t('retrySendingMessageAria', this.#lang));
    retryBtn.addEventListener('click', () => {
      this.#clearErrorChip();
      void this.#send(this.#lastText);
    });

    chip.appendChild(msg);
    chip.appendChild(retryBtn);
    this.#root.appendChild(chip);
    this.#errorChip = chip;
  }

  #clearErrorChip(): void {
    if (this.#errorChip && this.#errorChip.parentNode) {
      this.#errorChip.parentNode.removeChild(this.#errorChip);
    }
    this.#errorChip = null;
  }

  // ── Reply target preview ────────────────────────────────────────────────────

  /** Render or clear the reply preview bar based on #replyTarget. */
  #renderReplyTarget(): void {
    if (!this.#replyEl) return;
    if (!this.#replyTarget) {
      this.#replyEl.hidden = true;
      return;
    }

    const label = this.#replyEl.querySelector('.oxp-composer-reply-label');
    const body = this.#replyEl.querySelector('.oxp-composer-reply-body');
    if (label) {
      label.textContent = t('replyToLabel', this.#lang, { sender: this.#replyTarget.sender });
    }
    if (body) {
      body.textContent = formatBodyPreview(this.#replyTarget.body);
    }
    this.#replyEl.hidden = false;
  }

  /** Clear the active reply target and update the preview bar. */
  #clearReplyTarget(): void {
    this.#replyTarget = null;
    this.#renderReplyTarget();
  }
}
