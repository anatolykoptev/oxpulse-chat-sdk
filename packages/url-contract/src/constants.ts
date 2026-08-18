/**
 * constants.ts — canonical string-alphabet and length constants for ADR-0005 room IDs.
 *
 * All literals here are the single source of truth for room-code alphabets and
 * length invariants. Consumers (roomcode.ts, canonical.ts) will import from this
 * package in W5.7 once the full extract is wired. Until then these values are
 * intentionally duplicated in web/ — the duplication is tracked and intentional.
 *
 * ADR:  docs/adr/ADR-0005-heterogeneous-room-urls.md
 */

/**
 * The 6 uppercase letters reserved for group-call room codes (ADR-0005).
 * From the 24-letter alphabet (A-HJ-NP-Z, no I/O):
 *   G, H, J, K, L, M — the "group" segment.
 *
 * Other segments (A-F, N-T, U-Z) are not assigned to typed codes — those
 * room kinds now use opaque 22-char base64url IDs.
 *
 * NOTE: defined as a string for pickFromAlphabet(). For membership tests, use
 * GROUP_FIRST_LETTERS (ReadonlySet<string>) which is derived from this value.
 */
export const GROUP_LETTERS = 'GHJKLM';

/**
 * Full 24-letter uppercase alphabet used for room-code letter positions.
 * Excludes I and O (visually confusable with 1 and 0).
 */
export const FULL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 chars, no I/O

/**
 * Decimal digit alphabet used for room-code digit positions.
 */
export const DIGITS = '0123456789'; // 10 chars

/**
 * Rejection-sampling threshold for GROUP_LETTERS (length 6).
 * Largest multiple of 6 that fits in a single byte: floor(256/6)*6 = 252.
 */
export const GROUP_LETTER_THRESHOLD =
  Math.floor(256 / GROUP_LETTERS.length) * GROUP_LETTERS.length; // 252

/**
 * Rejection-sampling threshold for FULL_LETTERS (length 24).
 * Largest multiple of 24 that fits in a single byte: floor(256/24)*24 = 240.
 */
export const FULL_LETTER_THRESHOLD =
  Math.floor(256 / FULL_LETTERS.length) * FULL_LETTERS.length; // 240

/**
 * Rejection-sampling threshold for DIGITS (length 10).
 * Largest multiple of 10 that fits in a single byte: floor(256/10)*10 = 250.
 */
export const DIGIT_THRESHOLD = Math.floor(256 / DIGITS.length) * DIGITS.length; // 250

/**
 * Length of the bare 9-char room code form: `AAAA-0000`.
 * Legacy form — no checksum. Accepted during the ADR-0005 transition window.
 */
export const BARE_LENGTH = 9;

/**
 * Length of the typed 10-char room code form: `AAAA-0000C`.
 * Group-code form with a Luhn mod-34 checksum suffix character.
 */
export const TYPED_LENGTH = 10;

/**
 * Length of the opaque 22-char base64url room ID form.
 * Used for 1to1, burner, and sealed room kinds (share-by-link capability URLs).
 * 16 bytes (128 bits) of CSPRNG entropy, URL-safe base64 without padding.
 */
export const OPAQUE_LENGTH = 22;

/**
 * Length of the dashed-UUID opaque room ID form: 8-4-4-4-12 lowercase hex.
 *
 * The server's sdk-room mint has returned this form since the beginning
 * (uuid::Uuid::new_v4().to_string() — 156 of 164 prod rooms on 2026-08-18),
 * while the URL layer accepted only the 22-char form, so every navigation
 * into an existing sealed chat bounced to '/?invalid_room=1'. Accepted as a
 * fourth shape, kind 'opaque'. Lowercase-only: the Rust uuid crate prints
 * lowercase, and the client stores the server's value verbatim.
 */
export const OPAQUE_UUID_LENGTH = 36;

/**
 * Regex for the dashed-UUID opaque form: 8-4-4-4-12 lowercase hex.
 * Shared by parse.ts (parseRoomCode / isValidRoomId) and brands.ts
 * (isValidRoomIdShape) — one definition, so the parser and the brand cannot
 * drift. If the brand ever narrowed relative to the parser, parseRoomCode's
 * UUID branch would THROW from asRoomId instead of returning null (the only
 * rejection path that would escape a route guard as an exception).
 */
export const OPAQUE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The 6 group-letter uppercase letters as a ReadonlySet — for O(1) membership tests.
 *
 * Derived from GROUP_LETTERS to avoid duplication. This set breaks the circular
 * dependency that previously forced roomcode.ts to define GROUP_LETTERS locally
 * (roomcode.ts → types.ts → canonical.ts → roomcode.ts).
 *
 * Lives here so both roomcode.ts and canonical.ts can import from @oxpulse/url-contract
 * without a cycle. Wired in W5.7.
 */
export const GROUP_FIRST_LETTERS: ReadonlySet<string> = new Set(GROUP_LETTERS);
