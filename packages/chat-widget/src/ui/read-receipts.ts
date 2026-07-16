/**
 * @oxpulse/chat-widget — Read receipts overlay (#122).
 *
 * Tracks per-user last-read seq and renders checkmarks on own messages.
 * Driven by onReadReceipt SSE events via the SDK subscribe() callback.
 *
 * Zero-third-party-dep — plain DOM, matching the widget's existing pattern.
 *
 * Semantics:
 *   - onReadReceipt({ userId, lastSeq }) → record that `userId` has read
 *     up to `lastSeq`. Multiple users can read the same message.
 *   - A message with seq <= max(lastSeq across all OTHER users) is "read".
 *   - A message with seq <= self's lastReadSeq is "delivered" (server has it).
 *   - Otherwise "sent" (optimistic or in-flight).
 *
 * Display (WhatsApp-style, only on own messages):
 *   - sent:       single checkmark (gray)
 *   - delivered:  double checkmark (gray)
 *   - read:       double checkmark (accent color)
 */

import { t, type Locale } from "../utils/i18n.js";

/** SVG checkmark icons (feather-style, static — no interpolated data). */
const CHECK_SINGLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const CHECK_DOUBLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline><polyline points="24 6 13 17 11 15"></polyline></svg>';

export interface ReadReceiptsOptions {
  /** BCP-47 tag or resolved Locale. */
  lang?: string;
  /** The current user's ID — own read receipts are not counted. */
  selfUid: string;
  /** Optional AbortSignal — destroy() is called automatically on abort. */
  signal?: AbortSignal;
}

/** Internal per-user read state. */
interface UserReadState {
  lastSeq: number;
}

export class ReadReceipts {
  #lang: Locale;
  #selfUid: string;
  #signal: AbortSignal | undefined;
  #destroyed = false;

  /** userId → lastSeq (only OTHER users — self is excluded). */
  readonly #userReads = new Map<string, UserReadState>();
  /** Cached max lastSeq across all other users. */
  #maxReadSeq = 0;
  /** Set of bubble elements registered for receipt updates, keyed by msgId. */
  readonly #bubbles = new Map<string, { el: HTMLElement; seq: number }>();

  constructor(opts: ReadReceiptsOptions) {
    this.#lang = (opts.lang as Locale) ?? "en";
    this.#selfUid = opts.selfUid;
    this.#signal = opts.signal;

    if (this.#signal) {
      this.#signal.addEventListener("abort", () => this.destroy(), { once: true });
    }
  }

  /** Record that a user has read up to lastSeq. Self is ignored. */
  onReadReceipt(userId: string, lastSeq: number): void {
    if (this.#destroyed) return;
    if (userId === this.#selfUid) return;

    const existing = this.#userReads.get(userId);
    // Monotonic — only update if the new seq is higher.
    if (existing && lastSeq <= existing.lastSeq) return;

    this.#userReads.set(userId, { lastSeq });
    if (lastSeq > this.#maxReadSeq) {
      this.#maxReadSeq = lastSeq;
      this.#refreshAll();
    } else {
      // Still need to refresh in case this user's previous seq was the gate.
      this.#refreshAll();
    }
  }

  /** Register a bubble element for receipt updates. Only for own messages. */
  registerBubble(msgId: string, seq: number, el: HTMLElement): void {
    if (this.#destroyed) return;
    this.#bubbles.set(msgId, { el, seq });
    this.#renderReceipt(msgId);
  }

  /** Unregister a bubble (e.g. on eviction). */
  unregisterBubble(msgId: string): void {
    this.#bubbles.delete(msgId);
  }

  /** Get the max read seq across all other users. */
  get maxReadSeq(): number {
    return this.#maxReadSeq;
  }

  /** Clear all read state (e.g. on room switch). */
  clearAll(): void {
    this.#userReads.clear();
    this.#maxReadSeq = 0;
    for (const [msgId] of this.#bubbles) {
      this.#renderReceipt(msgId);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#userReads.clear();
    this.#bubbles.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #refreshAll(): void {
    for (const [msgId] of this.#bubbles) {
      this.#renderReceipt(msgId);
    }
  }

  #renderReceipt(msgId: string): void {
    const entry = this.#bubbles.get(msgId);
    if (!entry) return;

    const { el, seq } = entry;
    // Find or create the receipt element in the bubble footer.
    let receiptEl = el.querySelector(".oxp-read-receipt") as HTMLElement | null;

    const status = this.#computeStatus(seq);

    if (!receiptEl) {
      receiptEl = document.createElement("span");
      receiptEl.className = "oxp-read-receipt";
      // Insert after the timestamp in the footer.
      const footer = el.querySelector(".oxp-bubble-footer");
      const timeEl = el.querySelector(".oxp-bubble-time");
      if (footer && timeEl) {
        timeEl.after(receiptEl);
      } else if (footer) {
        footer.appendChild(receiptEl);
      } else {
        el.appendChild(receiptEl);
      }
    }

    receiptEl.setAttribute("data-status", status);
    receiptEl.innerHTML = status === "sent" ? CHECK_SINGLE : CHECK_DOUBLE;

    const statusText = t(
      status === "read" ? "readReceiptRead" : status === "delivered" ? "readReceiptDelivered" : "readReceiptSent",
      this.#lang,
    );
    receiptEl.setAttribute("aria-label", t("readReceiptAria", this.#lang, { status: statusText }));
  }

  #computeStatus(seq: number): "sent" | "delivered" | "read" {
    if (seq <= this.#maxReadSeq) return "read";
    // "delivered" = the message exists on the server (has a seq).
    // Since we only register bubbles with a valid seq, it's always at least delivered.
    return "delivered";
  }
}
