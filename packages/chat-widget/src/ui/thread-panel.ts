/**
 * @oxpulse/chat-widget — Thread panel (#126).
 *
 * Shows a thread view: root message + reply list + inline composer.
 * Opens as an overlay panel within the widget container.
 *
 * Zero-third-party-dep — plain DOM, matching the widget's existing pattern.
 *
 * Lifecycle:
 *   open(rootMsgId) — fetches thread via getThread(), renders panel
 *   close()         — removes panel from DOM, restores focus
 *
 * The panel calls back to the consumer for:
 *   - sendReply(text) — consumer sends via SDK with threadRootMsgId
 *   - resolveName(uid) — display name lookup from roster
 */

import { t, resolveLocale, type Locale } from "../utils/i18n.js";
import { formatBodyPreview } from "../utils/reply-helpers.js";

/** Minimal row shape needed by the thread panel. */
export interface ThreadRow {
  msgId: string;
  senderUid: string;
  text?: string;
  createdAt: string;
  threadRootMsgId?: string | null;
}

export interface ThreadPanelOptions {
  /** Container element to render the panel inside. */
  container: HTMLElement;
  /** Fetch thread replies from the SDK. */
  getThread: (rootMsgId: string) => Promise<ThreadRow[]>;
  /** Send a reply in the thread. */
  sendReply: (text: string, rootMsgId: string) => Promise<void>;
  /** Resolve userId → display name. */
  resolveName?: (userId: string) => string | undefined;
  /** The current user's ID — for "You" label. */
  selfUid: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** BCP-47 tag or resolved Locale. */
  lang?: string;
  /** Called when the panel closes. */
  onClose?: () => void;
}

export class ThreadPanel {
  #container: HTMLElement;
  #getThread: (rootMsgId: string) => Promise<ThreadRow[]>;
  #sendReply: (text: string, rootMsgId: string) => Promise<void>;
  #resolveName: (userId: string) => string | undefined;
  #selfUid: string;
  #signal: AbortSignal | undefined;
  #lang: Locale;
  #onClose: (() => void) | undefined;

  #panelEl: HTMLElement | null = null;
  #repliesEl: HTMLElement | null = null;
  #inputEl: HTMLTextAreaElement | null = null;
  #sendBtnEl: HTMLButtonElement | null = null;
  #rootMsgId: string | null = null;
  #rootRow: ThreadRow | null = null;
  #keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  #abortListener: (() => void) | null = null;
  #sending = false;

  constructor(opts: ThreadPanelOptions) {
    this.#container = opts.container;
    this.#getThread = opts.getThread;
    this.#sendReply = opts.sendReply;
    this.#resolveName = opts.resolveName ?? ((id: string) => id);
    this.#selfUid = opts.selfUid;
    this.#signal = opts.signal;
    this.#lang = resolveLocale(opts.lang);
    this.#onClose = opts.onClose;
  }

  get isOpen(): boolean {
    return this.#panelEl !== null;
  }

  /** Open the thread panel for the given root message. */
  async open(rootRow: ThreadRow): Promise<void> {
    if (this.#signal?.aborted) return;
    if (this.#panelEl) this.close();

    this.#rootMsgId = rootRow.msgId;
    this.#rootRow = rootRow;

    this.#panelEl = this.#buildPanel(rootRow);
    this.#container.appendChild(this.#panelEl);

    // Escape to close
    this.#keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.#panelEl) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener("keydown", this.#keydownHandler);

    if (this.#signal) {
      this.#abortListener = () => this.close();
      this.#signal.addEventListener("abort", this.#abortListener, { once: true });
    }

    // Fetch thread replies
    await this.#loadReplies();
  }

  /** Close the panel. */
  close(): void {
    if (!this.#panelEl) return;
    if (this.#keydownHandler) {
      document.removeEventListener("keydown", this.#keydownHandler);
      this.#keydownHandler = null;
    }
    if (this.#abortListener && this.#signal) {
      this.#signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = null;
    }
    this.#panelEl?.remove();
    this.#panelEl = null;
    this.#repliesEl = null;
    this.#inputEl = null;
    this.#sendBtnEl = null;
    this.#rootMsgId = null;
    this.#rootRow = null;
    this.#onClose?.();
  }

  /** Add a reply to the panel (called when a new SSE message arrives in this thread). */
  addReply(row: ThreadRow): void {
    if (!this.#repliesEl || !this.#panelEl) return;
    if (row.threadRootMsgId !== this.#rootMsgId) return;
    this.#renderReply(row);
    this.#scrollToBottom();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async #loadReplies(): Promise<void> {
    if (!this.#repliesEl || !this.#rootMsgId) return;

    // Loading state
    const loading = document.createElement("div");
    loading.className = "oxp-thread-loading";
    loading.textContent = t("threadLoading", this.#lang);
    this.#repliesEl.appendChild(loading);

    try {
      const replies = await this.#getThread(this.#rootMsgId);
      if (this.#signal?.aborted || !this.#repliesEl) return;

      this.#repliesEl.replaceChildren();

      if (replies.length === 0) {
        const empty = document.createElement("div");
        empty.className = "oxp-thread-empty";
        empty.textContent = t("threadEmpty", this.#lang);
        this.#repliesEl.appendChild(empty);
      } else {
        for (const row of replies) {
          this.#renderReply(row);
        }
        this.#scrollToBottom();
      }
    } catch {
      if (!this.#repliesEl) return;
      this.#repliesEl.replaceChildren();
      const err = document.createElement("div");
      err.className = "oxp-thread-error";
      err.textContent = t("threadError", this.#lang);
      this.#repliesEl.appendChild(err);
    }
  }

  #renderReply(row: ThreadRow): void {
    if (!this.#repliesEl) return;
    const isSelf = row.senderUid === this.#selfUid;
    const name = isSelf
      ? t("senderYou", this.#lang)
      : (this.#resolveName(row.senderUid) ?? row.senderUid.slice(0, 8));

    const bubble = document.createElement("div");
    bubble.className = "oxp-thread-bubble";
    bubble.setAttribute("data-self", String(isSelf));

    const sender = document.createElement("span");
    sender.className = "oxp-thread-bubble-sender";
    sender.textContent = name;

    const body = document.createElement("span");
    body.className = "oxp-thread-bubble-body";
    body.textContent = formatBodyPreview(row.text ?? "", 500);

    const time = document.createElement("span");
    time.className = "oxp-thread-bubble-time";
    time.textContent = this.#formatTime(row.createdAt);

    bubble.appendChild(sender);
    bubble.appendChild(body);
    bubble.appendChild(time);
    this.#repliesEl.appendChild(bubble);
  }

  #buildPanel(rootRow: ThreadRow): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "oxp-thread-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", t("threadTitle", this.#lang));

    // Header
    const header = document.createElement("div");
    header.className = "oxp-thread-header";

    const title = document.createElement("span");
    title.className = "oxp-thread-title";
    title.textContent = t("threadTitle", this.#lang);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "oxp-thread-close";
    closeBtn.setAttribute("aria-label", t("threadCloseAria", this.#lang));
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Root message preview
    const rootEl = document.createElement("div");
    rootEl.className = "oxp-thread-root";
    const rootName = rootRow.senderUid === this.#selfUid
      ? t("senderYou", this.#lang)
      : (this.#resolveName(rootRow.senderUid) ?? rootRow.senderUid.slice(0, 8));
    const rootSender = document.createElement("span");
    rootSender.className = "oxp-thread-root-sender";
    rootSender.textContent = rootName;
    const rootBody = document.createElement("span");
    rootBody.className = "oxp-thread-root-body";
    rootBody.textContent = formatBodyPreview(rootRow.text ?? "", 280);
    rootEl.appendChild(rootSender);
    rootEl.appendChild(rootBody);
    panel.appendChild(rootEl);

    // Replies container
    const replies = document.createElement("div");
    replies.className = "oxp-thread-replies";
    replies.setAttribute("role", "log");
    this.#repliesEl = replies;
    panel.appendChild(replies);

    // Composer
    const composer = document.createElement("div");
    composer.className = "oxp-thread-composer";

    const input = document.createElement("textarea");
    input.className = "oxp-thread-input";
    input.placeholder = t("threadReplyPlaceholder", this.#lang);
    input.rows = 1;
    input.setAttribute("maxlength", "4096");
    input.addEventListener("input", () => this.#updateSendState());
    this.#inputEl = input;

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "oxp-thread-send";
    sendBtn.textContent = t("threadSendReply", this.#lang);
    sendBtn.disabled = true;
    sendBtn.addEventListener("click", () => this.#onSend());
    this.#sendBtnEl = sendBtn;

    // Enter to send (Shift+Enter for newline)
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) this.#onSend();
      }
    });

    composer.appendChild(input);
    composer.appendChild(sendBtn);
    panel.appendChild(composer);

    return panel;
  }

  async #onSend(): Promise<void> {
    if (this.#sending || !this.#inputEl || !this.#sendBtnEl || !this.#rootMsgId) return;
    const text = this.#inputEl.value.trim();
    if (!text) return;

    this.#sending = true;
    this.#sendBtnEl.disabled = true;
    this.#inputEl.disabled = true;

    try {
      await this.#sendReply(text, this.#rootMsgId);
      if (!this.#inputEl) return;
      this.#inputEl.value = "";
      this.#inputEl.disabled = false;
      this.#inputEl.focus();
    } catch {
      // Restore input on error — let user retry
      if (this.#inputEl) {
        this.#inputEl.disabled = false;
      }
    } finally {
      this.#sending = false;
      this.#updateSendState();
    }
  }

  #updateSendState(): void {
    if (!this.#sendBtnEl || !this.#inputEl) return;
    this.#sendBtnEl.disabled = this.#inputEl.value.trim().length === 0 || this.#sending;
  }

  #scrollToBottom(): void {
    if (this.#repliesEl) {
      this.#repliesEl.scrollTop = this.#repliesEl.scrollHeight;
    }
  }

  #formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(this.#lang, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }
}
