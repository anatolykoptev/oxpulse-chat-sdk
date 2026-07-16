/**
 * @oxpulse/chat-widget — Typing indicator (#120).
 *
 * Renders an animated "X is typing…" footer in the message list.
 * Driven by onTyping SSE events via the SDK subscribe() callback.
 *
 * Zero-third-party-dep — plain DOM + CSS animation, matching the
 * widget's existing pattern (avatar.ts, role-badge.ts, etc.).
 *
 * Lifecycle:
 *   1. onTyping({ userId, ttlSecs }) → addTyping(userId, ttlSecs)
 *   2. A per-user timer auto-removes the user after ttlSecs (server TTL fallback)
 *   3. removeTyping(userId) — explicit clear (on send / on typing:stop)
 *   4. destroy() — clears all timers + removes the DOM element
 *
 * Display rules (industry-standard, from Stream/ravex):
 *   - 1 user:  "Alice is typing…"
 *   - 2 users: "Alice and Bob are typing…"
 *   - 3+ users: "Alice, Bob and 3 others are typing…"
 *   - Self typing is never shown (filtered by selfUid)
 */

import { t, type Locale } from "../utils/i18n.js";

export interface TypingIndicatorOptions {
  /** Container element to mount the indicator into. */
  container: HTMLElement;
  /** BCP-47 tag or resolved Locale. */
  lang?: string;
  /** The current user's ID — own typing is never displayed. */
  selfUid: string;
  /** Optional AbortSignal — destroy() is called automatically on abort. */
  signal?: AbortSignal;
  /** Optional: resolve userId → display name (from roster). Falls back to userId. */
  resolveName?: (userId: string) => string | undefined;
}

/** Default TTL if the server doesn't provide one (matches server default of 5s). */
const DEFAULT_TTL_MS = 5000;

export class TypingIndicator {
  readonly #container: HTMLElement;
  #lang: Locale;
  #selfUid: string;
  #resolveName: (userId: string) => string | undefined;
  #signal: AbortSignal | undefined;

  /** userId → timer handle for auto-clear. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ordered set of typing user IDs. */
  readonly #typingUsers = new Set<string>();

  #root: HTMLElement | null = null;
  #dotsEl: HTMLElement | null = null;
  #textEl: HTMLElement | null = null;
  #destroyed = false;

  constructor(opts: TypingIndicatorOptions) {
    this.#container = opts.container;
    this.#lang = opts.lang as Locale ?? "en";
    this.#selfUid = opts.selfUid;
    this.#resolveName = opts.resolveName ?? ((id: string) => id);
    this.#signal = opts.signal;

    // Mount immediately (hidden) so there is no layout shift when typing starts.
    this.#ensureMounted();
    this.#render();

    if (this.#signal) {
      this.#signal.addEventListener("abort", () => this.destroy(), { once: true });
    }
  }

  /**
   * Mark a user as typing. Resets their auto-clear timer.
   * Self-typing is ignored (never show own indicator).
   */
  addTyping(userId: string, ttlSecs?: number): void {
    if (this.#destroyed) return;
    if (userId === this.#selfUid) return;

    // Clear any existing timer for this user.
    const existing = this.#timers.get(userId);
    if (existing) clearTimeout(existing);

    this.#typingUsers.add(userId);

    // Set auto-clear timer (server TTL is advisory; client enforces as fallback).
    const ttlMs = ttlSecs ? ttlSecs * 1000 : DEFAULT_TTL_MS;
    const timer = setTimeout(() => {
      this.#timers.delete(userId);
      this.#typingUsers.delete(userId);
      this.#render();
    }, ttlMs);
    this.#timers.set(userId, timer);

    this.#render();
  }

  /** Remove a user from the typing set. */
  removeTyping(userId: string): void {
    if (this.#destroyed) return;
    const timer = this.#timers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(userId);
    }
    this.#typingUsers.delete(userId);
    this.#render();
  }

  /** Clear all typing users (e.g. on room switch). */
  clearAll(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#typingUsers.clear();
    this.#render();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#typingUsers.clear();
    this.#root?.remove();
    this.#root = null;
    this.#dotsEl = null;
    this.#textEl = null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  #ensureMounted(): void {
    if (this.#root) return;
    this.#root = document.createElement("div");
    this.#root.className = "oxp-typing-indicator";
    this.#root.setAttribute("aria-live", "polite");
    this.#root.style.display = "none";

    this.#dotsEl = document.createElement("span");
    this.#dotsEl.className = "oxp-typing-dots";
    this.#dotsEl.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "oxp-typing-dot";
      this.#dotsEl.appendChild(dot);
    }

    this.#textEl = document.createElement("span");
    this.#textEl.className = "oxp-typing-text";

    this.#root.appendChild(this.#dotsEl);
    this.#root.appendChild(this.#textEl);
    this.#container.appendChild(this.#root);
  }

  #render(): void {
    if (this.#destroyed) return;
    this.#ensureMounted();
    if (!this.#root || !this.#textEl) return;

    const users = [...this.#typingUsers];
    if (users.length === 0) {
      this.#root.style.display = "none";
      this.#root.removeAttribute("aria-label");
      return;
    }

    this.#root.style.display = "flex";

    const names = users.map((id) => this.#resolveName(id) ?? id);
    const user1 = names[0] ?? "";
    const user2 = names[1] ?? "";
    let text: string;
    let ariaText: string;

    if (users.length === 1) {
      text = t("typingOneUser", this.#lang, { user: user1 });
    } else if (users.length === 2) {
      text = t("typingTwoUsers", this.#lang, { user1, user2 });
    } else {
      text = t("typingMultiple", this.#lang, {
        user1,
        user2,
        n: users.length - 2,
      });
    }
    ariaText = t("typingAriaLabel", this.#lang, { names: names.join(", ") });

    this.#textEl.textContent = text;
    this.#root.setAttribute("aria-label", ariaText);
  }
}
