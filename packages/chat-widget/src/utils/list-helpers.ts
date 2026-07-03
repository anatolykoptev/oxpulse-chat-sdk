// Pure helpers for MessageList — ported verbatim from
// web/src/lib/chat/list/helpers.ts (commit: W2.2 slice 1).
// Widget package is standalone — no runtime import from web/.

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
 *  (see Task 5 spec; scope is informational, identical visuals). */
export function tombstoneText(_scope: "self" | "everyone"): string {
  return "This message was deleted";
}

/** U2: Failed-decrypt placeholder text — same wording regardless of the SDK's
 *  unsealError reason ('replay' | 'auth' | 'unknown'). Mirrors tombstoneText's
 *  one-wording-for-all-cases precedent: the UI doesn't need to expose crypto
 *  failure-class detail to the end user, only that the content is unavailable.
 *  Lock glyph gives a visual + screen-reader ("locked") cue distinct from the
 *  plain-italic tombstone. No i18n layer exists in this package (lang option
 *  is accepted but unused for strings — see MessageListOptions.lang) so this
 *  hardcoded-English string matches every other user-facing string in the
 *  widget (tombstoneText, "Retry", "Add reaction", inline list-error text). */
export function unsealErrorText(): string {
  return "\u{1F512} This message couldn't be decrypted";
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
