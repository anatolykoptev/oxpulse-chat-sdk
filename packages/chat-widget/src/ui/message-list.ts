/**
 * @oxpulse/chat-widget — MessageList (W2.2 slice 1-3).
 *
 * Renders chat history inside a Shadow DOM container and subscribes to
 * live updates via the SDK client. Uses duck-typed MessageListClient
 * interface to avoid direct SDK imports at the widget package level.
 *
 * Slice 3 additions: reaction cluster rendering, ReactionPicker, live
 * reaction updates via onReaction callback.
 */

import { renderMarkdown } from '../utils/markdown.js';
import type { AttachmentMeta } from '../utils/attachments.js';
import { isSafeAttachmentUrl } from '../utils/attachments.js';
import { shouldAutoScroll, isChained, formatTime, tombstoneText, unsealErrorText, unsealErrorAriaText } from '../utils/list-helpers.js';
import { reactionButtonAriaLabel } from '../utils/reaction-types.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import { ReactionPicker } from './reaction-picker.js';
import { createAvatarElement } from './avatar.js';
import { createRoleBadgeElement, type PrivilegedRole } from './role-badge.js';

// ── Duck-typed SDK interface ──────────────────────────────────────────────────

/** Minimal shape of a MessageRow we need for rendering. */
export interface MessageRow {
  seq: number;
  msgId: string;
  senderUid: string;
  sealed: ArrayBuffer;
  plaintext?: ArrayBuffer;
  /**
   * U2: set by the SDK (chat-sdk MessageRow.unsealError) when unseal() failed
   * for this row — the row is preserved rather than dropped. When set,
   * plaintext is undefined; the render path must show a distinct
   * failed-decrypt placeholder instead of the (empty) normal body.
   */
  unsealError?: 'replay' | 'auth' | 'unknown';
  createdAt: string;
  deletedAt?: string;
  editedAt?: string;
  threadRootMsgId: string | null;
  productRef: string | null;
  productMeta: unknown | null;
  text?: string; // pre-decoded convenience field (used in tests)
  /** W2.2 slice 4: attachment metadata for bubble rendering. */
  attachments?: AttachmentMeta[];
}

/** Minimal shape of a MutationEvent we need for re-rendering. */
export interface MutationEvent {
  msgId: string;
  op: string;
  deletedAt?: string;
  editedAt?: string;
}

/** Live reaction event from subscribe() onReaction callback. */
export interface ReactionEvent {
  msgId: string;
  emoji: string;
  op: 'add' | 'remove';
  userUid: string;
  totalCount: number;
}

/** Reaction data for a single message. */
interface ReactionState {
  /** emoji → total count */
  counts: Record<string, number>;
  /** emoji → array of userUids who reacted */
  users: Record<string, string[]>;
}

/**
 * Roster entry as consumed by the widget — display name plus optional avatar
 * and privileged role. Structural mirror of chat-sdk's `RosterEntry` (the
 * widget stays SDK-import-free; element.ts bridges the concrete SDK type at
 * the seam).
 *
 * `role` is UX-only (P5): a presentation hint for the role badge, never
 * client-side authorization for a privileged operation.
 */
export interface RosterEntry {
  displayName: string;
  avatarUrl: string | null;
  role?: PrivilegedRole;
}

/** Duck-typed subset of SDKChatClient used by MessageList. */
export interface MessageListClient {
  list(roomId: string, args: { limit: number }): Promise<{ items: MessageRow[]; hasNext: boolean }>;
  subscribe(roomId: string, args: {
    onMessage: (row: MessageRow) => void;
    onMutation?: (event: MutationEvent) => void;
    onReaction?: (event: ReactionEvent) => void;
    onRosterSignal?: () => void;
  }): () => void;
  /** Optional — reactions support. If absent, reactions are disabled. */
  getReactions?(roomId: string, msgId: string): Promise<{ counts: Record<string, number>; users: Record<string, string[]>; truncated: boolean }>;
  sendReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
  removeReaction?(roomId: string, msgId: string, emoji: string): Promise<void>;
  /**
   * T18: Fetch roster for the room.
   * Returns a Map<epid, RosterEntry> (display name + optional avatar URL).  Optional — when absent roster is disabled.
   */
  getRoster?(roomId: string): Promise<Map<string, RosterEntry>>;
}

// ── Constructor options ───────────────────────────────────────────────────────

export interface MessageListOptions {
  client: MessageListClient;
  roomId: string;
  container: HTMLElement;
  /**
   * BCP-47 tag or an already-resolved Locale. Optional — defaults via
   * resolveLocale() (lang → navigator.language prefix → 'en') so direct
   * construction (tests, advanced consumers) never has to think about it.
   */
  lang?: string;
  selfUid: string;
  /** Optional AbortSignal to cancel mount mid-flight (C1). */
  signal?: AbortSignal;
  /**
   * Shadow host element to mount the ReactionPicker into (MAJOR-5).
   * When provided, picker.show() mounts into this element instead of #container,
   * escaping the overflow:hidden clip of the widgetRoot.
   */
  shadowHost?: ShadowRoot;
  /**
   * P5: label overrides for the roster role badge (config `roleLabels`), e.g.
   * `{ moderator: "Seller" }`. Presentation only — falls back to the built-in
   * i18n label ("mod" / "owner") for a role with no override.
   */
  roleLabels?: Record<string, string>;
}

// ── MessageList ───────────────────────────────────────────────────────────────

/** Escape a string for safe use as a DOM text node or attribute value. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format attachment size in KB for display. */
function formatSizeKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * CB1: Render a placeholder for attachments with unsafe URLs.
 * Never sets src/href — shows filename only so no code executes.
 */
function renderUnsafePlaceholder(att: AttachmentMeta, container: HTMLElement, lang: Locale): void {
  const el = document.createElement('div');
  el.className = 'oxp-attachment-unsafe';
  // CM1: setAttribute is HTML-attribute context — use escapeHtml to prevent injection via filename.
  // Other sites in this file already escape; this was the missed case (F2 fix).
  el.setAttribute('aria-label', t('attachmentUnavailableAria', lang, { name: escapeHtml(att.filename) }));
  // CM1: textContent is text-safe — assign raw filename (no escaping needed)
  el.textContent = `📎 ${att.filename}`;
  container.appendChild(el);
}

/** Render a single attachment element based on its MIME type. */
function renderAttachment(att: AttachmentMeta, lang: Locale): HTMLElement {
  // CM1: use raw att.filename for DOM property/textContent assignments — these treat
  // the value as text, not HTML. escapeHtml() is only needed for innerHTML/setAttribute.
  const filename = att.filename;
  const isImage = att.mime.startsWith('image/');
  const isAudio = att.mime.startsWith('audio/');

  if (isImage) {
    const wrap = document.createElement('div');
    wrap.className = 'oxp-attachment-image';

    // CB1: reject non-safe URL schemes before setting img.src
    if (!isSafeAttachmentUrl(att.url)) {
      renderUnsafePlaceholder(att, wrap, lang);
      return wrap;
    }

    const img = document.createElement('img');
    img.src = att.url;
    // CM1: alt is a DOM property — text-safe, no escaping needed
    img.alt = filename;
    img.setAttribute('loading', 'lazy');
    // CM1: setAttribute for aria-label (HTML attribute context) — use escapeHtml for safety
    img.setAttribute(
      'aria-label',
      t('imageAria', lang, { name: escapeHtml(filename), size: formatSizeKb(att.sizeBytes) }),
    );
    // DM4: set width/height when available to prevent CLS.
    // F4 fix: only set minHeight when dimensions are unknown — otherwise the explicit
    // dimensions already reserve space and an 80px minHeight creates a grey bar overshoot
    // for small thumbnails (e.g. 40×30px icon).
    if (att.width && att.height) {
      img.width = att.width;
      img.height = att.height;
      // No minHeight — actual dimensions reserve space without grey bar
    } else {
      img.style.minHeight = '80px';
      img.style.background = 'var(--oxp-border)';
    }
    // click-to-open in new tab (lightbox deferred to future slice)
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => {
      // CB1: URL already validated above — safe to use
      window.open(att.url, '_blank', 'noopener,noreferrer');
    });
    wrap.appendChild(img);
    return wrap;
  }

  if (isAudio) {
    const wrap = document.createElement('div');
    wrap.className = 'oxp-attachment-audio';

    // CB1: reject non-safe URL schemes before setting audio.src
    if (!isSafeAttachmentUrl(att.url)) {
      renderUnsafePlaceholder(att, wrap, lang);
      return wrap;
    }

    const audio = document.createElement('audio');
    audio.src = att.url;
    audio.controls = true;
    audio.preload = 'metadata';
    // CM1: setAttribute for aria-label — use escapeHtml
    audio.setAttribute(
      'aria-label',
      t('audioAria', lang, { name: escapeHtml(filename), size: formatSizeKb(att.sizeBytes) }),
    );
    wrap.appendChild(audio);
    return wrap;
  }

  // Generic file download link
  const wrap = document.createElement('div');
  wrap.className = 'oxp-attachment-file-wrap';

  // CB1: reject non-safe URL schemes before setting link.href
  if (!isSafeAttachmentUrl(att.url)) {
    renderUnsafePlaceholder(att, wrap, lang);
    return wrap;
  }

  const link = document.createElement('a');
  link.className = 'oxp-attachment-file';
  link.href = att.url;
  // CM1: download is a DOM property — text-safe, no escaping needed
  link.download = filename;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // CM1: setAttribute for aria-label — use escapeHtml
  link.setAttribute(
    'aria-label',
    t('fileAria', lang, { name: escapeHtml(filename), size: formatSizeKb(att.sizeBytes) }),
  );
  // CM1: textContent is text-safe — assign raw filename (no escapeHtml)
  link.textContent = `${filename} (${formatSizeKb(att.sizeBytes)})`;
  wrap.appendChild(link);
  return wrap;
}

/** Decode plaintext bytes to a readable string, falling back to empty. */
function decodeText(row: MessageRow): string {
  // test convenience field
  if (row.text !== undefined) return row.text;
  if (row.plaintext) {
    try {
      return new TextDecoder().decode(row.plaintext);
    } catch {
      return '';
    }
  }
  return '';
}

/** Format a MessageRow timestamp (ISO string) as HH:MM. */
function rowTime(row: MessageRow): number {
  return new Date(row.createdAt).getTime();
}

/**
 * MessageList renders a chat message history inside a given container element.
 * It fetches initial history via client.list() and subscribes to live updates.
 *
 * Slice 3: adds reaction cluster per bubble, ReactionPicker, live onReaction.
 */
export class MessageList {
  #client: MessageListClient;
  #roomId: string;
  #container: HTMLElement;
  #selfUid: string;
  /** i18n: resolved once at construction (see resolveLocale()) — every
   *  hardcoded string this class renders goes through t(key, this.#lang). */
  #lang: Locale;
  #signal: AbortSignal;
  #abortController!: AbortController;
  #unsubscribe: (() => void) | null = null;
  /** Live store of all rendered rows — keyed by msgId for O(1) mutation lookup. */
  #rows: Map<string, MessageRow> = new Map();
  /** Ordered msgIds for sequence-stable rendering. */
  #order: string[] = [];
  /** Inner scrollable list element. */
  #listEl: HTMLElement | null = null;
  /** Reaction state per message — keyed by msgId. */
  #reactions: Map<string, ReactionState> = new Map();
  /** Active ReactionPicker instance (at most one visible at a time). */
  #picker: ReactionPicker | null = null;
  /** M6: Per-chip in-flight tracking. Keys are `${msgId}:${emoji}`. */
  #inflight: Set<string> = new Set();
  /** MAJOR-5: Shadow host for picker mount — escapes overflow:hidden widgetRoot. */
  #shadowHost?: ShadowRoot;
  /** W2.2 slice 5: highest seq value seen — used for resume token on reconnect. */
  #lastSeq = 0;
  /**
   * T18: Roster cache — epid → display_name.
   * Populated on mount via getRoster() and refreshed on `type:"roster"` SSE signal.
   * Debounce timer: coalesces rapid SSE roster signals (avoid N concurrent fetches).
   */
  #roster: Map<string, RosterEntry> = new Map();
  #rosterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** P5: role-badge label overrides from widget config `roleLabels`. */
  #roleLabels: Record<string, string> | undefined;

  constructor(opts: MessageListOptions) {
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#container = opts.container;
    this.#selfUid = opts.selfUid;
    this.#lang = resolveLocale(opts.lang);
    this.#shadowHost = opts.shadowHost;
    this.#roleLabels = opts.roleLabels;
    // C1: use an internal AbortController so destroy() aborts mid-flight awaits.
    // Combine with caller-supplied signal if provided.
    const internal = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => internal.abort(), { once: true });
    }
    this.#signal = internal.signal;
    this.#abortController = internal;
  }

  /**
   * Fetch initial history and subscribe to live updates.
   * Resolves after initial render is complete.
   */
  async mount(): Promise<void> {
    // Create the scrollable list container
    this.#listEl = document.createElement('div');
    this.#listEl.setAttribute('role', 'log');
    this.#listEl.setAttribute('aria-live', 'polite');
    this.#listEl.className = 'oxp-message-list';
    this.#container.appendChild(this.#listEl);

    // DM2: shared fetch-render-subscribe logic (also used by #retryMount).
    await this.#fetchAndRender();
  }

  /**
   * W2.2 slice 5: Returns the highest seq value seen from all received messages.
   * Used as a resume token when reconnecting (lastSeq param to subscribe()).
   */
  getLastSeq(): number {
    return this.#lastSeq;
  }

  /**
   * Route a new message row to the list's internal handler.
   * Used by the element's reconnect SubscribeFn to deliver messages when
   * the Reconnector re-establishes the SSE stream after an error.
   */
  handleMessage(row: MessageRow): void {
    this.#handleNewMessage(row);
  }

  /** Tear down: abort in-flight mount(), unsubscribe, clear DOM, close picker. */
  destroy(): void {
    // C1: abort first so mid-flight mount() bails before subscribe
    this.#abortController.abort();
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
    this.#picker?.hide();
    this.#picker = null;
    this.#rows.clear();
    this.#order = [];
    this.#reactions.clear();
    this.#inflight.clear();
    this.#roster.clear();
    if (this.#rosterDebounceTimer !== null) {
      clearTimeout(this.#rosterDebounceTimer);
      this.#rosterDebounceTimer = null;
    }
    if (this.#listEl && this.#listEl.parentNode) {
      this.#listEl.parentNode.removeChild(this.#listEl);
    }
    this.#listEl = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * T18: Fetch (or re-fetch) the roster and store in #roster.
   * Re-renders all visible bubbles to update sender names.
   * Called on mount and on SSE `type:"roster"` signal.
   */
  async #fetchRoster(): Promise<void> {
    if (!this.#client.getRoster) return;
    try {
      const map = await this.#client.getRoster(this.#roomId);
      if (this.#signal.aborted) return;
      this.#roster = map;
      // Re-render all bubbles so sender names update immediately.
      this.#renderAll();
    } catch (err) {
      // Non-critical: roster miss → fallback rendering still works.
      console.warn('[MessageList] fetchRoster failed:', err);
    }
  }

  /**
   * T18: Debounced roster refresh triggered by SSE `type:"roster"` signals.
   * Coalesces rapid bursts (e.g. N writers joining within 100ms) into one fetch.
   */
  #scheduleRosterRefresh(): void {
    if (this.#rosterDebounceTimer !== null) {
      clearTimeout(this.#rosterDebounceTimer);
    }
    this.#rosterDebounceTimer = setTimeout(() => {
      this.#rosterDebounceTimer = null;
      if (!this.#signal.aborted) {
        void this.#fetchRoster();
      }
    }, 100);
  }

  /** Batch-fetch reactions for all currently visible messages. */
  async #fetchAllReactions(): Promise<void> {
    if (!this.#client.getReactions) return;
    const getReactions = this.#client.getReactions.bind(this.#client);
    const fetches = this.#order.map(async (msgId) => {
      try {
        const data = await getReactions(this.#roomId, msgId);
        if (this.#signal.aborted) return;
        this.#reactions.set(msgId, { counts: data.counts, users: data.users });
        this.#updateReactionCluster(msgId);
      } catch {
        // Per CLAUDE.md: write-failures must log or bump metric; read failures here are non-critical
        // but we still note them to avoid silent suppression.
        console.warn(`[MessageList] Failed to fetch reactions for ${msgId}`);
      }
    });
    await Promise.all(fetches);
  }

  #handleNewMessage(row: MessageRow): void {
    // W2.2 slice 5: track highest seq for resume token
    if (row.seq > this.#lastSeq) this.#lastSeq = row.seq;

    // C2: deduplicate replayed messages by msgId (upsert path)
    if (this.#rows.has(row.msgId)) {
      this.#rows.set(row.msgId, row);
      const idx = this.#order.indexOf(row.msgId);
      if (idx !== -1 && this.#listEl) {
        const bubbles = this.#listEl.querySelectorAll('[role="article"]');
        const el = bubbles[idx] as HTMLElement | undefined;
        if (el) this.#updateBubble(el, row, idx);
      }
      return;
    }

    const wasPinned = this.#isPinnedToBottom();

    this.#rows.set(row.msgId, row);
    this.#order.push(row.msgId);
    this.#appendBubble(row, this.#order.length - 1);

    // Fetch reactions for the new message if supported
    if (this.#client.getReactions) {
      void this.#client.getReactions(this.#roomId, row.msgId).then((data) => {
        if (this.#signal.aborted) return;
        this.#reactions.set(row.msgId, { counts: data.counts, users: data.users });
        this.#updateReactionCluster(row.msgId);
      }).catch(() => {});
    }

    if (wasPinned) this.#scrollToBottom();
  }

  #handleMutation(event: MutationEvent): void {
    const existing = this.#rows.get(event.msgId);
    if (!existing) return;

    // Apply mutation to stored row
    const updated: MessageRow = { ...existing };
    if (event.op === 'delete' && event.deletedAt) {
      updated.deletedAt = event.deletedAt;
    } else if (event.op === 'edit' && event.editedAt) {
      updated.editedAt = event.editedAt;
    }
    this.#rows.set(event.msgId, updated);

    // Re-render affected bubble in-place
    const idx = this.#order.indexOf(event.msgId);
    if (idx === -1 || !this.#listEl) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const el = bubbles[idx] as HTMLElement | undefined;
    if (!el) return;
    this.#updateBubble(el, updated, idx);
  }

  /** Handle live reaction event from subscribe onReaction callback. */
  #handleReaction(event: ReactionEvent): void {
    const existing = this.#reactions.get(event.msgId) ?? { counts: {}, users: {} };
    const counts = { ...existing.counts };
    const users = { ...existing.users };

    if (event.op === 'add') {
      counts[event.emoji] = event.totalCount;
      const emojiUsers = users[event.emoji] ? [...users[event.emoji]!] : [];
      if (!emojiUsers.includes(event.userUid)) {
        emojiUsers.push(event.userUid);
      }
      users[event.emoji] = emojiUsers;
    } else {
      // remove
      counts[event.emoji] = event.totalCount;
      if (event.totalCount <= 0) {
        delete counts[event.emoji];
        delete users[event.emoji];
      } else {
        users[event.emoji] = (users[event.emoji] ?? []).filter((u) => u !== event.userUid);
      }
    }

    this.#reactions.set(event.msgId, { counts, users });
    this.#updateReactionCluster(event.msgId);
  }

  /** Update the reaction cluster element for a specific message. */
  #updateReactionCluster(msgId: string): void {
    if (!this.#listEl) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const idx = this.#order.indexOf(msgId);
    if (idx === -1) return;
    const bubble = bubbles[idx] as HTMLElement | undefined;
    if (!bubble) return;

    const state = this.#reactions.get(msgId);
    let clusterEl = bubble.querySelector('.oxp-bubble-reactions') as HTMLElement | null;

    // Build list of [emoji, count] pairs with count > 0
    const activeReactions = state
      ? Object.entries(state.counts).filter(([, c]) => c > 0)
      : [];

    if (activeReactions.length === 0) {
      // Remove cluster if exists
      if (clusterEl) clusterEl.remove();
      return;
    }

    // Create cluster if missing
    if (!clusterEl) {
      clusterEl = document.createElement('div');
      clusterEl.className = 'oxp-bubble-reactions';
      clusterEl.setAttribute('role', 'group');
      clusterEl.setAttribute('aria-label', t('reactionsGroupAria', this.#lang));
      // Insert before footer element (which contains time + reaction-add button)
      const footerEl = bubble.querySelector('.oxp-bubble-footer');
      if (footerEl) {
        bubble.insertBefore(clusterEl, footerEl);
      } else {
        bubble.appendChild(clusterEl);
      }
    }

    // M7 / Code MAJOR-1: Diff-patch chips — mutate existing nodes in-place rather
    // than wiping innerHTML. This preserves focus when a live reaction update fires
    // while the user has a chip focused (innerHTML wipe → focus lost to body).
    const activeMap = new Map(activeReactions.map(([emoji, count]) => [emoji, count]));
    const existingChips = new Map<string, HTMLButtonElement>();
    for (const chip of Array.from(clusterEl.querySelectorAll<HTMLButtonElement>('.oxp-reaction-chip'))) {
      const emoji = chip.getAttribute('data-emoji');
      if (emoji) existingChips.set(emoji, chip);
    }

    // Remove chips for emojis no longer active
    for (const [emoji, chip] of existingChips) {
      if (!activeMap.has(emoji)) {
        clusterEl.removeChild(chip);
        existingChips.delete(emoji);
      }
    }

    // Mutate or append chips
    for (const [emoji, count] of activeReactions) {
      const emojiUsers = state?.users[emoji] ?? [];
      const isOwn = emojiUsers.includes(this.#selfUid);
      const existing = existingChips.get(emoji);
      if (existing) {
        // Mutate in-place — preserves focus
        existing.textContent = `${emoji} ${count}`;
        existing.setAttribute('data-own', String(isOwn));
        existing.setAttribute('aria-pressed', String(isOwn));
        existing.setAttribute(
          'aria-label',
          reactionButtonAriaLabel(emoji, count, isOwn, this.#lang),
        );
      } else {
        const chip = this.#buildReactionChip(msgId, emoji, count, isOwn);
        clusterEl.appendChild(chip);
      }
    }
  }

  #buildReactionChip(msgId: string, emoji: string, count: number, isOwn: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'oxp-reaction-chip';
    btn.setAttribute('data-emoji', emoji);
    btn.setAttribute('data-own', String(isOwn));
    btn.setAttribute('aria-pressed', String(isOwn));
    btn.setAttribute('aria-label', reactionButtonAriaLabel(emoji, count, isOwn, this.#lang));
    btn.type = 'button';
    btn.textContent = `${emoji} ${count}`;

    btn.addEventListener('click', () => {
      if (isOwn) {
        // Optimistic decrement
        void this.#optimisticRemoveReaction(msgId, emoji);
      } else {
        // Optimistic increment
        void this.#optimisticAddReaction(msgId, emoji);
      }
    });

    return btn;
  }

  async #optimisticAddReaction(msgId: string, emoji: string): Promise<void> {
    if (!this.#client.sendReaction) return;
    // M6: De-duplicate rapid double-tap — ignore if in-flight for this (msgId, emoji)
    const inflightKey = `${msgId}:${emoji}`;
    if (this.#inflight.has(inflightKey)) return;
    this.#inflight.add(inflightKey);

    // Code MAJOR-3: snapshot pre-mutation state for wholesale rollback
    const preSnapshot: ReactionState = {
      counts: { ...(this.#reactions.get(msgId) ?? { counts: {}, users: {} }).counts },
      users: Object.fromEntries(
        Object.entries((this.#reactions.get(msgId) ?? { counts: {}, users: {} }).users)
          .map(([k, v]) => [k, [...v]]),
      ),
    };

    // Optimistic update
    const state = this.#reactions.get(msgId) ?? { counts: {}, users: {} };
    const newCount = (state.counts[emoji] ?? 0) + 1;
    const newUsers = [...(state.users[emoji] ?? []), this.#selfUid];
    this.#reactions.set(msgId, {
      counts: { ...state.counts, [emoji]: newCount },
      users: { ...state.users, [emoji]: newUsers },
    });
    this.#updateReactionCluster(msgId);

    try {
      await this.#client.sendReaction(this.#roomId, msgId, emoji);
    } catch (err) {
      // Code MAJOR-3: Rollback to pre-mutation snapshot (not post-mutation state)
      console.warn(`[MessageList] sendReaction failed: ${String(err)}`);
      this.#reactions.set(msgId, preSnapshot);
      this.#updateReactionCluster(msgId);
    } finally {
      this.#inflight.delete(inflightKey);
    }
  }

  async #optimisticRemoveReaction(msgId: string, emoji: string): Promise<void> {
    if (!this.#client.removeReaction) return;
    // M6: De-duplicate rapid double-tap
    const inflightKey = `${msgId}:${emoji}`;
    if (this.#inflight.has(inflightKey)) return;
    this.#inflight.add(inflightKey);

    // Code MAJOR-3: snapshot pre-mutation state for wholesale rollback
    const preSnapshot: ReactionState = {
      counts: { ...(this.#reactions.get(msgId) ?? { counts: {}, users: {} }).counts },
      users: Object.fromEntries(
        Object.entries((this.#reactions.get(msgId) ?? { counts: {}, users: {} }).users)
          .map(([k, v]) => [k, [...v]]),
      ),
    };

    // Optimistic update
    const state = this.#reactions.get(msgId) ?? { counts: {}, users: {} };
    const newCount = Math.max(0, (state.counts[emoji] ?? 0) - 1);
    const newCounts = { ...state.counts };
    if (newCount <= 0) {
      delete newCounts[emoji];
    } else {
      newCounts[emoji] = newCount;
    }
    const newUsers = (state.users[emoji] ?? []).filter((u) => u !== this.#selfUid);
    const newUsersMap = { ...state.users };
    if (newCount <= 0) {
      delete newUsersMap[emoji];
    } else {
      newUsersMap[emoji] = newUsers;
    }
    this.#reactions.set(msgId, { counts: newCounts, users: newUsersMap });
    this.#updateReactionCluster(msgId);

    try {
      await this.#client.removeReaction(this.#roomId, msgId, emoji);
    } catch (err) {
      console.warn(`[MessageList] removeReaction failed: ${String(err)}`);
      // Code MAJOR-3: Rollback to pre-mutation snapshot
      this.#reactions.set(msgId, preSnapshot);
      this.#updateReactionCluster(msgId);
    } finally {
      this.#inflight.delete(inflightKey);
    }
  }

  /** Render all rows from scratch into #listEl. */
  #renderAll(): void {
    if (!this.#listEl) return;
    this.#listEl.innerHTML = '';
    for (let i = 0; i < this.#order.length; i++) {
      const msgId = this.#order[i];
      if (!msgId) continue;
      const row = this.#rows.get(msgId);
      if (!row) continue;
      this.#appendBubble(row, i);
    }
  }

  /** Append a single bubble to #listEl. */
  #appendBubble(row: MessageRow, idx: number): void {
    if (!this.#listEl) return;
    const el = this.#createBubble(row, idx);
    this.#listEl.appendChild(el);
  }

  /** Build a bubble element for a row. */
  #createBubble(row: MessageRow, idx: number): HTMLElement {
    const isSelf = row.senderUid === this.#selfUid;

    // Determine chaining
    const prevMsgId = idx > 0 ? this.#order[idx - 1] : undefined;
    const prevRow = prevMsgId ? this.#rows.get(prevMsgId) : undefined;
    const chained = prevRow ? isChained(
      { from: prevRow.senderUid, ts: rowTime(prevRow) },
      { from: row.senderUid, ts: rowTime(row) },
    ) : false;

    const el = document.createElement('div');
    el.setAttribute('role', 'article');
    el.className = 'oxp-bubble';
    el.setAttribute('data-self', String(isSelf));
    el.setAttribute('data-msg-id', row.msgId);
    if (chained) el.setAttribute('data-chained', 'true');

    this.#populateBubble(el, row, chained);

    // T18-avatar: wrap the bubble in a row so the sender's avatar can lead it.
    // Shown for OTHER writers only (own messages read "You" and, WhatsApp-style,
    // carry no self-avatar). Bubbles are still located by [role="article"], so
    // the wrapper does not disturb update/reaction lookups.
    const rowEl = document.createElement('div');
    rowEl.className = 'oxp-row';
    rowEl.setAttribute('data-self', String(isSelf));
    if (chained) rowEl.setAttribute('data-chained', 'true');
    if (!isSelf) {
      const entry = this.#roster.get(row.senderUid);
      rowEl.appendChild(
        createAvatarElement({
          name: entry?.displayName ?? row.senderUid.slice(0, 8),
          avatarUrl: entry?.avatarUrl ?? null,
          seed: row.senderUid,
        }),
      );
    }
    rowEl.appendChild(el);
    return rowEl;
  }

  /**
   * B4: Compute the bubble's aria-label for screen readers.
   * review-fix HIGH#1: this is the SOLE aria-label computation — called from
   * #populateBubble, which both #createBubble (initial render) AND
   * #updateBubble (every live re-render: mutation SSE, dedupe/reclassify
   * upsert) run through. Previously this lived only in #createBubble, so a
   * message redelivered with a new unsealError/deletedAt after its first
   * render kept announcing its ORIGINAL content — a live a11y + confidentiality
   * -adjacent gap (a screen reader would speak stale plaintext of a message
   * later flagged as tampered/replayed).
   */
  #ariaLabelFor(row: MessageRow): string {
    const isSelf = row.senderUid === this.#selfUid;
    // T18: use roster name for other writers; "You" for self.
    // escapeHtml on roster name in case it contains special chars in the attribute context.
    const rosterName = isSelf ? t('senderYou', this.#lang) : (this.#roster.get(row.senderUid)?.displayName ?? row.senderUid.slice(0, 8));
    const senderLabel = escapeHtml(rosterName);
    const timeText = formatTime(rowTime(row));
    // U2: announce the tombstone / failed-decrypt placeholder text instead of
    // an empty body (plaintext is undefined in both cases, so decodeText()
    // would otherwise yield '' and the bubble would read as empty to a screen
    // reader). Priority MUST mirror #populateBubble's body-render order exactly
    // (deletedAt wins over unsealError) — divergent priority here would announce
    // a different state than what's visually shown for a row carrying both flags.
    // U2 review-fix: aria uses the glyph-free variant (unsealErrorAriaText) —
    // see its doc comment for why the lock emoji is dropped from speech.
    const plainBody = row.deletedAt
      ? tombstoneText('everyone', this.#lang)
      : row.unsealError
        ? unsealErrorAriaText(this.#lang)
        : decodeText(row).replace(/\n/g, ' ').slice(0, 200);
    return t('bubbleAriaLabel', this.#lang, { sender: senderLabel, time: timeText, body: plainBody });
  }

  /** Populate or update the interior of a bubble element. */
  #populateBubble(el: HTMLElement, row: MessageRow, chained: boolean): void {
    const isSelf = row.senderUid === this.#selfUid;

    // review-fix HIGH#1: recompute aria-label every call so it stays in sync
    // on live updates (#updateBubble), not just the initial #createBubble render.
    el.setAttribute('aria-label', this.#ariaLabelFor(row));

    // Preserve existing reaction cluster if present (reactions are managed separately)
    const existingCluster = el.querySelector('.oxp-bubble-reactions');

    el.innerHTML = '';

    // Sender label (hidden when chained via CSS).
    // T18: resolve name from roster for OTHER writers (not selfUid).
    // XSS-safe: always textContent, never innerHTML (SEC-CR-003 / FF3).
    const senderEl = document.createElement('div');
    senderEl.className = 'oxp-bubble-sender';
    // P5: sender label + optional role badge live in a row wrapper so
    // senderEl's own textContent stays name-only (existing callers/tests read
    // `.oxp-bubble-sender`'s textContent as the display name — a badge
    // appended as a *child* of senderEl would leak into that string).
    const senderRow = document.createElement('div');
    senderRow.className = 'oxp-bubble-sender-row';
    if (isSelf) {
      // Own messages: show "You" or selfUid short-form — not from attacker-controlled roster.
      senderEl.textContent = t('senderYou', this.#lang);
    } else {
      // Other writers: resolve from roster map; miss → epid short-form (first 8 chars).
      const entry = this.#roster.get(row.senderUid);
      // SEC-CR-003: textContent assignment is XSS-safe — no innerHTML or attribute sink.
      senderEl.textContent = entry?.displayName ?? row.senderUid.slice(0, 8);
      // P5: role badge — mirrors the avatar's "OTHER writers only" convention
      // (own messages read "You" and carry no roster-derived decoration).
      // entry?.role is undefined for a plain member or an unrecognised wire
      // value (chat-sdk fails closed at parse time) — no badge in either case.
      if (entry?.role === 'moderator' || entry?.role === 'owner') {
        senderRow.appendChild(
          createRoleBadgeElement({ role: entry.role, lang: this.#lang, roleLabels: this.#roleLabels }),
        );
      }
    }
    senderRow.prepend(senderEl);
    el.appendChild(senderRow);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'oxp-bubble-body';

    if (row.deletedAt) {
      const tombEl = document.createElement('span');
      tombEl.className = 'oxp-tombstone';
      tombEl.textContent = tombstoneText('everyone', this.#lang);
      bodyEl.appendChild(tombEl);
    } else if (row.unsealError) {
      // U2: preserved-but-undecryptable row (SDK sets unsealError instead of
      // dropping it — see chat-sdk client.ts classifyUnsealError). Render a
      // distinct placeholder so the user never sees raw/empty ciphertext
      // content mistaken for a real message.
      const unsealEl = document.createElement('span');
      unsealEl.className = 'oxp-unseal-error';
      unsealEl.textContent = unsealErrorText(this.#lang);
      bodyEl.appendChild(unsealEl);
    } else {
      const text = decodeText(row);
      bodyEl.innerHTML = renderMarkdown(text);
    }
    el.appendChild(bodyEl);

    // W2.2 slice 4: Render attachment bubbles.
    // review-fix LOW#1: gate on !deletedAt && !unsealError — unreachable today
    // (no code path sets row.attachments alongside either flag) but closes the
    // same latent fall-through deletedAt already had: without this guard, a
    // future wiring of attachment metadata onto a tombstoned or failed-decrypt
    // row would render attachment links next to the placeholder text.
    if (!row.deletedAt && !row.unsealError && row.attachments && row.attachments.length > 0) {
      const attachmentsEl = document.createElement('div');
      attachmentsEl.className = 'oxp-bubble-attachments';
      for (const att of row.attachments) {
        attachmentsEl.appendChild(renderAttachment(att, this.#lang));
      }
      el.appendChild(attachmentsEl);
    }

    // Restore reaction cluster if it existed
    if (existingCluster) {
      el.appendChild(existingCluster);
    }

    // Reaction add button + timestamp row
    const footerEl = document.createElement('div');
    footerEl.className = 'oxp-bubble-footer';

    const reactionBtn = document.createElement('button');
    reactionBtn.className = 'oxp-reaction-add-btn';
    reactionBtn.type = 'button';
    reactionBtn.setAttribute('aria-label', t('addReactionAria', this.#lang));
    reactionBtn.textContent = '+😀';
    reactionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#showPicker(row.msgId, reactionBtn);
    });
    footerEl.appendChild(reactionBtn);

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'oxp-bubble-time';
    timeEl.textContent = formatTime(rowTime(row));
    footerEl.appendChild(timeEl);

    el.appendChild(footerEl);
  }

  /** Show the reaction picker for a specific message. */
  #showPicker(msgId: string, anchorEl: HTMLElement): void {
    // Close any existing picker first
    if (this.#picker) {
      this.#picker.hide();
      this.#picker = null;
    }

    // M5: Append picker to the outer container (not #listEl which has overflow:auto).
    // This prevents the picker from being clipped near scroll edges.
    // Picker position is computed relative to the outer container via getBoundingClientRect.
    const container = this.#container;
    this.#picker = new ReactionPicker({
      container,
      onSelect: (emoji) => {
        this.#picker = null;
        void this.#optimisticAddReaction(msgId, emoji);
      },
      signal: this.#signal,
      lang: this.#lang,
    });
    // MAJOR-5: mount picker into shadow host (ShadowRoot) to escape overflow:hidden widgetRoot.
    // ShadowRoot is not HTMLElement but supports appendChild; cast is safe at runtime.
    const mountTo = this.#shadowHost ? (this.#shadowHost as unknown as HTMLElement) : undefined;
    this.#picker.show(anchorEl, mountTo);

    // M5: Close picker on scroll — acceptable UX when picker is outside scroll container
    const onScroll = (): void => {
      if (this.#picker) {
        this.#picker.hide();
        this.#picker = null;
      }
      this.#listEl?.removeEventListener('scroll', onScroll);
    };
    this.#listEl?.addEventListener('scroll', onScroll, { once: true });
  }

  /** Re-render the interior of an existing bubble element in-place. */
  #updateBubble(el: HTMLElement, row: MessageRow, idx: number): void {
    const prevMsgId = idx > 0 ? this.#order[idx - 1] : undefined;
    const prevRow = prevMsgId ? this.#rows.get(prevMsgId) : undefined;
    const chained = prevRow ? isChained(
      { from: prevRow.senderUid, ts: rowTime(prevRow) },
      { from: row.senderUid, ts: rowTime(row) },
    ) : false;
    if (chained) el.setAttribute('data-chained', 'true');
    else el.removeAttribute('data-chained');
    this.#populateBubble(el, row, chained);
    // Re-render reaction cluster after bubble update
    this.#updateReactionCluster(row.msgId);
  }

  #scrollToBottom(): void {
    // C3: scroll on #listEl (the inner scrollable), not the outer container
    if (!this.#listEl) return;
    this.#listEl.scrollTop = this.#listEl.scrollHeight;
  }

  #isPinnedToBottom(): boolean {
    // C3: read from #listEl, not #container
    const el = this.#listEl ?? this.#container;
    return shouldAutoScroll({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }

  /** 1D: Render inline error state inside #listEl with a retry button. */
  #renderListError(message: string): void {
    if (!this.#listEl) return;
    // Clear anything already in listEl
    this.#listEl.innerHTML = '';

    const errorEl = document.createElement('div');
    errorEl.className = 'oxp-message-list-error';
    errorEl.setAttribute('role', 'alert');

    const msgEl = document.createElement('span');
    msgEl.textContent = message;
    errorEl.appendChild(msgEl);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = t('retry', this.#lang);
    // DM1 (design MAJOR): aria-label disambiguates from any other "Retry" in multi-context.
    retryBtn.setAttribute('aria-label', t('retryLoadingMessagesAria', this.#lang));
    retryBtn.addEventListener('click', () => {
      if (this.#listEl) this.#listEl.innerHTML = '';
      void this.#retryMount();
    });
    errorEl.appendChild(retryBtn);

    this.#listEl.appendChild(errorEl);
  }

  /** 1D: Re-attempt fetch + subscribe after a list() failure.
   * DM2 (design MAJOR): resets fetch-accumulated state (`#rows`/`#order`/`#lastSeq`/`#reactions`/
   * `#unsubscribe`) before re-fetch — `#inflight`/`#picker` unreachable on the retry path
   * (no reactions fetched, no picker opened before a mount-time list() failure). */
  async #retryMount(): Promise<void> {
    if (!this.#listEl || this.#signal.aborted) return;

    // DM2: reset all accumulated state so the retry starts clean — mirrors destroy() teardown
    // without removing the DOM list element (which was already cleared by the caller).
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#rows.clear();
    this.#order = [];
    this.#lastSeq = 0;
    this.#reactions.clear();

    await this.#fetchAndRender();
  }

  /** Shared fetch-subscribe-render logic used by mount() and #retryMount(). */
  async #fetchAndRender(): Promise<void> {
    if (!this.#listEl || this.#signal.aborted) return;

    let result: { items: MessageRow[]; hasNext: boolean };
    try {
      result = await this.#client.list(this.#roomId, { limit: 50 });
    } catch (err) {
      this.#renderListError(err instanceof Error ? err.message : String(err));
      this.#dispatchError(`Failed to load messages: ${String(err)}`);
      return;
    }

    if (this.#signal.aborted) return;

    const sorted = [...result.items].sort((a, b) => a.seq - b.seq);
    for (const row of sorted) {
      this.#rows.set(row.msgId, row);
      this.#order.push(row.msgId);
      if (row.seq > this.#lastSeq) this.#lastSeq = row.seq;
    }

    this.#renderAll();
    this.#scrollToBottom();

    this.#unsubscribe = this.#client.subscribe(this.#roomId, {
      onMessage: (row) => this.#handleNewMessage(row),
      onMutation: (event) => this.#handleMutation(event),
      onReaction: (event) => this.#handleReaction(event),
      // T18: roster SSE invalidation signal — re-fetch roster on debounce.
      onRosterSignal: () => this.#scheduleRosterRefresh(),
    });

    if (this.#client.getReactions && this.#order.length > 0) {
      void this.#fetchAllReactions();
    }

    // T18: fetch roster on mount so initial history has names immediately.
    if (this.#client.getRoster) {
      void this.#fetchRoster();
    }
  }

  #dispatchError(message: string): void {
    this.#container.dispatchEvent(
      new CustomEvent('oxpulse-chat:error', {
        bubbles: true,
        composed: true,
        detail: { message },
      }),
    );
  }
}
