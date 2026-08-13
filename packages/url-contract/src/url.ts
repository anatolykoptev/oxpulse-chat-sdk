/**
 * url.ts — room URL construction and parsing helpers.
 *
 * Completes the "URL contract" domain: the package could generate and parse
 * room CODES, but not full room URLs. This module adds builders and parsers
 * for the URL shapes currently used by oxpulse-chat.
 *
 * # URL shapes (mirrors web/src/lib/routes/paths.ts + share.ts)
 *
 *   1:1 call:       <origin>/<roomId>[#<joinSecret>.<hostPubkey>]
 *   Group call:     <origin>/r/<roomId>
 *   Burner chat:    <origin>/c/<roomId>#k=<base64url-key>
 *   Sealed 1:1:     <origin>/m/<roomId>
 *   Short-link:     <origin>/s/<alias>
 *
 * The `/r/` route is also used by the SvelteKit `/r/[roomId]` page for group
 * rooms. The `/g/[roomId]` route is the group-chat page (newer UI); both
 * coexist — `/r/` for the call-focused group view, `/g/` for the chat-focused
 * group view. This module supports `/r/` (the canonical share-URL form from
 * share.ts); `/g/` is a UI-internal route not used for share links.
 *
 * # Query vs fragment contract (ADR-0002)
 *
 * Query params are SERVER-VISIBLE (logged by partner-edge, in HTTP referer).
 * Only non-sensitive flags (audioOnly) go there.
 * Fragment is CLIENT-ONLY per RFC 3986 — E2EE secrets go here and nowhere else.
 *
 * ADR-0002: docs/adr/0002-url-fragment-secrets.md (oxpulse-chat repo)
 * ADR-0005: docs/adr/ADR-0005-heterogeneous-room-urls.md
 */

import { parseRoomCode, type RoomKind } from './parse.js';
import { tryAsRoomId, tryAsShortLinkAlias, type RoomId, type ShortLinkAlias } from './brands.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Options for {@link buildCall1to1Url}.
 * Query is server-visible; fragment is client-only.
 */
export interface Call1to1UrlOptions {
  /** Server-visible query params. */
  query?: { audioOnly?: boolean };
  /** Client-only fragment: join secret + expected host pubkey. */
  fragment?: { joinSecret: string; expectedHostPubkey: string };
}

/**
 * Parsed 1:1 call URL fragment.
 */
export interface Call1to1Fragment {
  joinSecret: string;
  expectedHostPubkey: string;
}

/**
 * Parsed burner chat URL fragment.
 */
export interface BurnerFragment {
  /** base64url key material. */
  fragB64: string;
}

/**
 * Result of parsing a room URL.
 */
export interface ParsedRoomUrl {
  /** The room ID extracted from the URL path. */
  roomId: RoomId;
  /** The room kind resolved by `parseRoomCode`. */
  kind: RoomKind;
  /** The route prefix: '' for 1:1, '/r/' for group, '/c/' for burner, '/m/' for sealed. */
  routePrefix: string;
  /** 1:1 call fragment (joinSecret.hostPubkey), if present. */
  callFragment?: Call1to1Fragment;
  /** Burner chat fragment (#k=<base64url>), if present. */
  burnerFragment?: BurnerFragment;
  /** Query params parsed from the URL. */
  query?: { audioOnly?: boolean };
}

// ── 1:1 call URL ─────────────────────────────────────────────────────────────

/**
 * Build the canonical 1:1 call share URL.
 *
 * Path: `<origin>/<roomId>` (bare-root, no prefix).
 * Fragment format: `#<joinSecret>.<expectedHostPubkey>` (both base64url/hex).
 * Query: `?audio=1` for audio-only (server-visible).
 *
 * @secret-carrier fragment (#joinSecret.expectedHostPubkey)
 */
export function buildCall1to1Url(
  origin: string,
  roomId: RoomId,
  opts: Call1to1UrlOptions = {},
): string {
  const base = origin.replace(/\/$/, '');
  let url = `${base}/${encodeURIComponent(roomId)}`;
  if (opts.query?.audioOnly) {
    url += '?audio=1';
  }
  if (opts.fragment) {
    url += `#${encodeURIComponent(opts.fragment.joinSecret)}.${encodeURIComponent(opts.fragment.expectedHostPubkey)}`;
  }
  return url;
}

// ── Group call URL ───────────────────────────────────────────────────────────

/**
 * Build the canonical group call share URL.
 *
 * Path: `<origin>/r/<roomId>`.
 * No fragment — group calls use server-side membership, not a fragment-carried secret.
 *
 * @secret-carrier none
 */
export function buildGroupCallUrl(origin: string, roomId: RoomId): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/r/${encodeURIComponent(roomId)}`;
}

// ── Burner chat URL ──────────────────────────────────────────────────────────

/**
 * Build the canonical burner-chat share URL with the fragment-carried key.
 *
 * Path: `<origin>/c/<roomId>`.
 * Fragment: `#k=<base64url-key>` (client-only, never sent to server).
 *
 * @secret-carrier fragment (#k=<base64url>)
 */
export function buildBurnerChatUrl(
  origin: string,
  roomId: RoomId,
  fragB64Url: string,
): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/c/${encodeURIComponent(roomId)}#k=${encodeURIComponent(fragB64Url)}`;
}

// ── Sealed 1:1 chat URL ──────────────────────────────────────────────────────

/**
 * Build the canonical sealed 1:1 chat URL.
 *
 * Path: `<origin>/m/<roomId>`.
 * No fragment — sealed chats use server-side key exchange.
 *
 * @secret-carrier none
 */
export function buildSealedChatUrl(origin: string, roomId: RoomId): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/m/${encodeURIComponent(roomId)}`;
}

// ── Short-link URL ───────────────────────────────────────────────────────────

/**
 * Build a short-link URL: `<origin>/s/<alias>`.
 *
 * The alias must be a valid `ShortLinkAlias` (4-6 alphanumeric chars).
 *
 * @throws TypeError if `origin` is empty or `alias` is not a valid ShortLinkAlias.
 */
export function buildShortLinkUrl(origin: string, alias: ShortLinkAlias): string {
  if (!origin) throw new TypeError('buildShortLinkUrl: origin is required');
  const validated = tryAsShortLinkAlias(alias);
  if (!validated) throw new TypeError(`buildShortLinkUrl: invalid ShortLinkAlias: ${alias}`);
  const base = origin.replace(/\/$/, '');
  return `${base}/s/${encodeURIComponent(alias)}`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a room URL into its components.
 *
 * Recognises the four route prefixes:
 *   - `/<roomId>`      → 1:1 call (bare-root)
 *   - `/r/<roomId>`    → group call
 *   - `/c/<roomId>`    → burner chat
 *   - `/m/<roomId>`    → sealed 1:1 chat
 *
 * Extracts fragments:
 *   - `#<secret>.<pubkey>` → 1:1 call fragment
 *   - `#k=<base64url>`     → burner chat fragment
 *
 * Extracts query:
 *   - `?audio=1` → audioOnly
 *
 * @param url - The URL string or URL object to parse.
 * @returns `{ roomId, kind, routePrefix, ... }` on success, or `null` if the
 *   URL does not match a room-URL shape or the room ID is invalid.
 */
export function parseRoomUrl(url: string | URL): ParsedRoomUrl | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);

  // Route prefix detection: /r/, /c/, /m/ have a prefix; bare-root has none.
  let routePrefix = '';
  let roomIdStr: string | null = null;

  if (pathParts.length >= 2) {
    const prefix = pathParts[0]!;
    if (prefix === 'r' || prefix === 'c' || prefix === 'm') {
      routePrefix = `/${prefix}/`;
      roomIdStr = decodeURIComponent(pathParts[1]!);
    }
  }
  if (roomIdStr === null && pathParts.length >= 1) {
    // Bare-root: /<roomId> (1:1 call)
    routePrefix = '';
    roomIdStr = decodeURIComponent(pathParts[0]!);
  }

  if (!roomIdStr) return null;

  const codeResult = parseRoomCode(roomIdStr);
  if (!codeResult) return null;

  // Parse fragment
  const hash = parsed.hash.slice(1); // strip leading '#'
  let callFragment: Call1to1Fragment | undefined;
  let burnerFragment: BurnerFragment | undefined;

  if (hash) {
    if (hash.startsWith('k=')) {
      // Burner: #k=<base64url>
      const fragB64 = decodeURIComponent(hash.slice(2));
      if (fragB64.length > 0) {
        burnerFragment = { fragB64 };
      }
    } else {
      // 1:1 call: #<secret>.<pubkey>
      const dot = hash.indexOf('.');
      if (dot > 0 && dot < hash.length - 1) {
        callFragment = {
          joinSecret: decodeURIComponent(hash.slice(0, dot)),
          expectedHostPubkey: decodeURIComponent(hash.slice(dot + 1)),
        };
      }
    }
  }

  // Parse query
  let query: { audioOnly?: boolean } | undefined;
  const audioOnly = parsed.searchParams.get('audio') === '1';
  if (audioOnly) {
    query = { audioOnly: true };
  }

  return {
    roomId: codeResult.roomId,
    kind: codeResult.kind,
    routePrefix,
    callFragment,
    burnerFragment,
    query,
  };
}

/**
 * Parse a `#<secret>.<pubkey>` 1:1 call invite fragment.
 *
 * Standalone parser for callers that already have the fragment string and
 * don't need full URL parsing. Mirrors `parseCallShareFragment` from
 * `web/src/lib/routes/parse.ts`.
 *
 * @param fragment - The fragment string (with or without leading '#').
 * @returns `{ joinSecret, expectedHostPubkey }` or null if malformed.
 */
export function parseCallFragment(fragment: string): Call1to1Fragment | null {
  if (!fragment) return null;
  const clean = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const dot = clean.indexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return null;
  return {
    joinSecret: clean.slice(0, dot),
    expectedHostPubkey: clean.slice(dot + 1),
  };
}

/**
 * Parse a `#k=<base64url>` burner-chat fragment.
 *
 * Standalone parser for callers that already have the fragment string.
 * Mirrors `parseBurnerFragment` from `web/src/lib/routes/parse.ts`.
 *
 * @param fragment - The fragment string (with or without leading '#').
 * @returns `{ fragB64 }` or null if malformed.
 */
export function parseBurnerFragment(fragment: string): BurnerFragment | null {
  if (!fragment) return null;
  const clean = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!clean.startsWith('k=')) return null;
  const payload = clean.slice(2);
  if (payload.length === 0) return null;
  return { fragB64: payload };
}

/**
 * Build a `#<secret>.<pubkey>` room join fragment string (without leading '#').
 *
 * Mirrors `buildRoomFragment` from `web/src/lib/room-link.ts`.
 */
export function buildRoomFragment(secretB64: string, pubkeyB64: string): string {
  return `${secretB64}.${pubkeyB64}`;
}

/**
 * Parse a `#<secret>.<pubkey>` room join fragment (without the `k=` prefix).
 *
 * Mirrors `parseRoomFragment` from `web/src/lib/room-link.ts`.
 *
 * @param fragment - The fragment string (with or without leading '#').
 * @returns `{ secret, hostPubkey }` or null if malformed.
 */
export function parseRoomFragment(
  fragment: string,
): { secret: string; hostPubkey: string } | null {
  if (!fragment) return null;
  const clean = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const dotIndex = clean.indexOf('.');
  if (dotIndex <= 0 || dotIndex === clean.length - 1) return null;
  return {
    secret: clean.slice(0, dotIndex),
    hostPubkey: clean.slice(dotIndex + 1),
  };
}
