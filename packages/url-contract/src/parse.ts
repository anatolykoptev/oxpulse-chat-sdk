/**
 * parse.ts — stateless canonical-short codec for room codes.
 *
 * ADR-0005: heterogeneous room URLs. The codec supports three forms:
 *
 *   Bare:        'AAAA-0000' (9 chars) → kind: 'legacy-bare' (transition window)
 *   Typed group: 'AAAA-0000C' (10 chars, G-letter first + Luhn checksum) → kind: 'group'
 *   Opaque:      22-char base64url string → kind: 'opaque'
 *
 * ADR-0004 typed codes for 1to1/burner/sealed (A-F, N-T, U-Z first letters)
 * are no longer generated or accepted as typed codes. Those room kinds now use
 * opaque 22-char base64url IDs. The 9-char bare form is still accepted during
 * the transition window (kind='legacy-bare').
 *
 * Invariant: all inputs with an 'r:' prefix are rejected (mirrors Rust
 * validate_bare_room_id_no_opaque — no opaque-ID-like strings accepted as bare codes).
 *
 * ADR:  docs/adr/ADR-0005-heterogeneous-room-urls.md
 *
 * Port: web/src/lib/routes/shortlink/canonical.ts (W5.4).
 * Deviation: imports from ./constants.js + ./checksum.js + ./brands.js instead
 * of web-internal paths. GROUP_FIRST_LETTERS comes from constants.ts (already
 * in the package barrel — no re-export needed here).
 * isValidRoomId is the full-semantic version (structure + Luhn for 10-char).
 * encodeCanonicalShort / decodeCanonicalShort omitted — W5.5 (generators wave).
 */

import { GROUP_FIRST_LETTERS } from './constants.js';
import { verifyChecksum } from './checksum.js';
import { asRoomId, type RoomId } from './brands.js';

/**
 * URL-level room kind — ADR-0005.
 *
 * 'group'       → 10-char typed code, G-letter first + Luhn checksum.
 * 'opaque'      → 22-char base64url (1to1, burner, sealed — share-by-link capability).
 * 'legacy-bare' → 9-char bare 'AAAA-0000' form, kind unknown (transition window).
 */
export type RoomKind = 'group' | 'opaque' | 'legacy-bare';

/**
 * Persistence-level room kind — used in kind_hello signaling and store records.
 * These are the four "real" kinds that map to actual room type behaviour.
 * The URL-level RoomKind 'opaque' and 'legacy-bare' resolve to one of these
 * after a kind_hello signaling round-trip or DB lookup.
 */
export type RealKind = '1to1' | 'group' | 'burner' | 'sealed';

/**
 * Regex for 22-char base64url strings (URL-safe base64, no padding).
 * Alphabet: A-Z, a-z, 0-9, -, _
 */
const OPAQUE_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Full semantic validation of a room ID string.
 *
 * Accepts the three ADR-0005 forms:
 *   - 9-char bare  `AAAA-0000`            (structure only — no checksum)
 *   - 10-char typed `AAAA-0000C`           (structure + Luhn checksum verified)
 *   - 22-char opaque `[A-Za-z0-9_-]{22}`  (1to1/burner/sealed)
 *
 * For full-semantic call sites (kind resolution), prefer parseRoomCode() which
 * also returns the RoomKind. isValidRoomId is the entry-point guard for callers
 * that only need a boolean predicate.
 *
 * BEHAVIOR CHANGE (W5.4): the 10-char branch now verifies the Luhn checksum.
 * Web's pre-W5.4 `isValidRoomId` (in `web/src/lib/roomcode.ts`) was shape-only
 * across all three forms. When W5.7 swaps callers to this implementation, the
 * only known caller (`web/src/lib/routes/predicates.ts:isCallRoute`) tightens
 * its trust boundary — bad-Luhn 10-char strings stop being treated as call
 * routes. This is the correct ADR-0005 end-state, not a regression. The W5.7
 * implementer must explicitly confirm this swap is intentional in the PR body.
 *
 * Note: `r:`-prefixed strings are rejected (mirrors Rust
 * validate_bare_room_id_no_opaque). The guard is explicit at function entry
 * to survive any future branch that might consume `r:` strings.
 */
export function isValidRoomId(s: string): boolean {
  // Explicit `r:` rejection — mirrors Rust validate_bare_room_id_no_opaque.
  // Length-only fall-through would also reject current `r:` forms, but an
  // explicit guard hardens against future branches added below.
  if (s.startsWith('r:')) return false;
  // 9-char bare form — structural check only
  if (/^[A-HJ-NP-Z]{4}-[0-9]{4}$/.test(s)) return true;
  // 10-char typed form — structural check + Luhn verification
  if (/^[A-HJ-NP-Z]{4}-[0-9]{4}[0-9A-HJ-NP-Z]$/.test(s)) {
    return verifyChecksum(s).ok;
  }
  // 22-char opaque base64url
  if (OPAQUE_RE.test(s)) return true;
  return false;
}

/**
 * Map a single uppercase letter to 'group' if it is in GROUP_FIRST_LETTERS,
 * or null otherwise.
 *
 * Returns null for: I, O (not in the 24-letter alphabet), lowercase letters,
 * digits, and all letters outside the group segment.
 */
export function kindFromFirstLetter(letter: string): 'group' | null {
  return GROUP_FIRST_LETTERS.has(letter) ? 'group' : null;
}

/**
 * Parse a room code / ID string into its kind and bare roomId.
 *
 * Priority order (most specific first):
 *   1. 22-char base64url → kind: 'opaque' (roomId = the 22-char branded RoomId)
 *   2. 9-char bare 'AAAA-0000' → kind: 'legacy-bare' (roomId = branded RoomId)
 *   3. 10-char typed 'AAAA-0000C' + Luhn OK + G-first → kind: 'group'
 *      (roomId = 9-char payload without checksum, branded RoomId)
 *   4. Otherwise → null
 *
 * Return type: roomId is the branded `RoomId` in all success branches, including
 * 'opaque' (brand was widened in brands.ts to accept all three ADR-0005 forms).
 *
 * @param code - The string to parse. 'r:'-prefixed inputs are rejected.
 * @returns { roomId: RoomId, kind } on success, or null on unrecognised form.
 */
export function parseRoomCode(code: string): { roomId: RoomId; kind: RoomKind } | null {
  // Explicit `r:` rejection — see isValidRoomId comment for rationale.
  if (code.startsWith('r:')) return null;

  // 1. 22-char opaque base64url
  if (code.length === 22 && OPAQUE_RE.test(code)) {
    return { roomId: asRoomId(code), kind: 'opaque' };
  }

  // 2. 9-char legacy bare form
  if (code.length === 9) {
    if (!isValidRoomId(code)) return null;
    return { roomId: asRoomId(code), kind: 'legacy-bare' };
  }

  // 3. 10-char typed group code
  if (code.length === 10) {
    const result = verifyChecksum(code);
    if (!result.ok) return null;
    if (!isValidRoomId(result.payload)) return null;
    // Only G-letter first → group kind (ADR-0005: other letters not assigned)
    // charAt(0) returns '' on empty string — safe for Set.has (won't match any letter).
    if (!GROUP_FIRST_LETTERS.has(result.payload.charAt(0))) return null;
    return { roomId: asRoomId(result.payload), kind: 'group' };
  }

  return null;
}
