/**
 * @oxpulse/chat-widget — MessageList (W2.2 slice 1-3).
 *
 * Renders chat history inside a Shadow DOM container and subscribes to
 * live updates via the SDK client. Uses duck-typed MessageListClient
 * interface to avoid direct SDK imports at the widget package level.
 *
 * Slice 3 additions: reaction cluster rendering, ReactionQuickBar (renamed
 * from ReactionPicker, heart-first amendment 2026-07-14), live reaction
 * updates via onReaction callback.
 */

import { renderMarkdown } from '../utils/markdown.js';
import type { AttachmentMeta } from '../utils/attachments.js';
import { isSafeAttachmentUrl, replyBodySnapshotForMessage } from '../utils/attachments.js';
import { shouldAutoScroll, isChained, formatTime, formatDuration, tombstoneText, unsealErrorText, unsealErrorAriaText, isSelf as isSelfMatch, cssEscape } from '../utils/list-helpers.js';
import { reactionButtonAriaLabel, HEART_EMOJI } from '../utils/reaction-types.js';
import { t, resolveLocale, type Locale } from '../utils/i18n.js';
import { formatBodyPreview, type ReplySnapshot } from '../utils/reply-helpers.js';
import { ReactionQuickBar } from './reaction-quick-bar.js';
import { ReactionTrigger } from './reaction-trigger.js';
import { createAvatarElement } from './avatar.js';
import { createRoleBadgeElement, type PrivilegedRole } from './role-badge.js';
import { createVoiceBubble, type VoiceBubble } from './voice-bubble.js';
import { TypingIndicator } from './typing-indicator.js';
import { PinnedBanner, type PinnedEntry } from './pinned-banner.js';
import { PresenceOverlay } from './presence-overlay.js';
import { ReadReceipts } from './read-receipts.js';
import { ThreadPanel, type ThreadRow } from './thread-panel.js';
import { BackoffStrategy } from './reconnect.js';
import type { ProductMeta, WriteFailureOp, WriteFailureReason } from '../types.js';
import { classifyWriteFailureReason } from '../utils/auth.js';

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
  productMeta: ProductMeta | null;
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
  /** Present on op="pin" — the user who pinned the message. */
  pinnedBy?: string;
}

/** Live reaction event from subscribe() onReaction callback. */
export interface ReactionEvent {
  msgId: string;
  emoji: string;
  op: 'add' | 'remove';
  userUid: string;
  /** Exact post-mutation total count, when provided by the server/event.
   *  If omitted or zero, MessageList re-fetches getReactions for the source of truth. */
  totalCount?: number;
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
    onTyping?: (event: { userId: string; ttlSecs?: number }) => void;
    onPresence?: (event: { userId: string; lastSeenAt: string }) => void;
    onReadReceipt?: (event: { userId: string; lastSeq: number }) => void;
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
  /** #121: fetch presence snapshot. */
  getPresence?(roomId: string): Promise<Array<{ userId: string; lastSeenAt: string }>>;
  /** #121: send presence heartbeat. Fire-and-forget. */
  sendPresence?(roomId: string): Promise<void>;
  /** #122: mark messages up to seq as read. */
  markRead?(roomId: string, seq: number): Promise<void>;
  /** #126: fetch thread replies. */
  getThread?(roomId: string, rootMsgId: string): Promise<ThreadRow[]>;
  /** #126: send a text message (used for thread replies). */
  sendText?(roomId: string, args: { senderUid: string; text: string; threadRootMsgId?: string }): Promise<void>;
  /** #228: list pinned messages in a room (ordered by pinned_at desc). */
  listPins?(roomId: string): Promise<PinnedEntry[]>;
  /** #228: pin a message. Idempotent. */
  pinMessage?(roomId: string, msgId: string): Promise<void>;
  /** #228: unpin a message. No-op if not pinned. */
  unpinMessage?(roomId: string, msgId: string): Promise<void>;
  /**
   * issue #67: fetch an attachment blob WITH authentication. The attachment
   * GET route is JWT-authenticated (Authorization: Bearer only — no signed
   * query-token the way the PUT upload URL has), so a bare `<img src>` 401s
   * for every viewer. Optional — when absent, renderAttachment() falls back
   * to a direct `img.src = att.url` assignment (existing behavior, used by
   * tests and any environment without an authenticated fetch bridge).
   */
  fetchAttachmentBlob?(url: string, signal?: AbortSignal): Promise<Blob>;
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
   * Shadow host element to mount the ReactionQuickBar into (MAJOR-5).
   * When provided, the bar's show() mounts into this element instead of #container,
   * escaping the overflow:hidden clip of the widgetRoot.
   */
  shadowHost?: ShadowRoot;
  /**
   * P5: label overrides for the roster role badge (config `roleLabels`), e.g.
   * `{ moderator: "Seller" }`. Presentation only — falls back to the built-in
   * i18n label ("mod" / "owner") for a role with no override.
   */
  roleLabels?: Record<string, string>;
  /**
   * W7: Fires when the user clicks the reply button on a bubble.
   * Provides a snapshot the consumer can feed to Composer.setReplyTarget().
   */
  onSetReply?: (snapshot: ReplySnapshot) => void;

  /** Whether reaction UI is enabled. Default: true. */
  reactionsEnabled?: boolean;

  /** Whether pinned-messages banner is enabled. Default: true. */
  pinnedMessagesEnabled?: boolean;

  /**
   * Write-401 fix (issue #78): fires when a reaction write op
   * (sendReaction/removeReaction) fails with an auth error — routes
   * through the SAME token-expired signal the subscribe path uses
   * (element.ts's shared notifier), wired by the caller rather than
   * re-implemented here.
   */
  onAuthExpired?: () => void;
  /**
   * Write-401 fix (issue #78): failure-counter hook — fires on EVERY
   * reaction write failure (auth, network, or other), not just 401s, so an
   * integrator can count silent write failures.
   */
  onWriteFailure?: (op: WriteFailureOp, reason: WriteFailureReason, message: string) => void;
  /**
   * Review finding #4: fires when an attachment's authenticated hydration
   * reaches FINAL failure (after retries exhaust, or immediately for a
   * permanent HTTP status 403/404/410) — once per attachment per final
   * failure, NOT per retry. The host element (element.ts) wires this to
   * dispatch `oxpulse-chat:attachment-error` from the widget host element so
   * an integrator can surface/telemetry a dead attachment.
   */
  onAttachmentError?: (msgId: string, attachmentId: string) => void;
  /**
   * Observability: fires when a row carrying an `unsealError` (chat-sdk's
   * classifyUnsealError reason 'replay' | 'auth' | 'unknown') is rendered —
   * a replay-attack signature and a benign timeout are otherwise
   * indistinguishable to the host. Deduped once per msgId per widget lifetime
   * (a re-render via #updateBubble does not re-fire). The host element
   * (element.ts) wires this to dispatch `oxpulse-chat:decrypt-error` from the
   * widget host element so an integrator can telemetry/alert on decrypt
   * failures by class — the replay reason is the one that matters most on an
   * untrusted server.
   */
  onDecryptError?: (msgId: string, seq: number, reason: 'replay' | 'auth' | 'unknown') => void;
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

/**
 * issue #67: attach the media src, authenticated when the client can (hydrate
 * present) — the GET /api/sdk/attachments/{id} route is JWT-authenticated
 * (Authorization: Bearer only, no signed query-token), so a bare `img.src =
 * att.url` 401s for every viewer once this is wired against the real server.
 * Falls back to the direct URL when no hydrate bridge is wired (existing
 * behavior — test mocks / any environment without MessageListClient.fetchAttachmentBlob).
 * trackObjectUrl lets the caller revoke the created blob: URL on teardown.
 */
// Issue #91: retry with backoff on transient authed-fetch failures (429/401/network).
// Up to 3 retries. Delays come from the shared BackoffStrategy (reconnect.ts) — the
// same class the widget's Reconnector uses — replacing a hardcoded [500,1000,2000]
// array. On final failure, set a data attribute so CSS can show a placeholder
// instead of a bare broken-image icon, and notify the host via onHydrateFailed.
const HYDRATE_MAX_RETRIES = 3;
const HYDRATE_BACKOFF = new BackoffStrategy();

/**
 * Review finding #2: typed error carrying the HTTP status from the authed
 * attachment fetch, so the retry loop can distinguish permanent (403/404/410 —
 * the attachment is gone/forbidden) from transient (429/401/network) failures
 * and skip pointless retries. Thrown by the host element's fetchAttachmentBlob
 * bridge (element.ts); the retry loop inspects it via isPermanentHydrateError().
 */
export class AttachmentFetchError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `attachment fetch failed: HTTP ${status}`);
    this.name = 'AttachmentFetchError';
    this.status = status;
  }
}

/** Permanent HTTP statuses — retrying won't help (the resource is gone/forbidden). */
const PERMANENT_HYDRATE_STATUSES = new Set([403, 404, 410]);

/** True when `err` carries a permanent HTTP status (AttachmentFetchError or any
 *  duck-typed error with a numeric `status` property in the permanent set). */
function isPermanentHydrateError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return PERMANENT_HYDRATE_STATUSES.has(status);
  }
  return false;
}

function hydrateMediaSrc(
  el: HTMLImageElement | HTMLAudioElement,
  att: AttachmentMeta,
  hydrate: ((url: string, signal?: AbortSignal) => Promise<Blob>) | undefined,
  trackObjectUrl: ((url: string) => void) | undefined,
  signal: AbortSignal | undefined,
  msgId: string,
  onHydrateFailed?: (msgId: string, attachmentId: string) => void,
): void {
  if (!hydrate) {
    el.src = att.url;
    return;
  }

  // attemptNum: 0 = initial call (immediate), 1..N = scheduled retries.
  // BackoffStrategy.delayMs(n) gives the delay BEFORE the n-th attempt.
  const attempt = (retriesLeft: number, attemptNum: number): void => {
    hydrate(att.url, signal)
      .then((blob) => {
        if (signal?.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        trackObjectUrl?.(objectUrl);
        el.src = objectUrl;
        el.removeAttribute('data-hydrate-failed');
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        // Issue #91: retry on transient failures (429/401/network), but not on
        // aborts or permanent errors (404/403/410 — the attachment is gone/forbidden).
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (isAbort) return;

        const permanent = isPermanentHydrateError(err);
        if (!permanent && retriesLeft > 0) {
          const backoff = HYDRATE_BACKOFF.delayMs(attemptNum + 1);
          setTimeout(() => attempt(retriesLeft - 1, attemptNum + 1), backoff);
        } else {
          // Final failure — mark for CSS placeholder + fall back to direct URL
          // (may work for non-authed endpoints; worst case shows broken-image
          // but with a data attribute for styling). Notify the host once per
          // attachment per final failure (not per retry) so an integrator can
          // surface/telemetry the dead attachment.
          el.setAttribute('data-hydrate-failed', 'true');
          el.src = att.url;
          onHydrateFailed?.(msgId, att.id);
        }
      });
  };

  attempt(HYDRATE_MAX_RETRIES, 0);
}

function isImageAttachment(att: AttachmentMeta): boolean {
  return att.mime.startsWith('image/');
}

function allImageAttachments(attachments: AttachmentMeta[]): boolean {
  return attachments.length > 0 && attachments.every(isImageAttachment);
}

/**
 * Review fix (MEDIUM, PR #88): shared authenticated + safe image builder for
 * both the single-attachment path (renderAttachment) and the collage path
 * (renderAttachmentCollage) — these used to duplicate the isSafeAttachmentUrl
 * guard + hydrateMediaSrc call + alt/loading/aria-label + click->window.open
 * wiring independently. Sizing stays caller-specific (each context's own
 * theme.ts class selector — `.oxp-attachment-image img` vs
 * `.oxp-attachment-collage-tile img` — already scopes width/height/object-fit,
 * so callers only need to set layout concerns the CSS class can't express,
 * e.g. the single-image path's CLS-reservation width/height attributes).
 * Returns null when the URL fails the safety guard; the caller renders its
 * own unsafe-placeholder into its own wrapper element.
 */
function buildAttachmentImg(
  att: AttachmentMeta,
  lang: Locale,
  hydrate?: (url: string, signal?: AbortSignal) => Promise<Blob>,
  trackObjectUrl?: (url: string) => void,
  signal?: AbortSignal,
  msgId?: string,
  onHydrateFailed?: (msgId: string, attachmentId: string) => void,
): HTMLImageElement | null {
  if (!isSafeAttachmentUrl(att.url)) return null;

  const img = document.createElement('img');
  hydrateMediaSrc(img, att, hydrate, trackObjectUrl, signal, msgId ?? '', onHydrateFailed);
  // CM1: alt is a DOM property — text-safe, no escaping needed
  img.alt = att.filename;
  img.setAttribute('loading', 'lazy');
  // CM1: setAttribute for aria-label (HTML attribute context) — use escapeHtml
  img.setAttribute(
    'aria-label',
    t('imageAria', lang, { name: escapeHtml(att.filename), size: formatSizeKb(att.sizeBytes) }),
  );
  img.style.cursor = 'pointer';
  img.addEventListener('click', () => {
    // Issue #84: window.open can't attach auth headers — use authed fetch + blob.
    // When no hydrate bridge is wired, fall back to direct window.open (test envs).
    if (!hydrate) {
      window.open(att.url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Review finding #3: thread the SAME AbortSignal hydrateMediaSrc uses and
    // guard signal.aborted before trackObjectUrl/window.open — a click resolving
    // AFTER destroy() would otherwise push a fresh blob: URL into the already-
    // swept #attachmentObjectUrls map (never revoked) and open a stale tab.
    hydrate(att.url, signal).then((blob) => {
      if (signal?.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      trackObjectUrl?.(objectUrl);
      window.open(objectUrl, '_blank', 'noopener,noreferrer');
    }).catch(() => {
      if (signal?.aborted) return;
      // Fallback to direct URL (may 401, but better than silent no-op)
      window.open(att.url, '_blank', 'noopener,noreferrer');
    });
  });
  return img;
}

/**
 * Render a grid of image attachments as a collage.
 * Triggered when a message has >1 image attachment.
 * Layouts: N=2 (1x1 side-by-side), N=3 (2x1 hero + two 1x1 tiles),
 * N=4 (2x2 3:2), N>=5 (2x2 3:2, fourth tile blurred with a +{N-3} overlay).
 */
function renderAttachmentCollage(
  attachments: AttachmentMeta[],
  lang: Locale,
  hydrate?: (url: string, signal?: AbortSignal) => Promise<Blob>,
  trackObjectUrl?: (url: string) => void,
  signal?: AbortSignal,
  msgId?: string,
  onHydrateFailed?: (msgId: string, attachmentId: string) => void,
): HTMLElement {
  const count = attachments.length;
  const grid = document.createElement('div');
  grid.className = 'oxp-attachment-collage';
  grid.style.display = 'grid';
  grid.style.gap = '4px';
  grid.style.overflow = 'hidden';
  grid.style.maxWidth = 'min(100%, 550px)';
  grid.style.maxHeight = '400px';

  if (count === 3) {
    grid.style.gridTemplateColumns = '2fr 1fr';
  } else {
    grid.style.gridTemplateColumns = '1fr 1fr';
  }

  const tileCount = Math.min(count, 4);
  for (let i = 0; i < tileCount; i++) {
    const att = attachments[i];
    if (!att) break;
    const tile = document.createElement('div');
    tile.className = 'oxp-attachment-collage-tile';

    if (count === 3 && i === 0) {
      // Hero tile spans both rows; no explicit aspect-ratio so it fills the grid.
      tile.style.gridRow = '1 / 3';
    } else {
      // Review fix (HIGH, PR #88): ratio comes from a CSS class + the
      // @media(max-width:640px) rule in theme.ts, not a one-time JS
      // matchMedia() snapshot baked into an inline style at row-build time —
      // every other responsive rule in this file is a plain CSS media query,
      // and an inline value can't react to the widget iframe/container being
      // resized across the breakpoint after this row already rendered.
      tile.classList.add(
        count === 2 || count === 3
          ? 'oxp-attachment-collage-tile--square'
          : 'oxp-attachment-collage-tile--wide',
      );
    }

    const img = buildAttachmentImg(att, lang, hydrate, trackObjectUrl, signal, msgId, onHydrateFailed);
    if (!img) {
      renderUnsafePlaceholder(att, tile, lang);
      grid.appendChild(tile);
      continue;
    }

    if (count >= 5 && i === 3) {
      img.style.filter = 'blur(4px)';
    }

    tile.appendChild(img);

    if (count >= 5 && i === 3) {
      const overlay = document.createElement('div');
      overlay.className = 'oxp-attachment-collage-overlay';
      overlay.textContent = `+${count - 3}`;
      tile.appendChild(overlay);
    }

    grid.appendChild(tile);
  }

  return grid;
}

/** Render a single attachment element based on its MIME type. */
function renderAttachment(
  att: AttachmentMeta,
  lang: Locale,
  hydrate?: (url: string, signal?: AbortSignal) => Promise<Blob>,
  trackObjectUrl?: (url: string) => void,
  signal?: AbortSignal,
  trackVoiceBubble?: (bubble: VoiceBubble) => void,
  msgId?: string,
  onHydrateFailed?: (msgId: string, attachmentId: string) => void,
): HTMLElement {
  // CM1: use raw att.filename for DOM property/textContent assignments — these treat
  // the value as text, not HTML. escapeHtml() is only needed for innerHTML/setAttribute.
  const filename = att.filename;
  const isImage = att.mime.startsWith('image/');
  const isAudio = att.mime.startsWith('audio/');

  if (isImage) {
    const wrap = document.createElement('div');
    wrap.className = 'oxp-attachment-image';

    const img = buildAttachmentImg(att, lang, hydrate, trackObjectUrl, signal, msgId, onHydrateFailed);
    if (!img) {
      renderUnsafePlaceholder(att, wrap, lang);
      return wrap;
    }

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
    wrap.appendChild(img);
    return wrap;
  }

  if (isAudio) {
    const wrap = document.createElement('div');
    wrap.className = 'oxp-attachment-audio';

    // CB1: reject non-safe URL schemes before the player sources audio
    if (!isSafeAttachmentUrl(att.url)) {
      renderUnsafePlaceholder(att, wrap, lang);
      return wrap;
    }

    // Phase 2: VoiceBubble render shell over the headless player + static
    // waveform. Replaces the bare <audio controls>. The player's source is
    // the authed blob loader (hydrate) — NEVER a raw attachment URL on the
    // authed path. The shell owns the <audio> element (ADR-3); a hidden
    // <audio> remains in the DOM for the controller to read/write.
    const bubble = createVoiceBubble({
      att,
      hydrate,
      trackObjectUrl,
      signal,
      lang,
    });
    trackVoiceBubble?.(bubble);
    wrap.appendChild(bubble.el);
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
  // Issue #84: keep href as att.url for non-authed environments (test mocks,
  // non-JWT endpoints). When hydrate is wired, the click is intercepted and
  // the authed fetch + blob download replaces the default navigation.
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
  // Issue #84: intercept click for authed download
  link.addEventListener('click', (ev: MouseEvent) => {
    ev.preventDefault();
    // When no hydrate bridge is wired, fall back to direct URL (test envs)
    if (!hydrate) {
      window.open(att.url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Review finding #3: thread the AbortSignal + guard signal.aborted before
    // trackObjectUrl/the synthetic download click — a click resolving AFTER
    // destroy() would push a fresh blob: URL into the already-swept
    // #attachmentObjectUrls map (never revoked) and trigger a stale download.
    hydrate(att.url, signal).then((blob) => {
      if (signal?.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      trackObjectUrl?.(objectUrl);
      const tmpLink = document.createElement('a');
      tmpLink.href = objectUrl;
      tmpLink.download = filename;
      document.body.appendChild(tmpLink);
      tmpLink.click();
      document.body.removeChild(tmpLink);
    }).catch(() => {
      if (signal?.aborted) return;
      // Fallback to direct URL (may 401, but better than silent no-op)
      window.open(att.url, '_blank', 'noopener,noreferrer');
    });
  });
  wrap.appendChild(link);
  return wrap;
}

const PRODUCT_TITLE_MAX = 200;
const PRODUCT_PRICE_MAX = 40;
const PRODUCT_CURRENCY_MAX = 16;
const PRODUCT_URL_MAX = 2048;

/**
 * W9 hardening: validate + cap server-supplied `product_meta` before render.
 * `product_meta` is unsealed opaque JSON any room peer can POST (the SDK types
 * it `ProductMeta` but the wire is `unknown`), so a partial, non-object, or
 * oversized value must degrade to "no card" — never render "undefined" or a
 * multi-MB title (layout DoS-lite; body text is char-capped, product_meta is
 * not). Returns a safe ProductMeta, or null when the always-shown display
 * fields are unusable (→ the card is skipped, the message still renders).
 */
function normalizeProductMeta(raw: unknown): ProductMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  // Core display fields (title + price + currency are always shown) must be
  // non-empty strings, else there's no sensible card to draw.
  if (typeof m.title !== 'string' || m.title.length === 0) return null;
  if (typeof m.price !== 'string' || m.price.length === 0) return null;
  if (typeof m.currency !== 'string' || m.currency.length === 0) return null;
  // URLs are optional; a non-string or over-cap value degrades to '' so the
  // isSafeAttachmentUrl gate in renderProduct simply omits the image/link.
  const cappedUrl = (v: unknown): string =>
    typeof v === 'string' && v.length <= PRODUCT_URL_MAX ? v : '';
  return {
    title: m.title.slice(0, PRODUCT_TITLE_MAX),
    price: m.price.slice(0, PRODUCT_PRICE_MAX),
    currency: m.currency.slice(0, PRODUCT_CURRENCY_MAX),
    imageUrl: cappedUrl(m.imageUrl),
    productUrl: cappedUrl(m.productUrl),
  };
}

/** W9: Render a marketplace product card as a clickable preview. */
function renderProduct(meta: ProductMeta, lang: Locale): HTMLElement {
  const safeImage = isSafeAttachmentUrl(meta.imageUrl);
  const safeUrl = isSafeAttachmentUrl(meta.productUrl);

  const card = document.createElement('div');
  card.className = 'oxp-bubble-product';

  if (safeImage) {
    const img = document.createElement('img');
    img.className = 'oxp-product-image';
    img.src = meta.imageUrl;
    img.alt = meta.title;
    img.setAttribute('loading', 'lazy');
    // Passive-leak guard: imageUrl is peer-controlled (unsealed product_meta),
    // so don't leak the viewer's page URL as a referrer on image load.
    img.referrerPolicy = 'no-referrer';
    card.appendChild(img);
  }

  const title = document.createElement('div');
  title.className = 'oxp-product-title';
  title.textContent = meta.title;
  card.appendChild(title);

  const price = document.createElement('div');
  price.className = 'oxp-product-price';
  price.textContent = `${meta.price} ${meta.currency}`;
  card.appendChild(price);

  if (safeUrl) {
    const link = document.createElement('a');
    link.className = 'oxp-product-link';
    link.href = meta.productUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('productViewAria', lang, { title: meta.title });
    card.appendChild(link);
  }

  return card;
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
 * Safety cap on the live-streamed message window (production-blocking audit
 * gap): #order/#rows/DOM bubbles grew unboundedly as live messages streamed
 * in, with no eviction anywhere. A busy central room (thousands of msgs/day)
 * plus a long-open tab accumulates unbounded memory. This bounds the LIVE
 * window only — full scroll-back virtualization is a separate future feature
 * once "load older" pagination UI exists (list()'s hasNext is already
 * returned but unused today).
 */
export const MAX_LIVE_MESSAGES = 300;

/**
 * Hard ceiling that evicts even while the user is scrolled up reading
 * history (unpinned). Without this, a visitor who scrolls up once in a busy
 * central room and never returns to bottom accumulates #order/#rows/DOM
 * without limit for as long as the tab stays open — the soft
 * MAX_LIVE_MESSAGES cap above only trims on a PINNED append, so it never
 * fires for that session. Set well above MAX_LIVE_MESSAGES so an actively
 * reading user gets a large buffer before anything is yanked out from under
 * them; only a visitor who has let 600+ messages pile up while scrolled away
 * pays the cost of a jump, which is strictly better than unbounded growth.
 */
export const MAX_LIVE_MESSAGES_HARD_CEILING = MAX_LIVE_MESSAGES * 2;

/** Heart-add pulse duration (reuse-update 2026-07-14) — ported verbatim from
 *  oxpulse-chat web's Bubble.svelte `.qa-heart.on.pulse { animation:
 *  heart-pulse 240ms ... }` / MessageList.svelte's triggerHeartPulse timer. */
export const HEART_PULSE_MS = 240;

/**
 * Write-401 fix (issue #78): how long an optimistic reaction stays visually
 * applied after an auth-expired write failure before rolling back.
 *
 * Rationale: a 401 here means the host's JWT expired. The widget signals
 * onAuthExpired (same token-expired flow the subscribe path uses)
 * immediately, but the actual refresh+retry happens by the HOST swapping
 * the jwt attribute — which re-bootstraps the element and tears this
 * MessageList instance down, repainting from server state. There is no
 * useful in-place retry to build here: either the remount wins the race
 * (the delayed rollback below never runs, the timer is cleared in
 * destroy()) or it doesn't, in which case the delayed rollback still fires
 * so the UI does not lie about pending state forever. A short bounded
 * delay + signal is the whole feature — deliberately not a retry queue.
 */
export const WRITE_AUTH_ROLLBACK_DELAY_MS = 3000;

/**
 * MessageList renders a chat message history inside a given container element.
 * It fetches initial history via client.list() and subscribes to live updates.
 *
 * Slice 3: adds reaction cluster per bubble, ReactionQuickBar, live onReaction.
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
  /** #120: typing indicator instance — mounted below #listEl. */
  #typingIndicator: TypingIndicator | null = null;
  /** #228: pinned-messages banner — mounted above #listEl. */
  #pinnedBanner: PinnedBanner | null = null;
  /** #228: whether pinned-messages UI is enabled. */
  #pinnedMessagesEnabled = true;
  /** #121: presence overlay — tracks online users + renders avatar dots. */
  #presenceOverlay: PresenceOverlay | null = null;
  /** #122: read receipts — checkmarks on own messages. */
  #readReceipts: ReadReceipts | null = null;
  /** #126: thread panel — shows thread replies in a side panel. */
  #threadPanel: ThreadPanel | null = null;
  /**
   * P2 design-empirical review 2026-07-14: re-pins scroll to bottom when
   * #listEl's own clientHeight shrinks (the composer — a sibling in the
   * widgetRoot flex column — grows when the reply-preview bar toggles on).
   * Observing #listEl itself (not the composer) is the clean seam: no
   * cross-component coupling, and it fires for ANY future cause of the same
   * shrink, not just the reply bar. jsdom has no ResizeObserver — guarded by
   * a feature check in mount() so the widget's test suite stays green.
   */
  #resizeObserver: ResizeObserver | null = null;
  /** Reaction state per message — keyed by msgId. */
  #reactions: Map<string, ReactionState> = new Map();
  /** Whether reaction UI is enabled. */
  #reactionsEnabled = true;
  /** Active ReactionQuickBar instance (at most one visible at a time). */
  #quickBar: ReactionQuickBar | null = null;
  /** msgId the currently-shown #quickBar belongs to — #showQuickBar reads
   *  this to no-op a redundant show for the message that already owns the
   *  bar (e.g. a stacked ArrowUp/hold firing again while it's already up),
   *  avoiding a hide+reshow flicker. */
  #quickBarMsgId: string | null = null;
  /** Per-message heart-button hold/tap/ArrowUp trigger controller, keyed by
   *  msgId — torn down on re-render (#populateBubble rebuilds the footer),
   *  eviction, and destroy() so button-level pointer listeners never leak. */
  #reactionTriggers: Map<string, ReactionTrigger> = new Map();
  /** Pending heart-add pulse clear timers, keyed by msgId (#pulseHeart) —
   *  torn down on eviction and destroy() alongside #reactionTriggers. */
  #pulseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Reactions fetches currently in flight, keyed by msgId. */
  #reactionFetchInFlight: Set<string> = new Set();
  /** Messages whose reaction fetch should be retried when the in-flight one completes. */
  #reactionFetchPending: Set<string> = new Set();
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
  /** W7: callback to the consumer (Composer) when a reply is requested on a bubble. */
  #onSetReply?: (snapshot: ReplySnapshot) => void;
  /** Write-401 fix (issue #78): pending delayed-rollback timers for an
   *  auth-expired write failure, keyed by msgId — cleared on destroy() so a
   *  torn-down MessageList never mutates state after the fact. */
  #rollbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Write-401 fix (issue #78): notifies the host that a write op hit an
   *  auth error — same signal the subscribe path uses. */
  #onAuthExpired?: () => void;
  /** Write-401 fix (issue #78): failure-counter hook — fires on every write
   *  failure (not just auth), classified by op + reason. */
  #onWriteFailure?: (op: WriteFailureOp, reason: WriteFailureReason, message: string) => void;
  /** Review finding #4: host callback for final attachment-hydration failure. */
  #onAttachmentError?: (msgId: string, attachmentId: string) => void;
  /** Review finding #4: dedup set — fire onAttachmentError once per (msgId,
   *  attachmentId) per final failure, not per retry or per re-render of the
   *  same attachment. Cleared in destroy(). */
  #firedAttachmentErrors: Set<string> = new Set();
  /** Observability: host callback fired when an unsealError row is rendered. */
  #onDecryptError?: (msgId: string, seq: number, reason: 'replay' | 'auth' | 'unknown') => void;
  /** Observability: dedup set — fire onDecryptError once per msgId per widget
   *  lifetime (a re-render via #updateBubble does not re-fire). Cleared in
   *  destroy(). */
  #firedDecryptErrors: Set<string> = new Set();
  /** issue #67: blob: object URLs created by hydrateMediaSrc() (authenticated
   *  attachment fetch), keyed by msgId — revoked in #evictOldMessages() (same
   *  lifecycle as #teardownReactionTrigger/#pulseTimers for an evicted row) so
   *  a long-lived busy room doesn't accumulate decoded-image memory past the
   *  eviction cap, and swept wholesale in destroy() as the final backstop. */
  #attachmentObjectUrls: Map<string, string[]> = new Map();
  /** Phase 2: VoiceBubble shells (headless player + waveform) rendered for
   *  audio attachments, keyed by msgId — destroyed in #evictOldMessages()
   *  (same lifecycle as #attachmentObjectUrls) so an evicted row's player
   *  revokes its objectURL + nulls its audio handlers, and destroy() sweeps
   *  any that survived to teardown. Closes the #77/#82/#88 blob-leak class
   *  for the voice path: the player's destroy() revokes the blob: URL it
   *  set as audio.src, and the widget's #attachmentObjectUrls backstop
   *  catches any the load adapter tracked (idempotent double-revoke). */
  #voiceBubbles: Map<string, VoiceBubble[]> = new Map();

  constructor(opts: MessageListOptions) {
    this.#client = opts.client;
    this.#roomId = opts.roomId;
    this.#container = opts.container;
    this.#selfUid = opts.selfUid;
    this.#lang = resolveLocale(opts.lang);
    this.#shadowHost = opts.shadowHost;
    this.#roleLabels = opts.roleLabels;
    this.#onSetReply = opts.onSetReply;
    this.#onAuthExpired = opts.onAuthExpired;
    this.#onWriteFailure = opts.onWriteFailure;
    this.#onAttachmentError = opts.onAttachmentError;
    this.#onDecryptError = opts.onDecryptError;
    this.#reactionsEnabled = opts.reactionsEnabled ?? true;
    this.#pinnedMessagesEnabled = opts.pinnedMessagesEnabled ?? true;
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
    // #228: mount pinned-messages banner ABOVE #listEl (insertBefore keeps it
    // at the top of the container, above the scrollable message list).
    if (this.#pinnedMessagesEnabled) {
      this.#pinnedBanner = new PinnedBanner({
        container: this.#container,
        insertBefore: this.#listEl,
        lang: this.#lang,
        signal: this.#signal,
        resolvePreview: (msgId) => this.#resolveRowPreview(msgId),
        resolveName: (uid) => this.#roster.get(uid)?.displayName,
        onJumpToMessage: (msgId) => this.scrollToMsgId(msgId),
      });
      // #230: load initial pinned messages from listPins().
      if (this.#client.listPins) {
        void this.#client.listPins(this.#roomId).then((pins) => {
          if (this.#signal.aborted) return;
          this.#pinnedBanner?.setPins(pins);
        }).catch(() => {
          // Graceful: listPins failure doesn't break the widget — empty banner.
        });
      }
    }
    // #120: mount typing indicator below the message list.
    this.#typingIndicator = new TypingIndicator({
      container: this.#container,
      lang: this.#lang,
      selfUid: this.#selfUid,
      signal: this.#signal,
      resolveName: (uid) => this.#roster.get(uid)?.displayName,
    });
    // #121: mount presence overlay for avatar dots + heartbeat.
    this.#presenceOverlay = new PresenceOverlay({
      lang: this.#lang,
      selfUid: this.#selfUid,
      signal: this.#signal,
      resolveName: (uid) => this.#roster.get(uid)?.displayName,
    });
    // #121: start heartbeat if the client supports sendPresence.
    if (this.#client.sendPresence) {
      this.#presenceOverlay.startHeartbeat(() => {
        void this.#client.sendPresence?.(this.#roomId).catch(() => {});
      });
    }
    // #121: fetch initial presence snapshot.
    if (this.#client.getPresence) {
      void this.#client.getPresence(this.#roomId).then((entries) => {
        if (this.#signal.aborted) return;
        this.#presenceOverlay?.setSnapshot(entries);
      }).catch(() => {});
    // #122: mount read receipts overlay for own-message checkmarks.
    this.#readReceipts = new ReadReceipts({
      lang: this.#lang,
      selfUid: this.#selfUid,
      signal: this.#signal,
    });
    // #126: mount thread panel for thread reply view.
    if (this.#client.getThread) {
      this.#threadPanel = new ThreadPanel({
        container: this.#container,
        getThread: (rootMsgId) => this.#client.getThread!(this.#roomId, rootMsgId),
        sendReply: (text, rootMsgId) => this.#sendThreadReply(text, rootMsgId),
        resolveName: (uid) => this.#roster.get(uid)?.displayName,
        selfUid: this.#selfUid,
        signal: this.#signal,
        lang: this.#lang,
      });
    }
    }

    // P2: re-pin to bottom when a composer resize (reply-bar toggle) shrinks
    // #listEl's clientHeight out from under a pinned reader. See #resizeObserver
    // doc comment. Feature-detected — not every test/runtime environment
    // implements ResizeObserver (jsdom does not).
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => {
        // Mirrors #handleNewMessage's wasPinned-before-mutation pattern:
        // read pinned-ness once, act on that snapshot. scrollTop does not
        // move on a pure resize, so a reader who was at the bottom reads as
        // still-pinned (small clips stay under shouldAutoScroll's threshold)
        // while a reader scrolled up is left exactly where they are.
        const wasPinned = this.#isPinnedToBottom();
        if (wasPinned) this.#scrollToBottom();
      });
      this.#resizeObserver.observe(this.#listEl);
    }

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

  /**
   * Route a live reaction event to the list's internal handler.
   * Used by the element's reconnect SubscribeFn to keep reactions live
   * across SSE reconnects.
   */
  handleReaction(event: ReactionEvent): void {
    this.#handleReaction(event);
  }

  /**
   * #229: Route a live mutation event (edit/delete/pin/unpin) to the list's
   * internal handler. Used by the element's reconnect SubscribeFn to keep
   * mutations live across SSE reconnects — mirrors handleMessage/handleReaction.
   */
  handleMutation(event: MutationEvent): void {
    this.#handleMutation(event);
  }

  /**
   * #232: Scroll to a specific message by msgId and briefly highlight it.
   * Used by the PinnedBanner's "jump to message" action. If the message is
   * outside the loaded window, this is a no-op (the banner already shows
   * "Message not loaded" for off-window pins).
   */
  scrollToMsgId(msgId: string): void {
    if (!this.#listEl) return;
    const idx = this.#order.indexOf(msgId);
    if (idx === -1) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const el = bubbles[idx] as HTMLElement | undefined;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('oxp-pinned-jump-highlight');
    setTimeout(() => el.classList.remove('oxp-pinned-jump-highlight'), 2000);
  }

  /**
   * #233: Resolve a msgId → preview text from the decrypted row store.
   * Returns undefined when the message is outside the loaded window
   * (the banner shows a "Message not loaded" placeholder for those).
   */
  #resolveRowPreview(msgId: string): string | undefined {
    const row = this.#rows.get(msgId);
    if (!row || row.deletedAt) return undefined;
    if (row.text) return row.text;
    if (row.plaintext) {
      try {
        return new TextDecoder().decode(row.plaintext).slice(0, 200);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Tear down: abort in-flight mount(), unsubscribe, clear DOM, close picker,
   *  disconnect the resize observer (P2). */
  destroy(): void {
    // C1: abort first so mid-flight mount() bails before subscribe
    this.#abortController.abort();
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#quickBar?.hide();
    this.#quickBar = null;
    // Reaction triggers self-destroy via the shared #signal abort listener
    // wired at construction (see #populateBubble) — the abort() call above
    // already cascaded to every live ReactionTrigger. #pulseTimers holds raw
    // setTimeout ids directly (no self-abort-aware object), so those need an
    // explicit sweep here.
    for (const timer of this.#pulseTimers.values()) clearTimeout(timer);
    this.#pulseTimers.clear();
    // Write-401 fix (issue #78): clear any pending delayed-rollback timer —
    // a torn-down MessageList must never mutate #reactions after the fact.
    for (const timer of this.#rollbackTimers.values()) clearTimeout(timer);
    this.#rollbackTimers.clear();
    this.#rows.clear();
    this.#order = [];
    this.#reactions.clear();
    this.#reactionFetchInFlight.clear();
    this.#reactionFetchPending.clear();
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
    // #120: destroy typing indicator (clears all timers + removes DOM).
    this.#typingIndicator?.destroy();
    this.#typingIndicator = null;
    // #228: destroy pinned-messages banner.
    this.#pinnedBanner?.destroy();
    this.#pinnedBanner = null;
    // #121: destroy presence overlay (clears heartbeat + dots).
    this.#presenceOverlay?.destroy();
    this.#presenceOverlay = null;
    // #122: destroy read receipts overlay.
    this.#readReceipts?.destroy();
    this.#readReceipts = null;
    // #126: destroy thread panel.
    this.#threadPanel?.close();
    this.#threadPanel = null;
    // issue #67: final backstop — revoke every blob: URL still tracked (any
    // row that survived to destroy() without being evicted first). Per-row
    // revocation on eviction happens in #evictOldMessages().
    for (const urls of this.#attachmentObjectUrls.values()) {
      for (const url of urls) URL.revokeObjectURL(url);
    }
    this.#attachmentObjectUrls.clear();
    // Review finding #4: clear the attachment-error dedup set on teardown.
    this.#firedAttachmentErrors.clear();
    // Observability: clear the decrypt-error dedup set on teardown.
    this.#firedDecryptErrors.clear();
    // Phase 2: destroy every surviving VoiceBubble player (revoke its
    // objectURL + null audio handlers) — same final-backstop contract.
    for (const bubbles of this.#voiceBubbles.values()) {
      for (const b of bubbles) b.destroy();
    }
    this.#voiceBubbles.clear();
  }

  /** issue #67: records a blob: URL created for an attachment image/audio src,
   *  keyed by msgId, so #evictOldMessages()/destroy() can revoke it. Bound
   *  method (not inline in #populateBubble) so renderAttachment() — a free
   *  function — gets a stable callback reference. */
  readonly #trackAttachmentObjectUrl = (msgId: string, url: string): void => {
    const existing = this.#attachmentObjectUrls.get(msgId);
    if (existing) existing.push(url);
    else this.#attachmentObjectUrls.set(msgId, [url]);
  };
  /** Review finding #4: bound callback for hydrateMediaSrc's final-failure path.
   *  Dedupes per (msgId, attachmentId) so a re-render of the same attachment
   *  (mutation SSE) doesn't re-fire, then forwards to the host callback. */
  readonly #notifyAttachmentError = (msgId: string, attachmentId: string): void => {
    const key = `${msgId}:${attachmentId}`;
    if (this.#firedAttachmentErrors.has(key)) return;
    this.#firedAttachmentErrors.add(key);
    this.#onAttachmentError?.(msgId, attachmentId);
  };
  /** Observability: deduped callback for the unsealError render path. Fires
   *  once per msgId per widget lifetime, forwarding {msgId, seq, reason} to
   *  the host (element.ts dispatches oxpulse-chat:decrypt-error). */
  readonly #notifyDecryptError = (msgId: string, seq: number, reason: 'replay' | 'auth' | 'unknown'): void => {
    if (this.#firedDecryptErrors.has(msgId)) return;
    this.#firedDecryptErrors.add(msgId);
    this.#onDecryptError?.(msgId, seq, reason);
  };
  /** Phase 2: records a VoiceBubble for a msgId so eviction/destroy can
   *  destroy its headless player (revoke objectURL + null audio handlers).
   *  Bound method so renderAttachment() — a free function — gets a stable
   *  callback reference, mirroring #trackAttachmentObjectUrl. */
  readonly #trackVoiceBubble = (msgId: string, bubble: VoiceBubble): void => {
    const existing = this.#voiceBubbles.get(msgId);
    if (existing) existing.push(bubble);
    else this.#voiceBubbles.set(msgId, [bubble]);
  };

  /** Phase 2 review-fix: destroy + untrack any VoiceBubbles previously rendered
   *  for this msgId. Called from #populateBubble BEFORE the innerHTML wipe so a
   *  live re-render (mutation SSE, dedupe/reclassify upsert) doesn't orphan the
   *  prior bubble's headless player — which would leak its objectURL + fire a
   *  redundant authed audio fetch on every re-render. Same lifecycle as
   *  #teardownReactionTrigger (called before the footer rebuild). */
  #destroyVoiceBubblesForMsg(msgId: string): void {
    const bubbles = this.#voiceBubbles.get(msgId);
    if (bubbles) {
      for (const b of bubbles) b.destroy();
      this.#voiceBubbles.delete(msgId);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * T18: Resolve a display name for a sender UID.
   * "You" for self-uid; otherwise roster displayName or uid short-form.
   * Single source of truth for all name rendering in this class.
   */
  #resolveDisplayName(senderUid: string): string {
    if (isSelfMatch(senderUid, this.#selfUid)) return t('senderYou', this.#lang);
    return this.#roster.get(senderUid)?.displayName ?? senderUid.slice(0, 8);
  }

  /**
   * W7: Build a ReplySnapshot for a message row.
   * Respects deletedAt/unsealError and falls back to image/voice attachment text.
   */
  #buildReplySnapshot(row: MessageRow): ReplySnapshot {
    let body = '';
    if (row.deletedAt) {
      body = tombstoneText('everyone', this.#lang);
    } else if (row.unsealError) {
      body = unsealErrorText(this.#lang);
    } else {
      body = decodeText(row);
    }
    body = replyBodySnapshotForMessage({ body, attachments: row.attachments });
    return {
      msgId: row.msgId,
      sender: this.#resolveDisplayName(row.senderUid),
      body,
    };
  }

  /**
   * W7: Render a compact quote preview inside a bubble for a thread reply.
   * Looks up the root row in #rows; if unavailable, shows a fallback placeholder.
   */
  /**
   * #126: Render a "N replies" thread indicator button on root messages.
   * Clicking opens the ThreadPanel for this message.
   */
  #renderThreadIndicator(el: HTMLElement, row: MessageRow): void {
    // Count how many messages in #rows have this msgId as their threadRootMsgId
    let replyCount = 0;
    for (const r of this.#rows.values()) {
      if (r.threadRootMsgId === row.msgId) replyCount++;
    }
    if (replyCount === 0) return;

    // Remove existing indicator if re-rendering
    const existing = el.querySelector('.oxp-thread-indicator');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oxp-thread-indicator';
    const countText = replyCount === 1
      ? t('threadReplyCount', this.#lang, { n: String(replyCount) })
      : t('threadReplies', this.#lang, { n: String(replyCount) });
    btn.textContent = `💬 ${countText}`;
    btn.setAttribute('aria-label', countText);
    btn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (this.#threadPanel?.isOpen) {
        this.#threadPanel.close();
        return;
      }
      const threadRow: ThreadRow = {
        msgId: row.msgId,
        senderUid: row.senderUid,
        text: row.text ?? decodeText(row),
        createdAt: row.createdAt,
        threadRootMsgId: null,
      };
      void this.#threadPanel?.open(threadRow);
    });
    el.appendChild(btn);
  }

  #renderReplyQuote(el: HTMLElement, row: MessageRow): void {
    const rootRow = row.threadRootMsgId ? this.#rows.get(row.threadRootMsgId) : undefined;
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'oxp-bubble-reply';
    if (rootRow) {
      quote.setAttribute('aria-label', t('replyToLabel', this.#lang, { sender: this.#resolveDisplayName(rootRow.senderUid) }));
      const sender = document.createElement('span');
      sender.className = 'oxp-bubble-reply-sender';
      sender.textContent = this.#resolveDisplayName(rootRow.senderUid);
      const body = document.createElement('span');
      body.className = 'oxp-bubble-reply-body';
      body.textContent = formatBodyPreview(this.#buildReplySnapshot(rootRow).body);
      quote.appendChild(sender);
      quote.appendChild(body);
      quote.addEventListener('click', () => {
        const rootEl = this.#listEl?.querySelector(`[data-msg-id="${cssEscape(rootRow.msgId)}"]`);
        rootEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } else {
      quote.disabled = true;
      quote.setAttribute('aria-label', t('replyOriginalUnavailable', this.#lang));
      const body = document.createElement('span');
      body.className = 'oxp-bubble-reply-body';
      body.textContent = t('replyOriginalUnavailable', this.#lang);
      quote.appendChild(body);
    }
    el.appendChild(quote);
  }

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
    if (!this.#reactionsEnabled || !this.#client.getReactions || this.#order.length === 0) return;
    await Promise.all(this.#order.map((msgId) => this.#scheduleReactionRefresh(msgId)));
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

    // Safety cap: bound live-streamed DOM/memory growth (production-blocking
    // audit gap — a busy central room + a long-open tab accumulated unbounded
    // nodes with no eviction). Pinned appends trim to the soft cap every
    // time; unpinned (scrolled-up) appends only trim once the walk-away hard
    // ceiling is crossed, and only down to that ceiling — see
    // #evictOldMessages doc comment for the UX reasoning behind both caps.
    if (wasPinned) {
      this.#evictOldMessages(MAX_LIVE_MESSAGES);
    } else if (this.#order.length > MAX_LIVE_MESSAGES_HARD_CEILING) {
      this.#evictOldMessages(MAX_LIVE_MESSAGES_HARD_CEILING);
    }

    // Fetch reactions for the new message if supported
    if (this.#reactionsEnabled && this.#client.getReactions) {
      void this.#scheduleReactionRefresh(row.msgId);
    }

    if (wasPinned) this.#scrollToBottom();
    // #122: mark new messages from others as read (auto-read on view).
    if (!isSelfMatch(row.senderUid, this.#selfUid) && this.#client.markRead && row.seq > 0) {
      void this.#client.markRead(this.#roomId, row.seq).catch(() => {});
    }
  }

  /**
   * #126: Send a thread reply via the SDK.
   * Delegates to client.sendText with threadRootMsgId set.
   */
  async #sendThreadReply(text: string, rootMsgId: string): Promise<void> {
    if (!this.#client.sendText) throw new Error('sendText not available');
    await this.#client.sendText(this.#roomId, {
      senderUid: this.#selfUid,
      text,
      threadRootMsgId: rootMsgId,
    });
  }

  /**
   * Bound live-streamed message growth (production-blocking audit gap): a
   * long-open tab in a busy central room accumulated #order/#rows entries and
   * DOM bubbles without limit, since #handleNewMessage only ever appended.
   * Drops the oldest entries — from #order/#rows/#reactions bookkeeping and
   * the corresponding DOM row — down to `cap`.
   *
   * Called with two different caps depending on `wasPinned` (the pre-append
   * #isPinnedToBottom() snapshot):
   * - Pinned: `cap = MAX_LIVE_MESSAGES`, trims on every append. Eviction
   *   always targets the oldest (top) end, which is exactly where a
   *   scrolled-up reader would be looking if they were scrolled up — but
   *   they're not (they're pinned to bottom), so trimming the top is
   *   invisible to them.
   * - Unpinned (scrolled up reading history): `cap =
   *   MAX_LIVE_MESSAGES_HARD_CEILING`, only called once #order has grown
   *   past that much higher ceiling. This bounds the walk-away case (a
   *   visitor who scrolls up and never returns to bottom) without yanking
   *   content out from under someone actively reading a normal-sized
   *   backlog — only a session that accumulates 600+ messages while
   *   scrolled away pays the cost of losing its oldest unread history.
   *
   * Fail-soft throughout: an unexpected DOM/state desync logs and skips
   * rather than throws (this runs on every live message in production).
   */
  #evictOldMessages(cap: number): void {
    const overflow = this.#order.length - cap;
    for (let i = 0; i < overflow; i++) {
      const evictedId = this.#order.shift();
      if (!evictedId) continue;
      this.#rows.delete(evictedId);
      this.#reactions.delete(evictedId);
      // Reaction-trigger lifecycle gap (caught in review): the evicted
      // bubble's heart-button listeners/timers were never explicitly torn
      // down here, nor was a pending heart-pulse clear timer — both would
      // otherwise linger for a msgId whose DOM row (and #reactions entry
      // above) are already gone.
      this.#teardownReactionTrigger(evictedId);
      const pulseTimer = this.#pulseTimers.get(evictedId);
      if (pulseTimer !== undefined) {
        clearTimeout(pulseTimer);
        this.#pulseTimers.delete(evictedId);
      }
      // issue #67 review fix (MAJOR): an evicted row's hydrated attachment
      // blob: URL(s) were never revoked here — only in destroy() — so a
      // long-lived busy room leaked one decoded image per evicted attachment
      // message, unbounded, exactly the class the surrounding eviction caps
      // exist to bound. Same lifecycle as #teardownReactionTrigger above.
      const objectUrls = this.#attachmentObjectUrls.get(evictedId);
      if (objectUrls) {
        for (const url of objectUrls) URL.revokeObjectURL(url);
        this.#attachmentObjectUrls.delete(evictedId);
      }
      // Phase 2: destroy the evicted row's VoiceBubble players — each
      // destroy() revokes the blob: URL the player set as audio.src and
      // nulls its audio event handlers. Same lifecycle as the objectURL
      // sweep above; the #attachmentObjectUrls backstop already revoked the
      // tracked URL (idempotent), but the player's own revoke + handler
      // cleanup must run too.
      const bubbles = this.#voiceBubbles.get(evictedId);
      if (bubbles) {
        for (const b of bubbles) b.destroy();
        this.#voiceBubbles.delete(evictedId);
      }
      // F12: sweep the per-msgId dedup Sets for the evicted row — same
      // lifecycle as the sibling per-msgId Maps above (#rows, #reactions,
      // #pulseTimers, #attachmentObjectUrls, #voiceBubbles). Without this,
      // #firedDecryptErrors and #firedAttachmentErrors accumulated one entry
      // per failed msgId for the widget's entire lifetime (only cleared in
      // destroy()), unbounded in a long-lived busy room — exactly the class
      // the eviction caps exist to bound. A msgId recycled after eviction
      // (re-entering #order as a new message) would also be wrongly
      // suppressed by the stale dedup entry. For well-formed (UUID) msgIds a
      // still-live message's entry is never touched here; a crafted msgId
      // containing ':' can make the prefix match below over-delete a live
      // sibling's dedup entry (harmless — at worst one duplicate host error
      // event). Root fix = validating inbound msg_id format on receipt (#191).
      this.#firedDecryptErrors.delete(evictedId);
      // #firedAttachmentErrors is keyed by `${msgId}:${attachmentId}`
      // (composite) — delete every key whose msgId component matches the
      // evicted row. Set deletion during iteration is spec-safe.
      for (const key of this.#firedAttachmentErrors) {
        if (key.startsWith(`${evictedId}:`)) this.#firedAttachmentErrors.delete(key);
      }
      const child = this.#listEl?.firstElementChild;
      if (child) {
        child.remove();
      } else if (this.#listEl) {
        console.warn('[MessageList] evictOldMessages: expected a DOM row to remove but found none');
      }
    }
  }

  #handleMutation(event: MutationEvent): void {
    // #229: handle pin/unpin ops — update the pinned banner live.
    // These are metadata-only ops (no sealed content re-transmitted),
    // so they don't need the row to exist in #rows.
    if (event.op === 'pin') {
      this.#pinnedBanner?.addPin(event.msgId, event.pinnedBy ?? '', new Date().toISOString());
      this.#updateBubblePinState(event.msgId);
      return;
    }
    if (event.op === 'unpin') {
      this.#pinnedBanner?.removePin(event.msgId);
      this.#updateBubblePinState(event.msgId);
      return;
    }

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

  /**
   * #229/#231: Update the pin button's aria-pressed state on a bubble after
   * a pin/unpin mutation, without a full bubble re-render. The pin button's
   * visual state is CSS-driven off aria-pressed (like the heart button).
   */
  #updateBubblePinState(msgId: string): void {
    if (!this.#listEl) return;
    const idx = this.#order.indexOf(msgId);
    if (idx === -1) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const el = bubbles[idx] as HTMLElement | undefined;
    if (!el) return;
    const pinBtn = el.querySelector('.oxp-pin-btn') as HTMLElement | null;
    if (pinBtn) {
      const isPinned = this.#pinnedBanner?.isPinned(msgId) ?? false;
      pinBtn.setAttribute('aria-pressed', String(isPinned));
      pinBtn.setAttribute('aria-label', t(isPinned ? 'unpinMessageAria' : 'pinMessageAria', this.#lang));
    }
  }

  /** Handle live reaction event from subscribe onReaction callback. */
  #handleReaction(event: ReactionEvent): void {
    if (!this.#reactionsEnabled) return;
    if (this.#signal.aborted) return;

    const existing = this.#reactions.get(event.msgId) ?? { counts: {}, users: {} };
    const counts = { ...existing.counts };
    const users = { ...existing.users };

    const priorUsers = users[event.emoji] ? [...users[event.emoji]!] : [];
    const userIndex = priorUsers.indexOf(event.userUid);

    if (event.op === 'add') {
      if (userIndex === -1) {
        priorUsers.push(event.userUid);
      }
      if (event.totalCount !== undefined && event.totalCount > 0) {
        counts[event.emoji] = event.totalCount;
      } else {
        const baseCount = counts[event.emoji] ?? priorUsers.length - (userIndex === -1 ? 1 : 0);
        counts[event.emoji] = baseCount + (userIndex === -1 ? 1 : 0);
      }
      users[event.emoji] = priorUsers;
    } else {
      // remove
      if (userIndex !== -1) {
        priorUsers.splice(userIndex, 1);
      }
      if (event.totalCount !== undefined && event.totalCount > 0) {
        counts[event.emoji] = event.totalCount;
        users[event.emoji] = priorUsers;
      } else {
        const baseCount = counts[event.emoji] ?? (priorUsers.length + (userIndex === -1 ? 0 : 1));
        const newCount = baseCount > 0 ? baseCount - 1 : 0;
        if (newCount <= 0) {
          delete counts[event.emoji];
          delete users[event.emoji];
        } else {
          counts[event.emoji] = newCount;
          users[event.emoji] = priorUsers;
        }
      }
    }

    this.#reactions.set(event.msgId, { counts, users });
    this.#updateReactionCluster(event.msgId);

    // If the server did not supply a reliable totalCount, re-fetch the authoritative
    // aggregate from getReactions. The local optimistic update above gives immediate
    // visual feedback; the refresh corrects truncation/ordering edge cases.
    if (event.totalCount === undefined || event.totalCount <= 0) {
      void this.#scheduleReactionRefresh(event.msgId);
    }
  }

  /**
   * Re-fetch the authoritative reaction aggregate for a message, deduping
   * concurrent requests by msgId. If a reaction event fires while a fetch is
   * already in flight, the pending set drives a retry once the current fetch
   * completes so the latest state wins.
   */
  #scheduleReactionRefresh(msgId: string): Promise<void> {
    if (!this.#client.getReactions) return Promise.resolve();
    if (this.#reactionFetchInFlight.has(msgId)) {
      this.#reactionFetchPending.add(msgId);
      return Promise.resolve();
    }
    this.#reactionFetchInFlight.add(msgId);
    return this.#client.getReactions(this.#roomId, msgId)
      .then((data) => {
        if (this.#signal.aborted) return;
        // Fail-soft: the row may have been evicted while this fetch was in flight.
        if (!this.#rows.has(msgId)) return;
        this.#reactions.set(msgId, { counts: data.counts, users: data.users });
        this.#updateReactionCluster(msgId);
      })
      .catch((err) => {
        console.warn(`[MessageList] Failed to refresh reactions for ${msgId}:`, err);
      })
      .finally(() => {
        this.#reactionFetchInFlight.delete(msgId);
        if (this.#reactionFetchPending.has(msgId)) {
          this.#reactionFetchPending.delete(msgId);
          void this.#scheduleReactionRefresh(msgId);
        }
      });
  }

  /** Update the reaction cluster element for a specific message. */
  #updateReactionCluster(msgId: string): void {
    if (!this.#listEl) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const idx = this.#order.indexOf(msgId);
    if (idx === -1) return;
    const bubble = bubbles[idx] as HTMLElement | undefined;
    if (!bubble) return;

    // Heart-first amendment: keep the footer's heart button in sync on every
    // reaction mutation/live event, independent of the cluster-chips branch
    // below (a message can drop to zero active reactions and the heart must
    // still flip to outline, not stay stale-filled).
    this.#syncHeartButton(bubble, msgId);

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
      const isOwn = emojiUsers.some((uid) => isSelfMatch(uid, this.#selfUid));
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

  /** Sync the heart button's aria-pressed + filled/outline state (CSS keys
   *  off aria-pressed) and its state-aware aria-label (review fix HIGH#5) to
   *  whether the caller's own reaction is currently ❤️. #populateBubble sets
   *  the initial state at render time; this keeps it live across optimistic
   *  mutations and server-pushed reaction events without rebuilding the
   *  whole bubble (which would also tear down/rewire the button's
   *  ReactionTrigger for no reason). */
  #syncHeartButton(bubble: HTMLElement, msgId: string): void {
    const heartBtn = bubble.querySelector('.oxp-reaction-heart-btn') as HTMLElement | null;
    if (!heartBtn) return;
    const isOwnHeart = this.#ownReactionFor(msgId) === HEART_EMOJI;
    heartBtn.setAttribute('aria-pressed', String(isOwnHeart));
    heartBtn.setAttribute('aria-label', t(isOwnHeart ? 'removeReactionAria' : 'addReactionAria', this.#lang));
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
      void this.#selectReaction(msgId, emoji);
    });

    return btn;
  }

  /**
   * TG/WA-style single-reaction-replace select (spec 2026-07-14): routes a
   * chip or quick-bar selection to add / remove / replace depending on the
   * caller's CURRENT own reaction on this message. Client-enforced — the
   * server stays a Slack-model idempotent per-(user,emoji) store.
   *
   *   no own reaction        → add(emoji)                  (#optimisticAddReaction)
   *   own reaction === emoji → remove(emoji)  [toggle off]  (#optimisticRemoveReaction)
   *   own reaction === X≠emoji → replace(X, emoji)          (#optimisticReplaceReaction)
   *
   * Review fix MEDIUM#7 (2026-07-14): reserves the bare-msgId #inflight key
   * for its WHOLE routed op — add, remove, OR replace — not just replace.
   * #optimisticAddReaction/#optimisticRemoveReaction apply their optimistic
   * state update SYNCHRONOUSLY before awaiting the network call, so a
   * second #selectReaction call for the same message (fired while the
   * first's request is still pending) used to read that ALREADY-APPLIED
   * optimistic state as "own reaction is X" and route to replace(X, Y) —
   * three overlapping server calls (the first op's own call, plus
   * replace's remove+add) racing on the same message. Reserving here for
   * every branch makes a second selection during the first's flight a
   * clean no-op instead. #optimisticReplaceReaction assumes this lock is
   * already held — it does not reserve its own.
   */
  /**
   * #231: Toggle pin state for a message — optimistic update + rollback on
   * error, mirroring #selectReaction's pattern. The SSE mutation event
   * (op="pin"/"unpin") is the authoritative confirmation; this method
   * updates the banner + button immediately so the user sees instant
   * feedback, then the server response either confirms or triggers a
   * rollback.
   */
  async #togglePin(msgId: string): Promise<void> {
    if (!this.#client.pinMessage || !this.#client.unpinMessage) return;
    const wasPinned = this.#pinnedBanner?.isPinned(msgId) ?? false;
    // Optimistic update.
    if (wasPinned) {
      this.#pinnedBanner?.removePin(msgId);
    } else {
      this.#pinnedBanner?.addPin(msgId, this.#selfUid, new Date().toISOString());
    }
    this.#updateBubblePinState(msgId);
    try {
      if (wasPinned) {
        await this.#client.unpinMessage(this.#roomId, msgId);
      } else {
        await this.#client.pinMessage(this.#roomId, msgId);
      }
    } catch (err) {
      // Rollback the optimistic update.
      if (wasPinned) {
        this.#pinnedBanner?.addPin(msgId, this.#selfUid, new Date().toISOString());
      } else {
        this.#pinnedBanner?.removePin(msgId);
      }
      this.#updateBubblePinState(msgId);
      const reason = classifyWriteFailureReason(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.#onWriteFailure?.('send', reason, errMsg);
      if (reason === 'auth_expired') {
        this.#onAuthExpired?.();
      }
    }
  }

  async #selectReaction(msgId: string, emoji: string): Promise<void> {
    if (this.#inflight.has(msgId)) return;
    this.#inflight.add(msgId);
    try {
      const ownEmoji = this.#ownReactionFor(msgId);
      if (ownEmoji === emoji) {
        await this.#optimisticRemoveReaction(msgId, emoji);
      } else if (ownEmoji === undefined) {
        // Heart-add pulse (reuse-update 2026-07-14, ported from web's
        // Bubble.svelte .qa-heart.on.pulse / MessageList.svelte
        // triggerHeartPulse): fires optimistically, same call order as web's
        // `onToggleReaction?.(...); if (!hadHeart) triggerHeartPulse(...)`.
        // Review fix LOW#10: gated on the same capability check the routed
        // op itself uses — no pulse when the reaction can't actually be sent.
        if (emoji === HEART_EMOJI && this.#client.sendReaction) this.#pulseHeart(msgId);
        await this.#optimisticAddReaction(msgId, emoji);
      } else {
        if (emoji === HEART_EMOJI && this.#client.removeReaction && this.#client.sendReaction) {
          this.#pulseHeart(msgId);
        }
        await this.#optimisticReplaceReaction(msgId, ownEmoji, emoji);
      }
    } finally {
      this.#inflight.delete(msgId);
    }
  }

  /** One-shot heart-add pulse (240ms, ported from web's heart-pulse
   *  keyframe) — adds the class synchronously, clears it after the
   *  animation window. Re-entrant per msgId: a second pulse before the
   *  first clears restarts the timer rather than stacking. */
  #pulseHeart(msgId: string): void {
    if (!this.#listEl) return;
    const idx = this.#order.indexOf(msgId);
    if (idx === -1) return;
    const bubbles = this.#listEl.querySelectorAll('[role="article"]');
    const bubble = bubbles[idx] as HTMLElement | undefined;
    const heartBtn = bubble?.querySelector('.oxp-reaction-heart-btn');
    if (!heartBtn) return;

    const existing = this.#pulseTimers.get(msgId);
    if (existing !== undefined) clearTimeout(existing);

    heartBtn.classList.add('oxp-reaction-heart-btn--pulse');
    const timer = setTimeout(() => {
      this.#pulseTimers.delete(msgId);
      heartBtn.classList.remove('oxp-reaction-heart-btn--pulse');
    }, HEART_PULSE_MS);
    this.#pulseTimers.set(msgId, timer);
  }

  /** The caller's own current reaction emoji on `msgId`, if any. At most one
   *  is expected client-side going forward (#selectReaction enforces single-
   *  reaction replace) — other clients predating this redesign or a
   *  not-yet-reconciled optimistic state could in principle hold more than
   *  one; this returns the first found (Object.entries order), which is a
   *  reasonable determinism guarantee for that edge case. */
  #ownReactionFor(msgId: string): string | undefined {
    const state = this.#reactions.get(msgId);
    if (!state) return undefined;
    for (const [emoji, users] of Object.entries(state.users)) {
      if (users.some((uid) => isSelfMatch(uid, this.#selfUid))) return emoji;
    }
    return undefined;
  }

  /**
   * Write-401 fix (issue #78): shared failure path for every optimistic
   * reaction write (add/remove/replace). Classifies the failure, fires the
   * failure-counter hook unconditionally, and — when the failure is an
   * auth error — signals onAuthExpired and defers the rollback (see
   * WRITE_AUTH_ROLLBACK_DELAY_MS for the rationale) instead of rolling
   * back immediately. Non-auth failures roll back immediately (existing
   * behaviour, unchanged).
   */
  #handleWriteFailure(op: WriteFailureOp, err: unknown, msgId: string, preSnapshot: ReactionState): void {
    const reason = classifyWriteFailureReason(err);
    this.#onWriteFailure?.(op, reason, err instanceof Error ? err.message : String(err));
    if (reason === 'auth_expired') {
      this.#onAuthExpired?.();
      this.#scheduleDelayedRollback(msgId);
    } else {
      this.#reactions.set(msgId, preSnapshot);
      this.#updateReactionCluster(msgId);
    }
  }

  /**
   * Write-401 fix (issue #78, pr-review-council #80 MAJOR fix): after
   * WRITE_AUTH_ROLLBACK_DELAY_MS, reconcile with SERVER truth via
   * #scheduleReactionRefresh — never restore a captured pre-optimistic
   * snapshot wholesale. A blind snapshot-restore would silently clobber any
   * SSE reaction event (#handleReaction) or refresh result that arrived
   * DURING the delay window: the write-401 scenario this feature targets
   * (write-JWT dead, SSE healthy) makes concurrent reactions from OTHER
   * users the expected case, not an edge case. #scheduleReactionRefresh is
   * this file's own established source of eventual truth (see its doc
   * comment and the #optimisticReplaceReaction call site below) — the
   * delayed path must defer to it too, not bypass it with a stale local
   * value. (Re)scheduling here replaces any prior pending timer for this
   * msgId. Cleared wholesale in destroy().
   */
  #scheduleDelayedRollback(msgId: string): void {
    const existing = this.#rollbackTimers.get(msgId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#rollbackTimers.delete(msgId);
      void this.#scheduleReactionRefresh(msgId);
    }, WRITE_AUTH_ROLLBACK_DELAY_MS);
    this.#rollbackTimers.set(msgId, timer);
  }

  /**
   * Replace the caller's reaction from `fromEmoji` to `toEmoji`: removeReaction(from)
   * then sendReaction(to), both applied optimistically off ONE pre-mutation
   * snapshot (spec 2026-07-14).
   *
   *   remove succeeds, add fails → rollback to snapshot (fromEmoji restored)
   *   remove fails               → abort — sendReaction(to) is never called — rollback
   *
   * In-flight guard: the bare-msgId #inflight key is reserved (and released)
   * by the CALLER (#selectReaction) for the whole routed op, atomic from the
   * caller's perspective across add/remove/replace uniformly — this method
   * assumes that lock is already held and does not reserve its own (review
   * fix MEDIUM#7: a second internal reservation on the same key here would
   * self-deadlock now that #selectReaction holds it up-front).
   */
  async #optimisticReplaceReaction(msgId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    if (!this.#client.removeReaction || !this.#client.sendReaction) return;

    const preState = this.#reactions.get(msgId) ?? { counts: {}, users: {} };
    const preSnapshot: ReactionState = {
      counts: { ...preState.counts },
      users: Object.fromEntries(Object.entries(preState.users).map(([k, v]) => [k, [...v]])),
    };

    // Optimistic: apply BOTH sides of the replace off the one snapshot before
    // either network call resolves.
    const counts = { ...preState.counts };
    const users = Object.fromEntries(Object.entries(preState.users).map(([k, v]) => [k, [...v]]));

    const fromCount = Math.max(0, (counts[fromEmoji] ?? 0) - 1);
    const fromUsers = (users[fromEmoji] ?? []).filter((u) => !isSelfMatch(u, this.#selfUid));
    if (fromCount <= 0) {
      delete counts[fromEmoji];
      delete users[fromEmoji];
    } else {
      counts[fromEmoji] = fromCount;
      users[fromEmoji] = fromUsers;
    }

    // Review fix LOW#8: increment the count only when self was ACTUALLY
    // newly pushed — mirrors the fromEmoji removal guard above. Self can
    // in principle already be listed in toEmoji's users (e.g. a legacy
    // multi-emoji client state — #ownReactionFor picks the first emoji
    // found when self legitimately holds more than one); count must never
    // exceed the users array's real length.
    const toUsers = users[toEmoji] ? [...users[toEmoji]!] : [];
    const alreadyInToUsers = toUsers.some((u) => isSelfMatch(u, this.#selfUid));
    if (!alreadyInToUsers) toUsers.push(this.#selfUid);
    counts[toEmoji] = (counts[toEmoji] ?? 0) + (alreadyInToUsers ? 0 : 1);
    users[toEmoji] = toUsers;

    this.#reactions.set(msgId, { counts, users });
    this.#updateReactionCluster(msgId);

    try {
      await this.#client.removeReaction(this.#roomId, msgId, fromEmoji);
    } catch (err) {
      console.warn(`[MessageList] replaceReaction removeReaction(${fromEmoji}) failed: ${String(err)}`);
      this.#handleWriteFailure('reaction_remove', err, msgId, preSnapshot);
      return; // remove failed → abort, never call sendReaction(toEmoji)
    }

    try {
      await this.#client.sendReaction(this.#roomId, msgId, toEmoji);
    } catch (err) {
      console.warn(`[MessageList] replaceReaction sendReaction(${toEmoji}) failed: ${String(err)}`);
      // remove succeeded server-side but the optimistic UI rolls back wholesale
      // to the pre-mutation snapshot (fromEmoji shown again) — see #optimisticAddReaction's
      // doc comment for why local rollback here doesn't re-call removeReaction's
      // server-side inverse: the existing #scheduleReactionRefresh/live-event
      // reconciliation path is this codebase's established source of eventual truth.
      this.#handleWriteFailure('reaction_add', err, msgId, preSnapshot);
    }
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
      this.#handleWriteFailure('reaction_add', err, msgId, preSnapshot);
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
      this.#handleWriteFailure('reaction_remove', err, msgId, preSnapshot);
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
    const isSelf = isSelfMatch(row.senderUid, this.#selfUid);

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
      // #121: register avatar for presence dot updates.
      this.#presenceOverlay?.registerAvatar(row.senderUid, rowEl.querySelector('.oxp-bubble-avatar') as HTMLElement);
    }
    rowEl.appendChild(el);
    // #122: register own-message bubbles for read receipt checkmarks.
    if (isSelf && row.seq > 0) {
      this.#readReceipts?.registerBubble(row.msgId, row.seq, el);
    }
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
    // T18: use roster name for other writers; "You" for self.
    // escapeHtml on roster name in case it contains special chars in the attribute context.
    const senderLabel = escapeHtml(this.#resolveDisplayName(row.senderUid));
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
    const isSelf = isSelfMatch(row.senderUid, this.#selfUid);

    // review-fix HIGH#1: recompute aria-label every call so it stays in sync
    // on live updates (#updateBubble), not just the initial #createBubble render.
    el.setAttribute('aria-label', this.#ariaLabelFor(row));

    // Preserve existing reaction cluster if present (reactions are managed separately)
    const existingCluster = el.querySelector('.oxp-bubble-reactions');

    // Phase 2 review-fix: destroy any VoiceBubble players previously rendered
    // for this msgId BEFORE the innerHTML wipe orphans them. Without this, a
    // live re-render (mutation/dedupe) leaves the prior headless player alive
    // → leaked objectURL + redundant authed audio fetch on every re-render.
    this.#destroyVoiceBubblesForMsg(row.msgId);

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
    // SEC-CR-003: textContent assignment is XSS-safe — no innerHTML or attribute sink.
    senderEl.textContent = this.#resolveDisplayName(row.senderUid);
    if (!isSelf) {
      // P5: role badge — mirrors the avatar's "OTHER writers only" convention
      // (own messages read "You" and carry no roster-derived decoration).
      // entry?.role is undefined for a plain member or an unrecognised wire
      // value (chat-sdk fails closed at parse time) — no badge in either case.
      const entry = this.#roster.get(row.senderUid);
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
      // Observability: fire the deduped decrypt-error callback so the host can
      // telemetry/alert by reason class. #populateBubble runs on both initial
      // render (#createBubble) and live re-render (#updateBubble), so the
      // dedup guard in #notifyDecryptError suppresses repeat fires.
      this.#notifyDecryptError(row.msgId, row.seq, row.unsealError);
    } else {
      const text = decodeText(row);
      bodyEl.innerHTML = renderMarkdown(text);
    }
    // W7: If this message is a reply, render a compact quote of the root above the body.
    if (row.threadRootMsgId) {
      this.#renderReplyQuote(el, row);
    }
    el.appendChild(bodyEl);
    // #126: If this message has thread replies, render a thread indicator button.
    if (!row.threadRootMsgId) {
      this.#renderThreadIndicator(el, row);
    }

    // W9: Render product card when a productRef + productMeta are present.
    // review-fix LOW: gate on !deletedAt && !unsealError so product card never
    // replaces or leaks alongside tombstone / failed-decrypt placeholders.
    if (!row.deletedAt && !row.unsealError && row.productRef && row.productMeta) {
      const meta = normalizeProductMeta(row.productMeta);
      if (meta) el.appendChild(renderProduct(meta, this.#lang));
    }

    // W2.2 slice 4: Render attachment bubbles.
    // review-fix LOW#1: gate on !deletedAt && !unsealError — closes the same
    // latent fall-through deletedAt already had: without this guard, wiring
    // attachment metadata onto a tombstoned or failed-decrypt row would
    // render attachment links next to the placeholder text. (issue #67:
    // row.attachments is now populated by element.ts's decodeRowAttachments()
    // for any row whose plaintext decodes as an attachment envelope.)
    if (!row.deletedAt && !row.unsealError && row.attachments && row.attachments.length > 0) {
      const attachmentsEl = document.createElement('div');
      attachmentsEl.className = 'oxp-bubble-attachments';
      if (allImageAttachments(row.attachments) && row.attachments.length > 1) {
        attachmentsEl.appendChild(
          renderAttachmentCollage(
            row.attachments,
            this.#lang,
            this.#client.fetchAttachmentBlob,
            (url) => this.#trackAttachmentObjectUrl(row.msgId, url),
            this.#signal,
            row.msgId,
            this.#notifyAttachmentError,
          ),
        );
      } else {
        for (const att of row.attachments) {
          attachmentsEl.appendChild(
            renderAttachment(
              att,
              this.#lang,
              this.#client.fetchAttachmentBlob,
              (url) => this.#trackAttachmentObjectUrl(row.msgId, url),
              this.#signal,
              (bubble) => this.#trackVoiceBubble(row.msgId, bubble),
              row.msgId,
              this.#notifyAttachmentError,
            ),
          );
        }
      }
      el.appendChild(attachmentsEl);
    }

    // Restore reaction cluster if it existed
    if (existingCluster) {
      el.appendChild(existingCluster);
    }

    // Heart button + timestamp row
    const footerEl = document.createElement('div');
    footerEl.className = 'oxp-bubble-footer';

    // Reactions redesign, heart-first amendment (spec 2026-07-14): the
    // visible '+😀' button + two-step popover is gone. A single heart
    // button now carries BOTH affordances — a plain tap/click instantly
    // toggles the ❤️ reaction (add/remove/replace via #selectReaction), a
    // ≥400ms touch/pen hold, a ≥400ms mouse hover-intent, or ArrowUp opens
    // the full ReactionQuickBar. Only wired when reactions are enabled AND
    // the client has a send path — otherwise there is nothing to trigger.
    this.#teardownReactionTrigger(row.msgId);
    if (this.#reactionsEnabled && this.#client.sendReaction) {
      const heartBtn = document.createElement('button');
      const isOwnHeart = this.#ownReactionFor(row.msgId) === HEART_EMOJI;
      // Review fix LOW#11: own-state styling is driven entirely by the
      // aria-pressed attribute selector (theme.ts:672) — a separate
      // --own class had zero CSS consumer, dropped rather than given one.
      heartBtn.className = 'oxp-reaction-heart-btn';
      heartBtn.type = 'button';
      // Review fix HIGH#5: state-aware — the real action on a pressed
      // heart is REMOVE, not ADD. Kept in sync live by #syncHeartButton.
      heartBtn.setAttribute('aria-label', t(isOwnHeart ? 'removeReactionAria' : 'addReactionAria', this.#lang));
      heartBtn.setAttribute('aria-pressed', String(isOwnHeart));
      heartBtn.setAttribute('aria-keyshortcuts', 'ArrowUp');
      // Review fix HIGH#6 (operator decision: gesture-only model, no
      // chevron/visual cue) — a native title hint for the hold-for-more
      // affordance, through i18n.
      heartBtn.title = t('heartButtonTitle', this.#lang);
      // M10-style static trusted SVG (feather "heart" outline) — no
      // interpolated data, safe innerHTML (see composer.ts's send icon for
      // the same established pattern). Filled vs outline is CSS-driven off
      // aria-pressed, kept in sync by #updateReactionCluster.
      heartBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
      footerEl.appendChild(heartBtn);

      const trigger = new ReactionTrigger({
        element: heartBtn,
        onToggle: () => void this.#selectReaction(row.msgId, HEART_EMOJI),
        // Review fix CRITICAL#2: a hover-sourced open must not steal focus
        // (the user could be typing elsewhere) — hold/keyboard opens still
        // focus the bar.
        onOpenBar: (source) => this.#showQuickBar(row.msgId, heartBtn, heartBtn, source !== 'hover'),
        signal: this.#signal,
      });
      this.#reactionTriggers.set(row.msgId, trigger);
    }

    // W7: reply button — only when the consumer has wired a composer to receive it.
    if (this.#onSetReply) {
      const replyBtn = document.createElement('button');
      replyBtn.className = 'oxp-reply-btn';
      replyBtn.type = 'button';
      replyBtn.setAttribute('aria-label', t('replyToMessageAria', this.#lang));
      replyBtn.textContent = '↩';
      replyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#onSetReply?.(this.#buildReplySnapshot(row));
      });
      footerEl.appendChild(replyBtn);
    }

    // #231: pin/unpin button — only when the client has a pin capability
    // (feature-detected like sendReaction for the heart button) and the
    // pinned-messages UI is enabled. A plain click toggles pin state
    // optimistically; the SSE mutation confirms or rolls back.
    if (this.#pinnedMessagesEnabled && this.#client.pinMessage && this.#client.unpinMessage) {
      const pinBtn = document.createElement('button');
      const isPinned = this.#pinnedBanner?.isPinned(row.msgId) ?? false;
      pinBtn.className = 'oxp-pin-btn';
      pinBtn.type = 'button';
      pinBtn.setAttribute('aria-pressed', String(isPinned));
      pinBtn.setAttribute('aria-label', t(isPinned ? 'unpinMessageAria' : 'pinMessageAria', this.#lang));
      pinBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.#togglePin(row.msgId);
      });
      footerEl.appendChild(pinBtn);
    }

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'oxp-bubble-time';
    timeEl.textContent = formatTime(rowTime(row));
    footerEl.appendChild(timeEl);

    el.appendChild(footerEl);
  }

  /**
   * Show the reaction quick-bar for a specific message, anchored to `anchorEl`
   * (the bubble — consistent visual placement regardless of trigger source)
   * with focus restored to `restoreFocusEl` on Escape (the heart button —
   * the bubble itself is not focusable).
   *
   * Idempotent by msgId: a redundant show for the message that already owns
   * the bar (e.g. a stacked ArrowUp/hold firing again while it's already up)
   * is a no-op — avoids a hide+reshow flicker.
   *
   * `focusFirstButton` (review fix CRITICAL#2): false for a hover-sourced
   * open — must not steal focus from wherever the user was.
   */
  #showQuickBar(msgId: string, anchorEl: HTMLElement, restoreFocusEl: HTMLElement, focusFirstButton = true): void {
    if (this.#quickBarMsgId === msgId && this.#quickBar) return;

    // Close any existing bar first — its onHide (wired below) resets
    // #quickBar/#quickBarMsgId, so no manual reset needed here.
    this.#quickBar?.hide();

    // M5: Append bar to the outer container (not #listEl which has overflow:auto).
    // This prevents the bar from being clipped near scroll edges.
    // Bar position is computed relative to the outer container via getBoundingClientRect.
    const container = this.#container;
    this.#quickBar = new ReactionQuickBar({
      container,
      onSelect: (emoji) => void this.#selectReaction(msgId, emoji),
      // Review fix HIGH#4: without this, #quickBar/#quickBarMsgId went
      // stale on Escape/outside-click (the bar closes ITSELF, MessageList
      // never finds out) and the idempotent-reshow guard above blocked
      // reopening the SAME message's bar forever. Single source of truth
      // for the reset — fires on Escape, outside-click, explicit hide(),
      // AND the internal hide() a re-show or select-dismiss triggers.
      onHide: () => {
        this.#quickBar = null;
        this.#quickBarMsgId = null;
      },
      signal: this.#signal,
      lang: this.#lang,
      ownEmoji: this.#ownReactionFor(msgId),
      isOwnMessage: isSelfMatch(this.#rows.get(msgId)?.senderUid ?? '', this.#selfUid),
    });
    this.#quickBarMsgId = msgId;
    // MAJOR-5: mount bar into shadow host (ShadowRoot) to escape overflow:hidden widgetRoot.
    // ShadowRoot is not HTMLElement but supports appendChild; cast is safe at runtime.
    const mountTo = this.#shadowHost ? (this.#shadowHost as unknown as HTMLElement) : undefined;
    this.#quickBar.show(anchorEl, mountTo, restoreFocusEl, focusFirstButton);

    // M5: Close bar on scroll — acceptable UX when bar is outside scroll container
    const onScroll = (): void => {
      this.#quickBar?.hide();
      this.#listEl?.removeEventListener('scroll', onScroll);
    };
    this.#listEl?.addEventListener('scroll', onScroll, { once: true });
  }

  /** Tear down a message's ReactionTrigger (if any) — called before rebuilding
   *  the footer (#populateBubble wipes+recreates it on every render) so
   *  bubble-level pointer listeners never accumulate across re-renders, and
   *  again on eviction/destroy(). */
  #teardownReactionTrigger(msgId: string): void {
    const existing = this.#reactionTriggers.get(msgId);
    if (existing) {
      existing.destroy();
      this.#reactionTriggers.delete(msgId);
    }
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

    // Issue #37: fetch roster in parallel with list() to avoid identity flash
    // (raw epids + grey initials for ~1-2s until roster resolves). Race roster
    // against a 300ms timeout -- if roster wins, first paint is branded with
    // display names. If timeout wins, paint with fallback and #fetchRoster
    // re-renders when it arrives.
    let rosterResolved = false;
    const rosterPromise: Promise<void> = this.#client.getRoster
      ? this.#client.getRoster(this.#roomId).then((map) => {
          if (this.#signal.aborted) return;
          this.#roster = map;
          rosterResolved = true;
        }).catch(() => { /* non-critical */ })
      : Promise.resolve();
    const rosterTimeout = new Promise<void>((resolve) => setTimeout(resolve, 300));

    let result: { items: MessageRow[]; hasNext: boolean };
    try {
      const [listResult] = await Promise.all([
        this.#client.list(this.#roomId, { limit: 50 }),
        Promise.race([rosterPromise, rosterTimeout]),
      ]);
      result = listResult;
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
      onReaction: this.#reactionsEnabled ? (event) => this.#handleReaction(event) : undefined,
      // T18: roster SSE invalidation signal — re-fetch roster on debounce.
      onRosterSignal: () => this.#scheduleRosterRefresh(),
      // #120: typing indicator — forward SSE typing events to the indicator.
      onTyping: this.#typingIndicator ? (event) => this.#typingIndicator!.addTyping(event.userId, event.ttlSecs) : undefined,
      // #121: presence — forward SSE presence events to the overlay.
      onPresence: this.#presenceOverlay ? (event) => this.#presenceOverlay!.updatePresence(event.userId, event.lastSeenAt) : undefined,
      // #122: read receipts — forward SSE read_receipt events to the overlay.
      onReadReceipt: this.#readReceipts ? (event) => this.#readReceipts!.onReadReceipt(event.userId, event.lastSeq) : undefined,
    });

    if (this.#client.getReactions && this.#order.length > 0) {
      void this.#fetchAllReactions();
    }

    // Issue #37: if the 300ms timeout won the race (roster still in-flight),
    // #fetchRoster will re-render when it arrives. If roster resolved, skip.
    if (this.#client.getRoster && !rosterResolved) {
      void this.#fetchRoster();
    }
  }

  #dispatchError(message: string): void {
    // #102 flake guard: a post-teardown dispatch (an in-flight #fetchAndRender
    // whose list() rejected AFTER destroy() aborted the signal) must not fire
    // an event on a torn-down container — under jsdom that surfaced as an
    // unhandled rejection landing in a LATER test's window (CI runs #77,
    // #100). #signal.aborted IS the destroyed signal (set first in destroy()),
    // so this is the same guard #handleReaction already uses. The arg is
    // always a string here (we build the CustomEvent ourselves), so the
    // "real Event" half of the guard is structural — defended in case a future
    // caller passes through an external event.
    if (this.#signal.aborted) return;
    this.#container.dispatchEvent(
      new CustomEvent('oxpulse-chat:error', {
        bubbles: true,
        composed: true,
        detail: { message },
      }),
    );
  }
}
