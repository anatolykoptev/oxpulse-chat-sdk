/**
 * brands.ts — URL-bearing branded identifier types for ADR-0005 room IDs.
 *
 * Contains only the three brands that appear directly in URL paths:
 *   RoomId, ShortId, ShortLinkAlias.
 *
 * Non-URL brands (PubkeyShort, Handle, PartnerOrigin) remain in
 * web/src/lib/routes/types.ts until a future wave moves them.
 *
 * Validation split (intentional, documented):
 *   isValidRoomIdShape() — structural check only (length + alphabet).
 *   isValidRoomId()      — full semantic check including Luhn verification for
 *                          10-char typed codes. Available from ./parse.js (W5.4).
 *
 * Plan: docs/superpowers/plans/2026-05-22-url-contract-extract-plan.md W5.2
 * ADR:  docs/adr/0005-heterogeneous-room-urls.md
 */

import { BARE_LENGTH, TYPED_LENGTH, OPAQUE_LENGTH } from './constants.js';

declare const __brand: unique symbol;

// ---------------------------------------------------------------------------
// RoomId
// ---------------------------------------------------------------------------

/**
 * RoomId — branded type for a validated room identifier (any ADR-0005 form).
 *
 * Accepts three shapes (ADR-0005 brand widening — PR #1234 MAJOR):
 *   - Bare 9-char:     `AAAA-0000`           (legacy, no checksum)
 *   - Typed 10-char:   `AAAA-0000C`          (group code with Luhn checksum)
 *   - Opaque 22-char:  `[A-Za-z0-9_-]{22}`  (1to1/burner/sealed share-by-link)
 *
 * Structural validation: isValidRoomIdShape() (this module).
 * Full semantic validation (Luhn check for 10-char form): isValidRoomId() and
 * parseRoomCode() from ./parse.js — available as of W5.4.
 */
export type RoomId = string & { readonly [__brand]: 'RoomId' };

/**
 * Structural-only shape check for a potential RoomId string.
 *
 * Accepts the three ADR-0005 length+alphabet shapes without performing
 * Luhn checksum verification. Sufficient as the trust-boundary guard for the
 * brand cast. For full semantic checks use isValidRoomId() from ./parse.js.
 *
 * 9-char bare:    /^[A-HJ-NP-Z]{4}-[0-9]{4}$/
 * 10-char typed:  /^[A-HJ-NP-Z]{4}-[0-9]{4}[0-9A-HJ-NP-Z]$/
 * 22-char opaque: /^[A-Za-z0-9_-]{22}$/
 *
 * @internal Not exported — used only by asRoomId / tryAsRoomId.
 */
function isValidRoomIdShape(s: string): boolean {
  if (s.length === BARE_LENGTH) {
    return /^[A-HJ-NP-Z]{4}-[0-9]{4}$/.test(s);
  }
  if (s.length === TYPED_LENGTH) {
    return /^[A-HJ-NP-Z]{4}-[0-9]{4}[0-9A-HJ-NP-Z]$/.test(s);
  }
  if (s.length === OPAQUE_LENGTH) {
    return /^[A-Za-z0-9_-]{22}$/.test(s);
  }
  return false;
}

/**
 * Brand a string as RoomId after structural shape validation.
 *
 * Accepts three ADR-0005 shapes (PR #1234 MAJOR — brand widened):
 *   - 9-char bare `AAAA-0000` (legacy)
 *   - 10-char typed `AAAA-0000C` (group code with Luhn checksum)
 *   - 22-char opaque `[A-Za-z0-9_-]{22}` (1to1/burner/sealed)
 *
 * Note: Luhn checksum validity for 10-char codes is NOT checked here (structural cast only).
 * For full semantic validation use isValidRoomId() or parseRoomCode() from ./parse.js (W5.4).
 *
 * Use parseRoomCode() when the specific room kind is needed at the call site.
 *
 * @throws TypeError if `s` does not match any ADR-0005 RoomId shape.
 */
export function asRoomId(s: string): RoomId {
  if (!isValidRoomIdShape(s)) throw new TypeError(`invalid RoomId: ${s}`);
  return s as RoomId;
}

/**
 * Returns the branded RoomId if `s` matches any ADR-0005 shape, null otherwise.
 */
export function tryAsRoomId(s: string): RoomId | null {
  return isValidRoomIdShape(s) ? (s as RoomId) : null;
}

// ---------------------------------------------------------------------------
// ShortId
// ---------------------------------------------------------------------------

/**
 * ShortId — branded type for opaque alphanumeric short identifiers.
 *
 * Shape: alphanumeric only (`^[A-Za-z0-9]{4,}$`), minimum 4 chars.
 * Used for session IDs, invite tokens, and similar opaque short codes that
 * appear as path segments in URLs.
 */
export type ShortId = string & { readonly [__brand]: 'ShortId' };

/** @internal */
const SHORT_ID_RE = /^[A-Za-z0-9]{4,}$/;

/**
 * Brand a string as ShortId after validation.
 * @throws TypeError if `s` does not match `^[A-Za-z0-9]{4,}$`.
 */
export function asShortId(s: string): ShortId {
  if (!SHORT_ID_RE.test(s)) throw new TypeError(`invalid ShortId: ${s}`);
  return s as ShortId;
}

/**
 * Returns the branded ShortId if `s` matches the shape, null otherwise.
 */
export function tryAsShortId(s: string): ShortId | null {
  return SHORT_ID_RE.test(s) ? (s as ShortId) : null;
}

// ---------------------------------------------------------------------------
// ShortLinkAlias
// ---------------------------------------------------------------------------

/**
 * ShortLinkAlias — branded type for the `/s/<alias>` short-link URL space.
 *
 * Shape: 4-6 alphanumeric chars (`^[A-Za-z0-9]{4,6}$`), matching the
 * server-side authority in crates/server/src/alias_resolver/alphabet.rs
 * (ALIAS_LEN_MIN..ALIAS_LEN_MAX = 4..6). The matching redirect-rule regex
 * in web/src/lib/routes/redirect/table.ts (shortAliasStub) and the existing
 * brand declaration in web/src/lib/routes/types.ts are in sync at {4,6}.
 *
 * Server alias resolution shipped in W4 (PR #1384). The brand validation is live:
 * any string entering the type must match the alias shape.
 *
 * @see crates/server/src/alias_resolver/alphabet.rs (canonical authority)
 */
export type ShortLinkAlias = string & { readonly [__brand]: 'ShortLinkAlias' };

/**
 * @internal Mirrors crates/server/src/alias_resolver/alphabet.rs
 * (ALIAS_LEN_MIN..ALIAS_LEN_MAX = 4..6). Once W5.7 wires consumers, this is
 * the single source of truth for the alias-shape regex; the redirect-rule
 * regex and types.ts brand should both derive from here.
 */
const SHORT_LINK_ALIAS_RE = /^[A-Za-z0-9]{4,6}$/;

/**
 * Validate and brand a short-link alias string.
 * @throws TypeError if `s` does not match `^[A-Za-z0-9]{4,6}$`.
 */
export function asShortLinkAlias(s: string): ShortLinkAlias {
  if (!SHORT_LINK_ALIAS_RE.test(s)) throw new TypeError(`invalid ShortLinkAlias: ${s}`);
  return s as ShortLinkAlias;
}

/**
 * Returns the branded alias if `s` matches the alias shape, null otherwise.
 */
export function tryAsShortLinkAlias(s: string): ShortLinkAlias | null {
  return SHORT_LINK_ALIAS_RE.test(s) ? (s as ShortLinkAlias) : null;
}
