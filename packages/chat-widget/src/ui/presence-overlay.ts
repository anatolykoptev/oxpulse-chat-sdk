/**
 * @oxpulse/chat-widget — Presence overlay (#121).
 *
 * Tracks per-user presence state (online / lastSeenAt) and renders a
 * presence dot on avatar elements. Driven by onPresence SSE events
 * via the SDK subscribe() callback + initial getPresence() snapshot.
 *
 * Zero-third-party-dep — plain DOM, matching the widget's existing pattern.
 *
 * Lifecycle:
 *   1. On mount: call getPresence() for initial snapshot
 *   2. onPresence({ userId, lastSeenAt }) → update user's lastSeenAt
 *   3. Heartbeat: sendPresence(roomId) every 30s (configurable)
 *   4. destroy() — clears heartbeat interval + presence map
 *
 * Presence freshness: a user is "online" if their lastSeenAt is within
 * FRESHNESS_MS (default 120s — matches server SDK_PRESENCE_FRESHNESS_SECS).
 */

import { t, type Locale } from "../utils/i18n.js";

/** Server freshness window (seconds) — matches DEFAULT_FRESHNESS_SECS in presence.rs. */
const DEFAULT_FRESHNESS_SEC = 120;

/** Heartbeat interval (seconds) — must be < FRESHNESS to stay "online". */
const DEFAULT_HEARTBEAT_SEC = 30;

export interface PresenceOverlayOptions {
  /** BCP-47 tag or resolved Locale. */
  lang?: string;
  /** The current user's ID — own presence is tracked but not shown on own avatar. */
  selfUid: string;
  /** Optional AbortSignal — destroy() is called automatically on abort. */
  signal?: AbortSignal;
  /** Optional: resolve userId → display name (from roster). Falls back to userId. */
  resolveName?: (userId: string) => string | undefined;
  /** Heartbeat interval in seconds (default 30). */
  heartbeatSecs?: number;
  /** Freshness window in seconds (default 120 — matches server). */
  freshnessSecs?: number;
}

/** Internal per-user presence record. */
interface PresenceRecord {
  lastSeenAt: number; // epoch ms
}

export class PresenceOverlay {
  #lang: Locale;
  #selfUid: string;
  #resolveName: (userId: string) => string | undefined;
  #signal: AbortSignal | undefined;
  #heartbeatSecs: number;
  #freshnessSecs: number;

  /** userId → PresenceRecord. */
  readonly #presence = new Map<string, PresenceRecord>();
  /** Set of avatar elements that need dot updates. */
  readonly #avatars = new Map<string, HTMLElement>();
  /** Heartbeat timer handle. */
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Callback to send a presence heartbeat to the server. */
  #sendHeartbeat: (() => void) | null = null;
  #destroyed = false;

  constructor(opts: PresenceOverlayOptions) {
    this.#lang = (opts.lang as Locale) ?? "en";
    this.#selfUid = opts.selfUid;
    this.#resolveName = opts.resolveName ?? ((id: string) => id);
    this.#signal = opts.signal;
    this.#heartbeatSecs = opts.heartbeatSecs ?? DEFAULT_HEARTBEAT_SEC;
    this.#freshnessSecs = opts.freshnessSecs ?? DEFAULT_FRESHNESS_SEC;

    if (this.#signal) {
      this.#signal.addEventListener("abort", () => this.destroy(), { once: true });
    }
  }

  /**
   * Start the heartbeat loop. Calls `sendHeartbeat` immediately, then every
   * `heartbeatSecs`. Fire-and-forget — errors in sendHeartbeat are swallowed.
   */
  startHeartbeat(sendHeartbeat: () => void): void {
    if (this.#destroyed) return;
    this.#sendHeartbeat = sendHeartbeat;
    // Immediate beat so the user appears online right away.
    try { sendHeartbeat(); } catch { /* swallow */ }
    this.#heartbeatTimer = setInterval(() => {
      if (this.#destroyed) return;
      try { this.#sendHeartbeat?.(); } catch { /* swallow */ }
    }, this.#heartbeatSecs * 1000);
  }

  /** Update a user's presence from an SSE event or initial snapshot. */
  updatePresence(userId: string, lastSeenAt: string | number): void {
    if (this.#destroyed) return;
    const ts = typeof lastSeenAt === "number"
      ? lastSeenAt
      : new Date(lastSeenAt).getTime();
    if (isNaN(ts)) return;
    this.#presence.set(userId, { lastSeenAt: ts });
    this.#refreshAvatar(userId);
  }

  /** Bulk-set presence from a getPresence() snapshot. */
  setSnapshot(entries: Array<{ userId: string; lastSeenAt: string }>): void {
    if (this.#destroyed) return;
    for (const e of entries) {
      this.updatePresence(e.userId, e.lastSeenAt);
    }
  }

  /** Register an avatar element for presence dot updates. */
  registerAvatar(userId: string, el: HTMLElement): void {
    if (this.#destroyed) return;
    this.#avatars.set(userId, el);
    this.#refreshAvatar(userId);
  }

  /** Unregister an avatar element (e.g. when a bubble is evicted). */
  unregisterAvatar(userId: string): void {
    const el = this.#avatars.get(userId);
    if (el) this.#removeDot(el);
    this.#avatars.delete(userId);
  }

  /** Check if a user is currently "online" (within freshness window). */
  isOnline(userId: string): boolean {
    const rec = this.#presence.get(userId);
    if (!rec) return false;
    return Date.now() - rec.lastSeenAt < this.#freshnessSecs * 1000;
  }

  /** Get a user's last-seen timestamp (epoch ms), or undefined. */
  getLastSeen(userId: string): number | undefined {
    return this.#presence.get(userId)?.lastSeenAt;
  }

  /** Clear all presence data (e.g. on room switch). */
  clearAll(): void {
    this.#presence.clear();
    for (const [, el] of this.#avatars) {
      this.#removeDot(el);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#sendHeartbeat = null;
    this.#presence.clear();
    for (const [, el] of this.#avatars) {
      this.#removeDot(el);
    }
    this.#avatars.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #refreshAvatar(userId: string): void {
    const el = this.#avatars.get(userId);
    if (!el) return;
    // Don't show presence dot on own avatar.
    if (userId === this.#selfUid) return;

    const online = this.isOnline(userId);
    if (online) {
      this.#addDot(el, "online");
    } else {
      // User is offline — remove the dot (no offline indicator on avatars).
      this.#removeDot(el);
    }
  }

  #addDot(el: HTMLElement, status: "online" | "away"): void {
    let dot = el.querySelector(".oxp-presence-dot") as HTMLElement | null;
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "oxp-presence-dot";
      el.appendChild(dot);
    }
    dot.setAttribute("data-status", status);
    // Update aria-label for screen readers.
    const userId = this.#findUserIdForElement(el);
    if (userId) {
      const name = this.#resolveName(userId) ?? userId;
      if (status === "online") {
        dot.setAttribute("aria-label", t("presenceOnline", this.#lang));
      } else {
        const lastSeen = this.getLastSeen(userId);
        if (lastSeen) {
          const timeStr = this.#formatTime(lastSeen);
          dot.setAttribute(
            "aria-label",
            t("presenceLastSeenAria", this.#lang, { name, time: timeStr }),
          );
        }
      }
    }
  }

  #removeDot(el: HTMLElement): void {
    const dot = el.querySelector(".oxp-presence-dot");
    if (dot) dot.remove();
  }

  #findUserIdForElement(el: HTMLElement): string | undefined {
    for (const [uid, registered] of this.#avatars) {
      if (registered === el) return uid;
    }
    return undefined;
  }

  #formatTime(epochMs: number): string {
    const d = new Date(epochMs);
    try {
      return d.toLocaleTimeString(this.#lang, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }
}
