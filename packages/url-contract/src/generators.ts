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
 * Spec: docs/superpowers/specs/2026-05-20-heterogeneous-urls-design.md
 * ADR:  docs/adr/0005-heterogeneous-room-urls.md
 * Plan: docs/superpowers/plans/2026-05-22-url-contract-extract-plan.md W5.5
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
import { asRoomId } from './brands.js';
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
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  // Use btoa with a binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    // bytes[i] is always defined: i < bytes.length guarantees in-bounds access.
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
 * Regenerate (up to 8 tries) until clean.
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
  // Extremely unlikely (≈8.5e-12) all 8 draws were unsafe; return last anyway.
  // A non-messenger-safe value is preferable to an error in room creation / join.
  return bytesToBase64Url(bytes);
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
