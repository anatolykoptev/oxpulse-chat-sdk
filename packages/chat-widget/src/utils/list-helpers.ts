// Pure helpers for MessageList — ported verbatim from
// web/src/lib/chat/list/helpers.ts (commit: W2.2 slice 1).
// Widget package is standalone — no runtime import from web/.

import { t, type Locale } from './i18n.js';

/** Pure decision: is the user pinned to the bottom of a scroll container?
 *  Threshold defaults to 80px — small enough that a user who has genuinely
 *  scrolled up to read history is not jolted, large enough that subpixel
 *  rounding (font-size, line-height, scrollbar gutter) does not flip the
 *  decision frame-to-frame. */
export interface ShouldAutoScrollArgs {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly thresholdPx?: number;
}
export function shouldAutoScroll(args: ShouldAutoScrollArgs): boolean {
  const t = args.thresholdPx ?? 80;
  const distFromBottom = args.scrollHeight - args.scrollTop - args.clientHeight;
  return distFromBottom <= t;
}

/** Short, stable display fallback when a peer didn't claim a nick.
 *  Last 6 chars of the peerId — UUIDs end in random hex so the suffix
 *  distinguishes peers in a small room without leaking the full
 *  identifier into the transcript. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function shortFromPeerId(peerId: string): string {
  if (peerId.length <= 6) return peerId;
  return peerId.slice(-6);
}

export interface MessageLike { from: string; nick?: string; ts: number; }

/** Author-chain detection — consecutive messages from the same peer/nick
 *  within a short window collapse the from-label and tighten vertical
 *  spacing, mirroring iMessage / Telegram desktop. */
export function isChained(prev: MessageLike | undefined, curr: MessageLike): boolean {
  if (!prev) return false;
  if (curr.from === '__system__' || prev.from === '__system__') return false;
  if (curr.from !== prev.from) return false;
  if (curr.nick !== prev.nick) return false;
  // 4 minutes — long enough that out-of-band gaps still render with a
  // fresh from-label, short enough that a back-and-forth burst chains.
  return (curr.ts - prev.ts) < 4 * 60_000;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, ' ').replace(' ', '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** Format remaining time until a wall-clock expiry timestamp.
 *  - >= 1h: `Hh Mm` (e.g. `2h 15m`)
 *  - >= 1m: `Mm Ss` (e.g. `15m 30s`)
 *  - <= 1m, > 0:  `Ss` (e.g. `30s`)
 *  - <= 0: `expired`
 *  Pure — exported so unit tests can pin every boundary. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function formatTimeRemaining(remainMs: number): string {
  if (remainMs <= 0) return "expired";
  const totalSec = Math.floor(remainMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec - totalMin * 60;
    return `${totalMin}m ${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin - hours * 60;
  return `${hours}h ${min}m`;
}

/** Tombstone replacement text — same wording for both scopes
 *  (see Task 5 spec; scope is informational, identical visuals).
 *  i18n follow-up: `lang` defaults to 'en' so every existing call site (and
 *  the direct-import unit tests) keeps working without a signature change. */
export function tombstoneText(_scope: "self" | "everyone", lang: Locale = 'en'): string {
  return t('tombstone', lang);
}

/** U2: Failed-decrypt placeholder text (visible) — same wording regardless of
 *  the SDK's unsealError reason ('replay' | 'auth' | 'unknown'). Mirrors
 *  tombstoneText's one-wording-for-all-cases precedent: the UI doesn't need
 *  to expose crypto failure-class detail to the end user, only that the
 *  content is unavailable. Lock glyph gives a visual cue distinct from the
 *  plain-italic tombstone. i18n follow-up: routed through the widget's
 *  locale table (see ./i18n.ts) — `lang` defaults to 'en'. */
export function unsealErrorText(lang: Locale = 'en'): string {
  return t('unsealError', lang);
}

/** U2 review-fix: aria/screen-reader variant of unsealErrorText() — same
 *  wording, no lock glyph. VoiceOver/NVDA announce U+1F512 as "locked", so
 *  the glyph-bearing string would read as "locked This message couldn't be
 *  decrypted" — redundant once the words themselves are spoken. The glyph is
 *  a visual-only affordance; keep it out of the announced text. */
export function unsealErrorAriaText(lang: Locale = 'en'): string {
  return t('unsealErrorAria', lang);
}

/**
 * Guarded self/other identity compare — the single source of truth for every
 * self-identity check in message-list.ts (bubble alignment, aria-label,
 * reaction "own" state). Returns false whenever selfUid is unresolved (empty
 * string), so a row can never false-positive as "self" merely because both
 * senderUid and selfUid happen to be empty — mirrors hasOwnHeart's non-empty
 * guard below. Extracted after an independent audit found 4 separate inline
 * `===`/`includes` compares in message-list.ts that could drift (sibling gap
 * to PR #39's selfUidFromJwt fix).
 */
export function isSelf(senderUid: string, selfUid: string): boolean {
  if (selfUid === "") return false;
  return senderUid === selfUid;
}

/** Does the current user have a ❤️ reaction on the given message?
 *  Pure helper so the heart-fill state is unit-testable without
 *  mounting Svelte. Tuple shape mirrors the hook view. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function hasOwnHeart(
  reactions: ReadonlyArray<readonly [string, ReadonlyArray<string>]> | undefined,
  selfPeerId: string,
): boolean {
  if (!reactions || reactions.length === 0) return false;
  if (selfPeerId === "") return false;
  for (const [emoji, peers] of reactions) {
    if (emoji !== "❤️") continue;
    for (const p of peers) if (p === selfPeerId) return true;
    return false;
  }
  return false;
}

/** Defense-in-depth on the render boundary. Images ride inline as
 *  `data:image/...` URLs; the schema only types `url: string.min(1)`
 *  so a hostile peer could substitute an https:// URL and weaponize
 *  the renderer into a tracking pixel that leaks the receiver's IP
 *  past whatever TURN relay was protecting it. We refuse anything
 *  but a data:image/ URL on display. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function isSafeImageUrl(url: string | undefined): boolean {
  if (typeof url !== "string") return false;
  return url.startsWith("data:image/");
}

/** Same threat-model guard for voice attachments. Only data:audio/ URLs
 *  are rendered — https:// would leak the receiver's IP to a tracking
 *  server past the TURN relay (same concern as isSafeImageUrl). */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function isSafeAudioUrl(url: string | undefined): boolean {
  if (typeof url !== "string") return false;
  return url.startsWith("data:audio/");
}

/** CSS.escape with a conservative regex fallback for older test runtimes
 *  that may not expose `CSS.escape`. msgIds are UUIDs in practice so this
 *  is a defense-in-depth path. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}
