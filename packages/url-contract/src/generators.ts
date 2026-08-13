/**
 * generators.ts — room code / ID generation.
 *
 * ADR-0005: heterogeneous room URLs.
 *   - generateRoomCode('group') → typed 10-char code (G-letter first + Luhn checksum)
 *   - generateRoomCode('1to1' | 'burner' | 'sealed') → opaque 22-char base64url
 *   - generateOpaqueRoomId() → opaque 22-char base64url (direct call)
 *
 * All entropy comes from crypto.getRandomValues (CSPRNG).
 * Room IDs are capability URLs — unguessable join tokens.
 *
 * Port: web/src/lib/roomcode.ts (W5.5).
 * Deviation: imports GROUP_LETTERS (and all alphabet/threshold constants)
 * from ./constants.js — kills the hardcoded 'GHJKLM' literal that lived in
 * web/roomcode.ts to avoid a circular dependency. The circular dep is broken
 * now that the canonical source lives in this package.
 *
 * ADR:  docs/adr/ADR-0005-heterogeneous-room-urls.md
 */

import {
  GROUP_LETTERS,
  FULL_LETTERS,
  DIGITS,
  GROUP_LETTER_THRESHOLD,
  FULL_LETTER_THRESHOLD,
  DIGIT_THRESHOLD,
} from './constants.js';
import { appendChecksum } from './checksum.js';
import { asRoomId, asShortId, asShortLinkAlias, type ShortId, type ShortLinkAlias } from './brands.js';
import type { RealKind } from './parse.js';

/**
 * Pick a single character from the given alphabet string using CSPRNG
 * rejection sampling to avoid modulo bias.
 */
function pickFromAlphabet(alphabet: string, threshold: number): string {
  const buf = new Uint8Array(1);
  let b: number;
  do {
    crypto.getRandomValues(buf);
    // buf[0] is always defined: Uint8Array index access within bounds is safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    b = buf[0]!;
  } while (b >= threshold);
  const ch = alphabet[b % alphabet.length];
  // alphabet is non-empty and b % alphabet.length is in bounds by construction.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return ch!;
}

/**
 * Convert a Uint8Array to a URL-safe base64 string (no padding).
 * Replaces + with -, / with _, strips trailing =.
 *
 * Uses Array.join (O(N)) instead of string concatenation (O(N²)), matching
 * the canonical pattern in `packages/crypto-primitives/src/base64url.ts`.
 * Cross-platform: `btoa` is available in browsers, Node 16+, Deno, Bun.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    // bytes[i] is always defined: i < bytes.length guarantees in-bounds access.
    chars.push(String.fromCharCode(bytes[i]!));
  }
  return btoa(chars.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string (no padding) to raw bytes.
 *
 * Inverse of {@link bytesToBase64Url}. Throws `DOMException` (via `atob`) on
 * invalid base64 — callers handling untrusted input should pre-validate the
 * charset or wrap in try/catch.
 *
 * Cross-platform: `atob` is available in browsers, Node 16+, Deno, Bun.
 */
export function base64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Generate a messenger-safe 16-byte base64url string (22 chars, no padding).
 *
 * Shared primitive used by generateOpaqueRoomId(), generateBurnerKey(), and
 * generateJoinSecret(). Extracted per the 3rd-duplicate architecture trigger:
 * all three minters had the same byte→base64url→reject loop (or were missing it).
 *
 * Three messenger / URL-safety invariants enforced by rejection-sampling:
 *
 *  1. Never emit '-_' or '_-' adjacency. Some messengers (Telegram,
 *     WhatsApp, Signal) apply Markdown-style rendering to plain-text URLs
 *     — `_..._` is parsed as italic delimiters and the underscores are
 *     stripped. This breaks both the path segment (room-id) AND the
 *     fragment (#k=<key> or .<joinSecret>) because messengers apply the
 *     transform to the whole pasted string, not just the path.
 *
 *  2. Never emit a leading '-' or '_'. Operator-reported issue
 *     (room `-wz9g9FTfXIdfGQYoXXV-w` on staging): `https://host/-foo` is
 *     ugly when shared and CLI tools may mis-parse the leading dash as a
 *     flag separator. Cost is one extra reject every ~3% of draws; with
 *     8 retries the all-fail probability is ~9e-13.
 *
 *  3. Never emit a trailing '-' or '_'. Defense-in-depth — by the
 *     base64-encoding math, the last char (position 21) is always one of
 *     {A, Q, g, w} (only 2 data bits remain after 126 bits encoded in
 *     groups of 6), so structurally this CAN'T happen — but the explicit
 *     check protects against a future change to the byte count or the
 *     encoder.
 *
 * Regenerate (up to 8 tries) until clean. After 8 unsafe draws (≈8.5e-12),
 * THROWS — fail-closed, never silently returns an unsafe value (issue #327).
 *
 * P(needing >1 draw):
 *   adjacency  — 21 positions × 2 patterns × (1/64)² ≈ 1.025%
 *   leading -/_ — 2/64                                 ≈ 3.125%
 *   trailing   — 0% structurally (kept for defense-in-depth)
 *   combined unsafe per draw                            ≈ 4.13%
 * P(all 8 draws unsafe): ≈ (0.0413)^8 ≈ 8.5e-12 — negligible.
 *
 * Output: 22 chars from [A-Za-z0-9_-], no '-_' / '_-' adjacency, never
 * starting or ending with '-' or '_'.
 */
export function messengerSafeBase64Url16(): string {
  const bytes = new Uint8Array(16);
  for (let attempt = 0; attempt < 8; attempt++) {
    crypto.getRandomValues(bytes);
    const s = bytesToBase64Url(bytes);
    if (!isMessengerSafe(s)) continue;
    return s;
  }
  // Fail-closed (issue #327): all 8 draws were messenger-unsafe (≈8.5e-12
  // probability). A non-messenger-safe URL would break when shared via
  // Telegram/WhatsApp (underscore stripping) — a silent, user-visible failure
  // worse than a retry. Throw so the caller can surface a clear error and the
  // user retries, instead of receiving a link that silently breaks.
  // This also satisfies the must-log rule: the throw IS the observable signal.
  throw new Error(
    'messengerSafeBase64Url16: CSPRNG produced 8 consecutive unsafe draws ' +
      '(probability ≈8.5e-12) — possible CSPRNG failure or extremely bad luck',
  );
}

/**
 * Predicate: returns true iff `s` is messenger-safe per the three invariants
 * documented on messengerSafeBase64Url16(). Extracted so the rules live in one
 * place — the public `messengerSafeBase64Url16` would otherwise inline the same
 * checks at the rejection-sampling site, making future invariants harder to add.
 */
function isMessengerSafe(s: string): boolean {
  if (s.length === 0) return false;
  // Invariant 1: no '-_' / '_-' adjacency.
  if (s.includes('-_') || s.includes('_-')) return false;
  // Invariant 2: no leading '-' or '_'.
  const first = s.charCodeAt(0);
  if (first === 45 /* '-' */ || first === 95 /* '_' */) return false;
  // Invariant 3: no trailing '-' or '_' (defense-in-depth).
  const last = s.charCodeAt(s.length - 1);
  if (last === 45 /* '-' */ || last === 95 /* '_' */) return false;
  return true;
}

/**
 * Generate an opaque 22-char base64url room ID.
 *
 * Uses 16 bytes (128 bits) from crypto.getRandomValues, encoded as URL-safe
 * base64 without padding. 128 bits of entropy — no checksum needed (mis-typing
 * is irrelevant for share-by-link flows).
 *
 * Output: 22 chars from [A-Za-z0-9_-]. Position 21 can only be one of
 * {A, Q, g, w} because only 2 data bits remain after encoding 126 bits.
 *
 * Delegates to messengerSafeBase64Url16() for the messenger-safety guard.
 */
export function generateOpaqueRoomId(): string {
  return messengerSafeBase64Url16();
}

/**
 * Generate a room code / ID for the given room kind.
 *
 * ADR-0005 routing:
 *   'group'  → typed 10-char code (G-letter first + Luhn checksum)
 *   '1to1'   → opaque 22-char base64url
 *   'burner' → opaque 22-char base64url
 *   'sealed' → opaque 22-char base64url
 *
 * @param kind - Room kind (persistence-level).
 * @returns Typed 10-char code for group, 22-char opaque for others.
 */
export function generateRoomCode(kind: RealKind): string {
  if (kind !== 'group') {
    return generateOpaqueRoomId();
  }

  // Group: typed 10-char code with G-letter first + Luhn checksum
  const firstLetter = pickFromAlphabet(GROUP_LETTERS, GROUP_LETTER_THRESHOLD);
  let restLetters = '';
  for (let i = 0; i < 3; i++) restLetters += pickFromAlphabet(FULL_LETTERS, FULL_LETTER_THRESHOLD);
  let digits = '';
  for (let i = 0; i < 4; i++) digits += pickFromAlphabet(DIGITS, DIGIT_THRESHOLD);
  const bare = `${firstLetter}${restLetters}-${digits}`;
  // appendChecksum validates the 9-char payload and appends the checksum char.
  return appendChecksum(asRoomId(bare));
}

// ── ShortId / ShortLinkAlias generators (#326) ──────────────────────────────

/**
 * Alphanumeric alphabet for ShortId and ShortLinkAlias generation.
 * 62 chars: A-Z, a-z, 0-9 — matches the ShortId and ShortLinkAlias regex.
 */
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; // 62 chars

/**
 * Rejection-sampling threshold for the 62-char alphanumeric alphabet.
 * Largest multiple of 62 that fits in a single byte: floor(256/62)*62 = 248.
 */
const ALPHANUMERIC_THRESHOLD = Math.floor(256 / ALPHANUMERIC.length) * ALPHANUMERIC.length; // 248

/**
 * Generate a CSPRNG-based opaque alphanumeric ShortId.
 *
 * Uses rejection sampling to avoid modulo bias (same pattern as
 * {@link pickFromAlphabet}). All entropy comes from `crypto.getRandomValues`.
 *
 * @param length - Number of characters to generate (default 12, minimum 4
 *   to satisfy the ShortId brand shape `^[A-Za-z0-9]{4,}$`).
 * @returns A branded `ShortId` — valid session IDs, invite tokens, etc.
 * @throws RangeError if `length` is less than 4.
 */
export function generateShortId(length: number = 12): ShortId {
  if (length < 4) {
    throw new RangeError(`generateShortId: length must be >= 4 (ShortId minimum), got ${length}`);
  }
  let s = '';
  for (let i = 0; i < length; i++) {
    s += pickFromAlphabet(ALPHANUMERIC, ALPHANUMERIC_THRESHOLD);
  }
  return asShortId(s);
}

/**
 * Generate a CSPRNG-based opaque ShortLinkAlias for the `/s/<alias>` URL space.
 *
 * Generates a 4-6 character alphanumeric alias matching the server-side
 * authority (`crates/server/src/alias_resolver/alphabet.rs`,
 * `ALIAS_LEN_MIN..ALIAS_LEN_MAX = 4..6`). Uses rejection sampling.
 *
 * @param length - Number of characters (default 5, must be 4-6 to satisfy
 *   the ShortLinkAlias brand shape `^[A-Za-z0-9]{4,6}$`).
 * @returns A branded `ShortLinkAlias`.
 * @throws RangeError if `length` is outside [4, 6].
 */
export function generateShortLinkAlias(length: number = 5): ShortLinkAlias {
  if (length < 4 || length > 6) {
    throw new RangeError(
      `generateShortLinkAlias: length must be in [4, 6] (ShortLinkAlias range), got ${length}`,
    );
  }
  let s = '';
  for (let i = 0; i < length; i++) {
    s += pickFromAlphabet(ALPHANUMERIC, ALPHANUMERIC_THRESHOLD);
  }
  return asShortLinkAlias(s);
}
