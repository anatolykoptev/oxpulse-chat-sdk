/**
 * @oxpulse/chat-widget — Composer (W2.2 slice 2, fix-loop).
 *
 * Plain-text message input + send path.
 * Dispatches `oxpulse-chat:error` on send failure + renders inline error chip.
 * Uses theme tokens exclusively — no inline hex.
 */

import { shouldShowCounter, isCmdEnter, MAX_BODY_CHARS, autogrowHeightPx } from '../utils/textfield-helpers.js';
import { AttachmentPicker } from './attachment-picker.js';
import { EmojiPicker } from './emoji-picker.js';
import { ProductPicker } from './product-picker.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import type { ProductMeta } from '../types.js';
import { formatBodyPreview, type ReplySnapshot } from '../utils/reply-helpers.js';
import { sanitizeFilename } from '../utils/attachments.js';
import type { EnvelopeAttachment } from '../utils/attachment-envelope.js';
import { createVoiceRecorder, validateVoiceBlob, type VoiceRecorder, type VoiceRecorderResult, extractPeaksFromBlob, attachAnalyserTap, type AnalyserTap, renderStaticWaveform, type WaveformTheme } from '@oxpulse/voice-core';
import { formatDuration } from '../utils/list-helpers.js';
import { createVoiceBubble, resolveToken, type VoiceBubble } from './voice-bubble.js';
import { createVoiceGesture, type VoiceGesture } from './voice-gesture.js';

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
  /** #120: broadcast typing indicator. Fire-and-forget. */
  sendTyping?(roomId: string, ttlSecs?: number): Promise<void>;
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
  /** MAJOR-5: Optional shadow root so the emoji picker mounts outside overflow:hidden
   *  widgetRoot — mirrors MessageList's shadowHost pattern. */
  shadowHost?: ShadowRoot;
  /** Seller product catalog client — when present, shows a product picker
   *  button in the toolbar. onSelect → setProductCard(ref, meta). */
  catalogClient?: import('@oxpulse/chat-sdk').SDKCatalogClient;
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
  /** #120: typing indicator throttle — last sendTyping POST timestamp. */
  #lastTypingSent = 0;
  /** #120: typing throttle interval (ms) — Stream-proven 2s cadence. */
  readonly #typingThrottleMs = 2000;
  /** #120: typing TTL (seconds) sent to server — auto-clears after this. */
  readonly #typingTtlSec = 3;

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
  /** #127: emoji picker — searchable, categorized. */
  #emojiPicker: EmojiPicker | null = null;
  /** Seller product catalog picker — searchable dropdown. */
  #productPicker: ProductPicker | null = null;
  /** Optional catalog client for the product picker button. */
  #catalogClient: import('@oxpulse/chat-sdk').SDKCatalogClient | null = null;
  /** MAJOR-5: shadow root for mounting emoji picker outside overflow:hidden widgetRoot. */
  #shadowHost: ShadowRoot | undefined;
  /** W9: optional product card to attach to the next outgoing text message. */
  #productRef: string | null = null;
  #productMeta: ProductMeta | null = null;
  /** W7: snapshot of the message being replied to, or null when not replying. */
  #replyTarget: ReplySnapshot | null = null;
  /** W7: reply preview bar container — created in mount(), populated by setReplyTarget(). */
  #replyEl: HTMLDivElement | null = null;
  /** #113: product-card attached chip container — created in mount(), populated by setProductCard(). */
  #productCardEl: HTMLDivElement | null = null;

  // P0: voice recording
  #main: HTMLElement | null = null;
  #footer: HTMLElement | null = null;
  #micBtn: HTMLButtonElement | null = null;
  #recordingEl: HTMLElement | null = null;
  #recordingTimerEl: HTMLElement | null = null;
  #voiceRecorder: VoiceRecorder | null = null;
  #recordingTimer: ReturnType<typeof setInterval> | null = null;
  #isRecording = false;

  // Live recording waveform + hold-to-record gesture (burner-parity).
  #recordingWaveEl: HTMLCanvasElement | null = null;
  #recordingHintEl: HTMLElement | null = null;
  #recordingLockControlsEl: HTMLElement | null = null;
  #voiceGesture: VoiceGesture | null = null;
  /** Analyser tapped off the recorder's live stream — drives the waveform.
   *  MUST be closed (tap.stop()) BEFORE the recorder stops its tracks. */
  #voiceTap: AnalyserTap | null = null;
  readonly #voiceBars = new Float32Array(48);
  readonly #voiceScratch = new Uint8Array(1024);
  #voiceRaf = 0;

  // P0 follow-up: voice pre-send preview
  #voicePreviewEl: HTMLElement | null = null;
  #voicePreviewBubbleHost: HTMLElement | null = null;
  #voicePreviewBubble: VoiceBubble | null = null;
  #voicePreviewSend: HTMLButtonElement | null = null;
  #voicePreviewDiscard: HTMLButtonElement | null = null;
  /** Active-flag for the voice preview. Set to a non-null marker when a
   *  recording is staged for review; the VoiceBubble's headless player owns
   *  the actual blob: URL (created from #voicePreviewBlob, revoked on
   *  destroy) — this field is NOT a URL anymore, just a presence sentinel
   *  preserving the existing `!== null` checks across #updateState /
   *  #sendVoicePreview / #discardVoicePreview. */
  #voicePreviewObjectURL: string | null = null;
  #voicePreviewBlob: Blob | null = null;
  #voicePreviewDuration = 0;
  #voicePreviewMime = '';
  #voicePreviewFilename = '';
  #voicePreviewPeaks: number[] = [];

  constructor(opts: ComposerOptions) {
    this.#container = opts.container;
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
    this.#placeholder = opts.placeholder ?? t('composerPlaceholder', this.#lang);
    this.#shadowHost = opts.shadowHost;
    this.#catalogClient = opts.catalogClient ?? null;
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
   *
   * Routing (#114): the widget sends cards through `sendText()` with
   * `productRef`/`productMeta` args rather than the SDK's standalone
   * `sendProductCard()` convenience API — see the doc-comment on
   * `SDKChatClient.sendProductCard` in packages/chat-sdk/src/client.ts for
   * the rationale. Both paths produce the same wire payload.
   */
  setProductCard(productRef: string, productMeta: ProductMeta): void {
    this.#productRef = productRef;
    this.#productMeta = productMeta;
    this.#renderProductCardChip();
    // A staged card makes the message sendable even with an empty textarea
    // (bare marketplace card) — refresh the send-button enabled state.
    this.#updateState();
  }

  /** Clear a previously set product card without sending. */
  clearProductCard(): void {
    this.#productRef = null;
    this.#productMeta = null;
    this.#renderProductCardChip();
    this.#updateState();
  }

  /** True when a product card is staged to ride the next send. */
  #hasPendingProductCard(): boolean {
    return this.#productRef !== null && this.#productMeta !== null;
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

    // #113: product-card attached chip — hidden until setProductCard() is called.
    // Mirrors the reply-preview bar pattern (role="status", dismiss × button).
    const productCardEl = document.createElement('div');
    productCardEl.className = 'oxp-composer-product-chip';
    productCardEl.setAttribute('role', 'status');
    productCardEl.setAttribute('aria-label', t('productCardAttached', this.#lang, { title: '' }));
    productCardEl.hidden = true;

    const productCardLabel = document.createElement('span');
    productCardLabel.className = 'oxp-composer-product-chip-label';
    productCardEl.appendChild(productCardLabel);

    const productCardCancel = document.createElement('button');
    productCardCancel.type = 'button';
    productCardCancel.className = 'oxp-composer-product-chip-cancel';
    productCardCancel.setAttribute('aria-label', t('removeProductCard', this.#lang));
    productCardCancel.textContent = '×';
    productCardCancel.addEventListener('click', () => this.clearProductCard());
    productCardEl.appendChild(productCardCancel);

    this.#productCardEl = productCardEl;

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
      attachBtn.setAttribute('title', t('attachFilesTitle', this.#lang));
      attachBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
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
      micBtn.setAttribute('title', t('recordVoiceMessageTitle', this.#lang));
      micBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
      // Hold-to-record gesture (created after mount, once #micBtn is set) wires
      // pointer + keyboard events — no click listener here.
      main.appendChild(micBtn);
    }

    // #127: emoji picker button — opens a searchable emoji grid.
    const emojiBtn = document.createElement('button');
    emojiBtn.type = 'button';
    emojiBtn.className = 'oxp-composer-emoji-btn';
    emojiBtn.setAttribute('aria-label', t('emojiPickerBtnAria', this.#lang));
    emojiBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
    emojiBtn.addEventListener('click', () => {
      if (this.#signal?.aborted) return;
      if (this.#emojiPicker?.isOpen) {
        this.#emojiPicker.hide();
        return;
      }
      if (!this.#emojiPicker) {
        this.#emojiPicker = new EmojiPicker({
          container: root,
          onSelect: (emoji) => this.#insertEmoji(emoji),
          signal: this.#signal,
          lang: this.#lang,
          mountTo: this.#shadowHost ? (this.#shadowHost as unknown as HTMLElement) : undefined,
        });
      }
      this.#emojiPicker.show(emojiBtn, emojiBtn);
    });
    main.appendChild(emojiBtn);

    // Seller product catalog picker button — shown only when catalogClient
    // is provided. Opens a searchable dropdown; onSelect → setProductCard.
    if (this.#catalogClient) {
      const productBtn = document.createElement('button');
      productBtn.type = 'button';
      productBtn.className = 'oxp-composer-product-btn';
      productBtn.setAttribute('aria-label', t('productPickerBtnAria', this.#lang));
      productBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1-5h16l1 5"/><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 13h6"/></svg>';
      productBtn.addEventListener('click', () => {
        if (this.#signal?.aborted) return;
        if (this.#productPicker?.isOpen) {
          this.#productPicker.hide();
          return;
        }
        if (!this.#productPicker) {
          this.#productPicker = new ProductPicker({
            container: root,
            client: this.#catalogClient!,
            onSelect: (ref, meta) => this.setProductCard(ref, meta),
            signal: this.#signal,
            lang: this.#lang,
            mountTo: this.#shadowHost ? (this.#shadowHost as unknown as HTMLElement) : undefined,
          });
        }
        this.#productPicker.show(productBtn, productBtn);
      });
      main.appendChild(productBtn);
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

    // Live waveform — painted at RAF from the recorder's analyser tap while
    // recording. Purely decorative → aria-hidden (the timer carries the
    // live-region announcement).
    const recordingWave = document.createElement('canvas');
    recordingWave.className = 'oxp-recording-wave';
    recordingWave.setAttribute('aria-hidden', 'true');

    // Slide hint — shown while held (unlocked). Hidden once locked.
    const recordingHint = document.createElement('span');
    recordingHint.className = 'oxp-recording-hint';
    recordingHint.setAttribute('aria-hidden', 'true');
    recordingHint.textContent = t('voiceSlideHint', this.#lang);

    // Lock-mode controls — revealed once the gesture latches locked recording
    // (slide-to-lock, quick tap, or keyboard start).
    const recordingLockControls = document.createElement('div');
    recordingLockControls.className = 'oxp-recording-lock-controls';
    recordingLockControls.hidden = true;

    const lockIcon = document.createElement('span');
    lockIcon.className = 'oxp-recording-lock-icon';
    lockIcon.setAttribute('aria-hidden', 'true');
    lockIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

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

    recordingLockControls.appendChild(lockIcon);
    recordingLockControls.appendChild(stopBtn);
    recordingLockControls.appendChild(cancelBtn);
    recordingEl.appendChild(recordingDot);
    recordingEl.appendChild(recordingTimerEl);
    recordingEl.appendChild(recordingWave);
    recordingEl.appendChild(recordingHint);
    recordingEl.appendChild(recordingLockControls);

    // P0 follow-up: voice pre-send preview — hidden until recording stops.
    // Phase 2: the preview player is a VoiceBubble shell (headless player +
    // waveform) built dynamically in #showVoicePreview, hosted here. Replaces
    // the native <audio controls> — same shell the message-list uses, so the
    // 0.12.0 P3 nits (orphaned <audio> node after discard; 0:00 scrubber
    // pre-metadata) are fixed by construction.
    const voicePreviewEl = document.createElement('div');
    voicePreviewEl.className = 'oxp-composer-voice-preview';
    voicePreviewEl.setAttribute('role', 'status');
    voicePreviewEl.setAttribute('aria-label', t('voicePreviewLabel', this.#lang));
    voicePreviewEl.hidden = true;

    const voicePreviewBubbleHost = document.createElement('div');
    voicePreviewBubbleHost.className = 'oxp-voice-preview-host';

    const voicePreviewSend = document.createElement('button');
    voicePreviewSend.type = 'button';
    voicePreviewSend.className = 'oxp-voice-preview-send';
    voicePreviewSend.setAttribute('aria-label', t('sendVoiceMessageAria', this.#lang));
    voicePreviewSend.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22,2 15,22 11,13 2,9 22,2"></polygon></svg>';
    voicePreviewSend.addEventListener('click', () => this.#sendVoicePreview());

    const voicePreviewDiscard = document.createElement('button');
    voicePreviewDiscard.type = 'button';
    voicePreviewDiscard.className = 'oxp-voice-preview-discard';
    voicePreviewDiscard.setAttribute('aria-label', t('discardVoiceMessageAria', this.#lang));
    voicePreviewDiscard.textContent = '×';
    voicePreviewDiscard.addEventListener('click', () => this.#discardVoicePreview());

    voicePreviewEl.appendChild(voicePreviewBubbleHost);
    voicePreviewEl.appendChild(voicePreviewSend);
    voicePreviewEl.appendChild(voicePreviewDiscard);

    root.appendChild(sendHint);
    root.appendChild(replyEl);
    root.appendChild(productCardEl);
    root.appendChild(main);
    root.insertBefore(recordingEl, main);
    root.insertBefore(voicePreviewEl, main);
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
    this.#recordingWaveEl = recordingWave;
    this.#recordingHintEl = recordingHint;
    this.#recordingLockControlsEl = recordingLockControls;
    this.#voicePreviewEl = voicePreviewEl;
    this.#voicePreviewBubbleHost = voicePreviewBubbleHost;
    this.#voicePreviewSend = voicePreviewSend;
    this.#voicePreviewDiscard = voicePreviewDiscard;

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

    // Hold-to-record gesture: wires pointer + keyboard events on the mic
    // button and drives lock/will-cancel UI. The composer owns the recorder,
    // the analyser tap, and the live-waveform paint loop.
    if (this.#micBtn) {
      this.#voiceGesture = createVoiceGesture(this.#micBtn, {
        start: () => this.#startRecording(),
        stop: () => { void this.#stopRecording(); },
        cancel: () => { this.#cancelRecording(); },
        isRecording: () => this.#isRecording,
        onLockChange: (locked) => this.#setRecordingLocked(locked),
        onWillCancelChange: (willCancel) => this.#setRecordingWillCancel(willCancel),
      });
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#stopRecordingTimers();
    // Voice teardown, ordered: stop the gesture listeners + paint loop, close
    // the analyser tap's AudioContext, THEN cancel the recorder (which stops
    // the MediaStream tracks) so the mic is released and nothing leaks.
    this.#voiceGesture?.destroy();
    this.#voiceGesture = null;
    this.#stopVoicePaint();
    this.#voiceTap?.stop();
    this.#voiceTap = null;
    this.#voiceRecorder?.cancel();
    this.#voiceRecorder = null;

    // Revoke any dangling voice preview objectURL before the root is removed.
    this.#clearVoicePreview();

    if (this.#textarea) {
      this.#textarea.removeEventListener('input', this.#onInput);
      this.#textarea.removeEventListener('keydown', this.#onKeydown);
      this.#textarea.removeEventListener('paste', this.#onPaste);
    }
    if (this.#sendBtn) {
      this.#sendBtn.removeEventListener('click', this.#onSendClick);
    }
    if (this.#root) {
      this.#root.removeEventListener('dragover', this.#onDragover);
      this.#root.removeEventListener('dragleave', this.#onDragleave);
      this.#root.removeEventListener('drop', this.#onDrop);
    }

    this.#attachmentPicker?.destroy();
    this.#attachmentPicker = null;
    this.#emojiPicker?.hide();
    this.#emojiPicker = null;
    this.#productPicker?.hide();
    this.#productPicker = null;

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
    this.#productCardEl = null;
    this.#micBtn = null;
    this.#recordingEl = null;
    this.#recordingTimerEl = null;
    this.#recordingWaveEl = null;
    this.#recordingHintEl = null;
    this.#recordingLockControlsEl = null;
    this.#voicePreviewEl = null;
    this.#voicePreviewBubbleHost = null;
    this.#voicePreviewSend = null;
    this.#voicePreviewDiscard = null;
  }

  // ── Private handlers ────────────────────────────────────────────────────────

  readonly #onInput = (): void => {
    this.#updateState();
    // M8: autogrow textarea height on input
    if (this.#textarea) {
      this.#textarea.style.height = 'auto';
      this.#textarea.style.height = `${autogrowHeightPx(this.#textarea.scrollHeight, 144)}px`;
    }
    // #120: typing indicator — throttled sendTyping on keystroke.
    // Fire-and-forget; errors are swallowed (typing is best-effort UX).
    if (this.#client.sendTyping && this.#textarea && this.#textarea.value.trim()) {
      const now = Date.now();
      if (now - this.#lastTypingSent >= this.#typingThrottleMs) {
        this.#lastTypingSent = now;
        void this.#client.sendTyping(this.#roomId, this.#typingTtlSec).catch(() => {});
      }
    }
  };

  // W2.2 slice 4: paste handler — forward image files to picker.
  // Typed as Event so jsdom plain Event dispatches work in tests;

  /** #127: insert emoji at cursor position in textarea. */
  #insertEmoji(emoji: string): void {
    const ta = this.#textarea;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = before + emoji + after;
    // Move cursor after the inserted emoji
    const newCursor = start + emoji.length;
    ta.setSelectionRange(newCursor, newCursor);
    ta.focus();
    this.#updateState();
    // M8: autogrow after insert
    ta.style.height = 'auto';
    ta.style.height = `${autogrowHeightPx(ta.scrollHeight, 144)}px`;
  }
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

  // P0: voice recording handlers. Recording is started by the hold-to-record
  // gesture (pointer/keyboard on the mic button), not a click. The locked-mode
  // Stop/Cancel buttons route through the gesture so its lock state is cleared.
  readonly #onStopRecording = (): void => {
    if (this.#voiceGesture?.locked) {
      this.#voiceGesture.stopLocked();
      return;
    }
    void this.#stopRecording();
  };

  readonly #onCancelRecording = (): void => {
    if (this.#voiceGesture?.locked) {
      this.#voiceGesture.cancelLocked();
      return;
    }
    this.#cancelRecording();
  };

  /** Start recording. Returns true iff a recording actually began (mic granted)
   *  so the gesture knows whether to keep the pointer captured. */
  async #startRecording(): Promise<boolean> {
    if (this.#isRecording || this.#sending || !this.#client.uploadAttachment || !this.#client.sendAttachmentMessage) {
      return false;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return false;
    }

    // If a previous voice preview is still open, discard it (and revoke its objectURL)
    // before starting a new recording.
    if (this.#voicePreviewObjectURL) {
      this.#clearVoicePreview();
    }

    // Guard mic re-entrancy BEFORE the async getUserMedia call so a second
    // synchronous click cannot acquire a second stream and orphan the first.
    this.#isRecording = true;

    let recorder: VoiceRecorder;
    try {
      // onAutoStop: on the MAX_VOICE_MS cap, the recorder hands control back so
      // #stopRecording closes the analyser tap BEFORE the tracks stop (correct
      // teardown ordering) — one auto-stop path, no dual-timer race. INVARIANT:
      // #stopRecording must call recorder.stop() synchronously (before its first
      // await) so the recorder's safety-net self-stop sees stopping=true and
      // skips — do not insert an await ahead of that call.
      recorder = await createVoiceRecorder(undefined, {
        onAutoStop: () => { void this.#stopRecording(); },
      });
    } catch (err) {
      this.#isRecording = false;
      const message = err instanceof Error ? err.message : String(err);
      this.#container.dispatchEvent(
        new CustomEvent('oxpulse-chat:error', {
          bubbles: true,
          composed: true,
          detail: { kind: 'voice_record_failed', message },
        }),
      );
      this.#renderErrorChip(message);
      return false;
    }

    // The widget may have been destroyed while getUserMedia was pending (SPA
    // nav / unmount with the permission prompt open). Re-check before wiring the
    // recorder + tap + RAF onto a dead component — otherwise the mic stays live
    // and the AudioContext leaks (every other async path re-checks #destroyed).
    if (this.#destroyed) {
      recorder.cancel();
      this.#isRecording = false;
      return false;
    }

    this.#voiceRecorder = recorder;
    this.#isRecording = true;
    this.#clearErrorChip();

    // Live waveform: tap the SAME stream the recorder ships — no second
    // getUserMedia grant. Null when AudioContext is unavailable (the chip
    // then shows a flat baseline, no crash).
    this.#voiceTap = attachAnalyserTap(recorder.stream);

    // Fresh chip state — start unlocked, hint visible, not will-cancel.
    this.#setRecordingLocked(false);
    this.#setRecordingWillCancel(false);

    this.#recordingEl?.setAttribute(
      'aria-label',
      t('recordingLabel', this.#lang, { duration: formatDuration(0) }),
    );
    if (this.#recordingTimerEl) this.#recordingTimerEl.textContent = formatDuration(0);

    if (this.#main) this.#main.hidden = true;
    if (this.#footer) this.#footer.hidden = true;
    if (this.#recordingEl) this.#recordingEl.hidden = false;
    if (this.#replyEl) this.#replyEl.hidden = true;

    this.#startVoicePaint();
    this.#updateRecordingUI();
    this.#recordingTimer = setInterval(() => this.#updateRecordingUI(), 250);
    // The MAX_VOICE_MS cap is enforced by the recorder's internal timer, which
    // calls onAutoStop → #stopRecording (tap closed before tracks stop).
    return true;
  }

  async #stopRecording(): Promise<void> {
    if (!this.#isRecording || !this.#voiceRecorder) return;

    const recorder = this.#voiceRecorder;
    this.#voiceRecorder = null;
    this.#stopRecordingTimers();

    // Close the analyser tap's AudioContext BEFORE recorder.stop() stops the
    // MediaStream tracks — the MediaStreamAudioSourceNode must be released
    // first (web/CLAUDE.md WebRTC ordering rule).
    this.#stopVoicePaint();
    this.#voiceTap?.stop();
    this.#voiceTap = null;

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

    // Finalize: enter the pre-send preview state. Upload + send happen only
    // when the user explicitly clicks the preview Send button.
    this.#voicePreviewBlob = result.blob;
    this.#voicePreviewDuration = result.durationMs;
    this.#voicePreviewMime = result.mime;
    this.#voicePreviewFilename = sanitizeFilename(this.#voiceFilenameForMime(result.mime));
    // Phase 2: compute waveform peaks now so the receiver renders the real
    // waveform. extractPeaksFromBlob decodes via OfflineAudioContext (returns
    // [] when unavailable — e.g. jsdom — caller treats empty as flat
    // fallback). The player owns the blob: URL for the preview; this field is
    // just the active-presence sentinel now.
    this.#voicePreviewPeaks = [...(await extractPeaksFromBlob(result.blob))];
    this.#voicePreviewObjectURL = 'preview-active';

    this.#resetRecordingUI();
    this.#showVoicePreview();
  }

  #cancelRecording(): void {
    if (!this.#isRecording || !this.#voiceRecorder) return;
    // Same ordering as stop: close the tap before the tracks stop.
    this.#stopVoicePaint();
    this.#voiceTap?.stop();
    this.#voiceTap = null;
    this.#voiceRecorder.cancel();
    this.#voiceRecorder = null;
    this.#resetRecordingUI();
  }

  #resetRecordingUI(): void {
    this.#isRecording = false;
    // Defensive teardown for paths that didn't go through stop/cancel
    // (validation reject, destroy mid-record). Paint + tap are idempotent.
    this.#stopVoicePaint();
    if (this.#voiceTap) {
      this.#voiceTap.stop();
      this.#voiceTap = null;
    }
    this.#setRecordingLocked(false);
    this.#setRecordingWillCancel(false);
    this.#stopRecordingTimers();
    this.#voiceRecorder = null;
    if (this.#recordingEl) this.#recordingEl.hidden = true;
    if (this.#main) this.#main.hidden = false;
    if (this.#footer) this.#footer.hidden = false;
    this.#renderReplyTarget();
    if (!this.#destroyed) this.#updateState();
  }

  // ── Live waveform + lock/will-cancel chip state ──────────────────────────

  /** Toggle the chip between held (slide-hint) and locked (Stop/Cancel). */
  #setRecordingLocked(locked: boolean): void {
    this.#recordingEl?.classList.toggle('oxp-recording--locked', locked);
    if (this.#recordingHintEl) this.#recordingHintEl.hidden = locked;
    if (this.#recordingLockControlsEl) this.#recordingLockControlsEl.hidden = !locked;
  }

  /** Toggle the will-cancel (slide-up) affordance — red chip + hint swap. */
  #setRecordingWillCancel(willCancel: boolean): void {
    this.#recordingEl?.classList.toggle('oxp-recording--will-cancel', willCancel);
    if (this.#recordingHintEl) {
      this.#recordingHintEl.textContent = t(
        willCancel ? 'voiceReleaseToCancelHint' : 'voiceSlideHint',
        this.#lang,
      );
    }
  }

  /** Build the live-wave theme from widget tokens (active = --oxp-accent). At
   *  progress = 1 every bar is active, so `inactive` is unused during record
   *  but kept for parity with the bubble's static waveform. */
  #liveWaveTheme(): WaveformTheme {
    const el = this.#recordingWaveEl ?? this.#recordingEl ?? this.#container;
    const active = (el instanceof HTMLElement && resolveToken(el, '--oxp-accent')) || '#0088cc';
    const inactive =
      (el instanceof HTMLElement && resolveToken(el, '--oxp-waveform-inactive')) ||
      'rgba(0,0,0,0.55)';
    return { active, inactive };
  }

  /** Start the RAF paint loop feeding analyser samples into the live wave. */
  #startVoicePaint(): void {
    this.#voiceBars.fill(0);
    // Resolve the theme ONCE — tokens don't change mid-recording, and reading
    // them per frame would force a style recalc on every RAF tick.
    const theme = this.#liveWaveTheme();
    const loop = (): void => {
      if (!this.#isRecording) {
        this.#voiceRaf = 0;
        return;
      }
      if (this.#voiceTap) this.#voiceTap.sampleLiveBars(this.#voiceBars, this.#voiceScratch, 0.7);
      if (this.#recordingWaveEl) {
        // progress = 1 → all bars active (live-recording look). Pass the reused
        // Float32Array directly — renderStaticWaveform takes ArrayLike<number>.
        renderStaticWaveform(this.#recordingWaveEl, this.#voiceBars, 1, theme);
      }
      this.#voiceRaf = requestAnimationFrame(loop);
    };
    this.#voiceRaf = requestAnimationFrame(loop);
  }

  #stopVoicePaint(): void {
    if (this.#voiceRaf) {
      cancelAnimationFrame(this.#voiceRaf);
      this.#voiceRaf = 0;
    }
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

  // P0 follow-up: voice pre-send preview

  #showVoicePreview(): void {
    if (!this.#voicePreviewEl || !this.#voicePreviewBubbleHost || !this.#voicePreviewBlob) return;

    // Tear down any previous preview bubble (e.g. a re-record without an
    // explicit discard) — its player revokes the blob: URL it owned.
    this.#destroyVoicePreviewBubble();

    // The preview plays from the recorded Blob directly — the headless
    // player creates + owns the objectURL and revokes it on destroy(). No
    // authed loader needed here (the blob is already in memory).
    const bubble = createVoiceBubble({
      att: {
        id: 'voice-preview',
        url: '',
        mime: this.#voicePreviewMime,
        filename: this.#voicePreviewFilename,
        sizeBytes: this.#voicePreviewBlob.size,
        durationMs: this.#voicePreviewDuration,
        peaks: this.#voicePreviewPeaks,
      },
      blob: this.#voicePreviewBlob,
      lang: this.#lang,
    });
    this.#voicePreviewBubble = bubble;
    this.#voicePreviewBubbleHost.appendChild(bubble.el);

    if (this.#voicePreviewSend) {
      this.#voicePreviewSend.disabled = false;
    }
    if (this.#voicePreviewDiscard) {
      this.#voicePreviewDiscard.disabled = false;
    }
    // Keep the reply target out of the way while preview is visible; it will be
    // restored on discard or cleared on successful send.
    if (this.#replyEl) this.#replyEl.hidden = true;
    this.#voicePreviewEl.hidden = false;
  }

  #destroyVoicePreviewBubble(): void {
    if (this.#voicePreviewBubble) {
      this.#voicePreviewBubble.destroy();
      this.#voicePreviewBubble = null;
    }
    if (this.#voicePreviewBubbleHost) {
      this.#voicePreviewBubbleHost.replaceChildren();
    }
  }

  #clearVoicePreview(): void {
    // The player owned the blob: URL; destroy() revokes it. The sentinel
    // just flips the active-presence flag.
    this.#destroyVoicePreviewBubble();
    this.#voicePreviewObjectURL = null;
    this.#voicePreviewBlob = null;
    this.#voicePreviewDuration = 0;
    this.#voicePreviewMime = '';
    this.#voicePreviewFilename = '';
    this.#voicePreviewPeaks = [];

    if (this.#voicePreviewEl) this.#voicePreviewEl.hidden = true;
    if (this.#voicePreviewSend) this.#voicePreviewSend.disabled = false;
    if (this.#voicePreviewDiscard) this.#voicePreviewDiscard.disabled = false;

    if (!this.#destroyed) {
      this.#updateState();
      this.#renderReplyTarget();
    }
  }

  async #sendVoicePreview(): Promise<void> {
    if (
      this.#sending ||
      !this.#voicePreviewObjectURL ||
      !this.#voicePreviewBlob ||
      !this.#client.uploadAttachment ||
      !this.#client.sendAttachmentMessage
    ) {
      return;
    }

    const caption = this.#textarea?.value.trim() ?? '';
    if (caption.length > MAX_BODY_CHARS) return;

    this.#lastText = caption;
    this.#sending = true;
    if (this.#voicePreviewSend) this.#voicePreviewSend.disabled = true;
    if (this.#voicePreviewDiscard) this.#voicePreviewDiscard.disabled = true;
    if (this.#textarea) this.#textarea.disabled = true;
    this.#clearErrorChip();

    try {
      const { attachment } = await this.#client.uploadAttachment(this.#roomId, this.#voicePreviewBlob, {
        mimeType: this.#voicePreviewMime,
        filename: this.#voicePreviewFilename,
      });
      const voiceAttachment = {
        ...attachment,
        durationMs: this.#voicePreviewDuration,
        // Phase 2: peaks on the wire — receiver renders the real waveform.
        // Empty array is omitted (treated as flat fallback on decode).
        ...(this.#voicePreviewPeaks.length > 0 ? { peaks: this.#voicePreviewPeaks } : {}),
      };
      await this.#client.sendAttachmentMessage(this.#roomId, caption, [voiceAttachment]);

      if (!this.#destroyed) {
        if (this.#textarea) this.#textarea.value = '';
        this.#lastText = '';
        this.#productRef = null;
        this.#productMeta = null;
        this.#renderProductCardChip();
        this.#clearReplyTarget();
        this.#clearVoicePreview();
      }
    } catch (err) {
      this.#handleRecordingError(err);
    } finally {
      this.#sending = false;
      if (!this.#destroyed) {
        if (this.#textarea && this.#textarea.disabled) {
          this.#textarea.disabled = false;
        }
        if (this.#voicePreviewSend) this.#voicePreviewSend.disabled = false;
        if (this.#voicePreviewDiscard) this.#voicePreviewDiscard.disabled = false;
        this.#updateState();
      }
    }
  }

  #discardVoicePreview(): void {
    if (!this.#voicePreviewObjectURL) return;
    this.#clearVoicePreview();
  }

  // ── State updates ───────────────────────────────────────────────────────────

  #updateState(): void {
    if (!this.#textarea || !this.#sendBtn || !this.#counter) return;

    const text = this.#textarea.value;
    const len = text.length;
    const trimmed = text.trim();
    const hasStaged = this.#attachmentPicker?.hasStaged() ?? false;

    const overLimit = len > MAX_BODY_CHARS;
    const empty = trimmed.length === 0 && !hasStaged && !this.#hasPendingProductCard();
    this.#sendBtn.disabled = empty || overLimit || this.#sending;
    // Voice preview carries its own Send button; hide the main input-row send button.
    this.#sendBtn.hidden = this.#voicePreviewObjectURL !== null;
    // Issue #98: drive the voice preview Send button disabled-state on over-limit
    // caption too, so the user gets visual feedback instead of a silent no-op on click.
    if (this.#voicePreviewSend) {
      this.#voicePreviewSend.disabled = overLimit || this.#sending;
    }

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
    if (text.length > MAX_BODY_CHARS) return;

    // Voice pre-send preview: the main send path (Ctrl+Enter / Send button when visible)
    // routes to the dedicated preview send, which uses the current textarea text as caption.
    if (this.#voicePreviewObjectURL) {
      return this.#sendVoicePreview();
    }

    if (text.length === 0 && !hasStaged && !this.#hasPendingProductCard()) return;

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
        this.#renderProductCardChip();
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

  // ── Product card chip (#113) ────────────────────────────────────────────────

  /** Render or clear the product-card attached chip based on #productMeta. */
  #renderProductCardChip(): void {
    if (!this.#productCardEl) return;
    if (!this.#productMeta) {
      this.#productCardEl.hidden = true;
      return;
    }
    const label = this.#productCardEl.querySelector('.oxp-composer-product-chip-label');
    if (label) {
      label.textContent = t('productCardAttached', this.#lang, { title: this.#productMeta.title });
    }
    this.#productCardEl.setAttribute(
      'aria-label',
      t('productCardAttached', this.#lang, { title: this.#productMeta.title }),
    );
    this.#productCardEl.hidden = false;
  }
}
