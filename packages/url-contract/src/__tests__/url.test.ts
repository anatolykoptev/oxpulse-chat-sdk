/**
 * Tests for url-contract url.ts — room URL construction and parsing (#325).
 *
 * URL shapes (mirrors web/src/lib/routes/paths.ts + share.ts):
 *   1:1 call:    <origin>/<roomId>[#<joinSecret>.<hostPubkey>][?audio=1]
 *   Group call:  <origin>/r/<roomId>
 *   Burner chat: <origin>/c/<roomId>#k=<base64url-key>
 *   Sealed 1:1:  <origin>/m/<roomId>
 *   Short-link:  <origin>/s/<alias>
 */

import { describe, it, expect } from 'vitest';
import {
  buildCall1to1Url,
  buildGroupCallUrl,
  buildBurnerChatUrl,
  buildSealedChatUrl,
  buildShortLinkUrl,
  parseRoomUrl,
  parseCallFragment,
  parseBurnerFragment,
  buildRoomFragment,
  parseRoomFragment,
} from '../url.js';
import { generateRoomCode, generateOpaqueRoomId, generateShortLinkAlias } from '../generators.js';
import { asRoomId, asShortLinkAlias } from '../brands.js';

const ORIGIN = 'https://app.oxpulse.chat';

// ── buildCall1to1Url ─────────────────────────────────────────────────────────

describe('buildCall1to1Url', () => {
  it('builds a bare-root 1:1 call URL without fragment', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId);
    expect(url).toBe(`${ORIGIN}/${roomId}`);
  });

  it('builds a 1:1 call URL with join secret + host pubkey fragment', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId, {
      fragment: { joinSecret: 'aBcDeFgHiJkLmNoPqRsTuV', expectedHostPubkey: '0123456789abcdef' },
    });
    expect(url).toBe(`${ORIGIN}/${roomId}#aBcDeFgHiJkLmNoPqRsTuV.0123456789abcdef`);
  });

  it('builds a 1:1 call URL with audio=1 query', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId, { query: { audioOnly: true } });
    expect(url).toBe(`${ORIGIN}/${roomId}?audio=1`);
  });

  it('builds a 1:1 call URL with both query and fragment', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId, {
      query: { audioOnly: true },
      fragment: { joinSecret: 'secret', expectedHostPubkey: 'pubkey' },
    });
    expect(url).toBe(`${ORIGIN}/${roomId}?audio=1#secret.pubkey`);
  });

  it('strips trailing slash from origin', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(`${ORIGIN}/`, roomId);
    expect(url).toBe(`${ORIGIN}/${roomId}`);
  });
});

// ── buildGroupCallUrl ────────────────────────────────────────────────────────

describe('buildGroupCallUrl', () => {
  it('builds a /r/<roomId> group call URL', () => {
    const code = generateRoomCode('group');
    const roomId = asRoomId(code);
    const url = buildGroupCallUrl(ORIGIN, roomId);
    expect(url).toBe(`${ORIGIN}/r/${code}`);
  });

  it('strips trailing slash from origin', () => {
    const roomId = asRoomId(generateRoomCode('group'));
    const url = buildGroupCallUrl(`${ORIGIN}/`, roomId);
    expect(url).toBe(`${ORIGIN}/r/${roomId}`);
  });
});

// ── buildBurnerChatUrl ───────────────────────────────────────────────────────

describe('buildBurnerChatUrl', () => {
  it('builds a /c/<roomId>#k=<key> burner chat URL', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildBurnerChatUrl(ORIGIN, roomId, 'aBcDeFgHiJkLmNoPqRsTuV');
    expect(url).toBe(`${ORIGIN}/c/${roomId}#k=aBcDeFgHiJkLmNoPqRsTuV`);
  });

  it('strips trailing slash from origin', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildBurnerChatUrl(`${ORIGIN}/`, roomId, 'key');
    expect(url).toBe(`${ORIGIN}/c/${roomId}#k=key`);
  });
});

// ── buildSealedChatUrl ───────────────────────────────────────────────────────

describe('buildSealedChatUrl', () => {
  it('builds a /m/<roomId> sealed chat URL', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildSealedChatUrl(ORIGIN, roomId);
    expect(url).toBe(`${ORIGIN}/m/${roomId}`);
  });
});

// ── buildShortLinkUrl ────────────────────────────────────────────────────────

describe('buildShortLinkUrl', () => {
  it('builds a /s/<alias> short-link URL', () => {
    const alias = asShortLinkAlias('xA3kP');
    const url = buildShortLinkUrl(ORIGIN, alias);
    expect(url).toBe(`${ORIGIN}/s/xA3kP`);
  });

  it('works with a generated alias', () => {
    const alias = generateShortLinkAlias();
    const url = buildShortLinkUrl(ORIGIN, alias);
    expect(url).toMatch(new RegExp(`^${ORIGIN.replace(/\./g, '\\.')}/s/[A-Za-z0-9]{4,6}$`));
  });

  it('throws TypeError on empty origin', () => {
    const alias = asShortLinkAlias('xA3kP');
    expect(() => buildShortLinkUrl('', alias)).toThrow(TypeError);
  });

  it('throws TypeError on invalid alias', () => {
    expect(() => buildShortLinkUrl(ORIGIN, 'too-long' as unknown as ReturnType<typeof asShortLinkAlias>)).toThrow(TypeError);
  });
});

// ── parseRoomUrl ─────────────────────────────────────────────────────────────

describe('parseRoomUrl', () => {
  it('round-trips a 1:1 call URL (bare-root, no fragment)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId);
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(roomId);
    expect(parsed!.kind).toBe('opaque');
    expect(parsed!.routePrefix).toBe('');
    expect(parsed!.callFragment).toBeUndefined();
    expect(parsed!.burnerFragment).toBeUndefined();
  });

  it('round-trips a 1:1 call URL with fragment', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId, {
      fragment: { joinSecret: 'secret123', expectedHostPubkey: 'pubkey456' },
    });
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.callFragment).toEqual({ joinSecret: 'secret123', expectedHostPubkey: 'pubkey456' });
  });

  it('round-trips a 1:1 call URL with audio=1 query', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildCall1to1Url(ORIGIN, roomId, { query: { audioOnly: true } });
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.query).toEqual({ audioOnly: true });
  });

  it('round-trips a group call URL (/r/)', () => {
    const code = generateRoomCode('group');
    const roomId = asRoomId(code);
    const url = buildGroupCallUrl(ORIGIN, roomId);
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    // parseRoomCode strips the checksum char for group codes → roomId is the
    // 9-char payload, not the 10-char code. The URL path carries the full
    // 10-char code; parseRoomUrl returns the canonical 9-char roomId.
    expect(parsed!.kind).toBe('group');
    expect(parsed!.routePrefix).toBe('/r/');
    expect(parsed!.roomId).toHaveLength(9);
  });

  it('round-trips a burner chat URL (/c/ with #k=)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildBurnerChatUrl(ORIGIN, roomId, 'aBcDeFgHiJkLmNoPqRsTuV');
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(roomId);
    expect(parsed!.routePrefix).toBe('/c/');
    expect(parsed!.burnerFragment).toEqual({ fragB64: 'aBcDeFgHiJkLmNoPqRsTuV' });
  });

  it('round-trips a sealed chat URL (/m/)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = buildSealedChatUrl(ORIGIN, roomId);
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(roomId);
    expect(parsed!.routePrefix).toBe('/m/');
  });

  it('accepts a URL object', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const url = new URL(buildCall1to1Url(ORIGIN, roomId));
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(roomId);
  });

  it('returns null for non-room URL (wrong path)', () => {
    expect(parseRoomUrl(`${ORIGIN}/settings`)).toBeNull();
  });

  it('returns null for URL with invalid room ID', () => {
    expect(parseRoomUrl(`${ORIGIN}/r/garbage`)).toBeNull();
  });

  it('returns null for malformed URL string', () => {
    expect(parseRoomUrl('not-a-url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseRoomUrl('')).toBeNull();
  });

  it('rejects URLs with extra path segments after /r/<roomId>', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/r/${roomId}/extra`)).toBeNull();
  });

  it('rejects URLs with extra path segments after /c/<roomId>', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/c/${roomId}/extra`)).toBeNull();
  });

  it('rejects URLs with extra path segments after /m/<roomId>', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/m/${roomId}/extra`)).toBeNull();
  });

  it('rejects URLs with extra path segments after bare-root /<roomId>', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/${roomId}/extra`)).toBeNull();
  });

  // ── #342: /s/ short-link prefix support ────────────────────────────────────

  it('parses /s/<alias> short-link URLs (#342)', () => {
    const parsed = parseRoomUrl(`${ORIGIN}/s/xA3kP`);
    expect(parsed).not.toBeNull();
    expect(parsed!.routePrefix).toBe('/s/');
    expect(parsed!.alias).toBe('xA3kP');
  });

  it('rejects /s/ with invalid alias (too short)', () => {
    expect(parseRoomUrl(`${ORIGIN}/s/ab`)).toBeNull();
  });

  it('rejects /s/ with invalid alias (too long)', () => {
    expect(parseRoomUrl(`${ORIGIN}/s/abcdefgh`)).toBeNull();
  });

  it('rejects /s/ with non-alphanumeric alias', () => {
    expect(parseRoomUrl(`${ORIGIN}/s/ab_c!`)).toBeNull();
  });

  it('rejects /s/ with fragment', () => {
    expect(parseRoomUrl(`${ORIGIN}/s/xA3kP#k=key`)).toBeNull();
  });

  it('rejects /s/ with query', () => {
    expect(parseRoomUrl(`${ORIGIN}/s/xA3kP?audio=1`)).toBeNull();
  });

  it('buildShortLinkUrl ↔ parseRoomUrl round-trips (#342)', () => {
    const alias = generateShortLinkAlias();
    const url = buildShortLinkUrl(ORIGIN, alias);
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.routePrefix).toBe('/s/');
    expect(parsed!.alias).toBe(alias);
  });

  // ── #343: fragment-route validation ────────────────────────────────────────

  it('rejects call fragment on /c/ route (#343)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/c/${roomId}#secret.pubkey`)).toBeNull();
  });

  it('rejects call fragment on /r/ route (#343)', () => {
    const code = generateRoomCode('group');
    const roomId = asRoomId(code);
    expect(parseRoomUrl(`${ORIGIN}/r/${roomId}#secret.pubkey`)).toBeNull();
  });

  it('rejects call fragment on /m/ route (#343)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/m/${roomId}#secret.pubkey`)).toBeNull();
  });

  it('rejects burner fragment on bare-root route (#343)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/${roomId}#k=key`)).toBeNull();
  });

  it('rejects burner fragment on /r/ route (#343)', () => {
    const code = generateRoomCode('group');
    const roomId = asRoomId(code);
    expect(parseRoomUrl(`${ORIGIN}/r/${roomId}#k=key`)).toBeNull();
  });

  it('rejects burner fragment on /m/ route (#343)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    expect(parseRoomUrl(`${ORIGIN}/m/${roomId}#k=key`)).toBeNull();
  });

  it('accepts call fragment on bare-root (valid combination)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const parsed = parseRoomUrl(`${ORIGIN}/${roomId}#secret.pubkey`);
    expect(parsed).not.toBeNull();
    expect(parsed!.callFragment).toEqual({ joinSecret: 'secret', expectedHostPubkey: 'pubkey' });
  });

  it('accepts burner fragment on /c/ (valid combination)', () => {
    const roomId = asRoomId(generateOpaqueRoomId());
    const parsed = parseRoomUrl(`${ORIGIN}/c/${roomId}#k=keyB64`);
    expect(parsed).not.toBeNull();
    expect(parsed!.burnerFragment).toEqual({ fragB64: 'keyB64' });
  });

  it('legacy bare codes round-trip through bare-root', () => {
    const bare = 'GHJK-1234';
    const roomId = asRoomId(bare);
    const url = buildCall1to1Url(ORIGIN, roomId);
    const parsed = parseRoomUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(bare);
    expect(parsed!.kind).toBe('legacy-bare');
  });
});

// ── parseCallFragment ────────────────────────────────────────────────────────

describe('parseCallFragment', () => {
  it('parses #secret.pubkey', () => {
    const result = parseCallFragment('#secret.pubkey');
    expect(result).toEqual({ joinSecret: 'secret', expectedHostPubkey: 'pubkey' });
  });

  it('parses without leading #', () => {
    const result = parseCallFragment('secret.pubkey');
    expect(result).toEqual({ joinSecret: 'secret', expectedHostPubkey: 'pubkey' });
  });

  it('returns null for empty string', () => {
    expect(parseCallFragment('')).toBeNull();
  });

  it('returns null for no dot separator', () => {
    expect(parseCallFragment('noseparator')).toBeNull();
  });

  it('returns null for dot at start', () => {
    expect(parseCallFragment('.pubkey')).toBeNull();
  });

  it('returns null for dot at end', () => {
    expect(parseCallFragment('secret.')).toBeNull();
  });

  // #354: standalone parsers return LITERAL payload — no percent-decoding.
  it('returns literal payload for percent-encoded values (#354)', () => {
    const result = parseCallFragment('a%2Eb.c');
    expect(result).toEqual({ joinSecret: 'a%2Eb', expectedHostPubkey: 'c' });
  });

  it('returns literal payload for malformed percent-encoding (#354)', () => {
    expect(parseCallFragment('a%.b')).toEqual({ joinSecret: 'a%', expectedHostPubkey: 'b' });
  });
});

// ── parseBurnerFragment ──────────────────────────────────────────────────────

describe('parseBurnerFragment', () => {
  it('parses #k=<base64url>', () => {
    const result = parseBurnerFragment('#k=aBcDeFgHiJkLmNoPqRsTuV');
    expect(result).toEqual({ fragB64: 'aBcDeFgHiJkLmNoPqRsTuV' });
  });

  it('parses without leading #', () => {
    const result = parseBurnerFragment('k=someKey');
    expect(result).toEqual({ fragB64: 'someKey' });
  });

  it('returns null for empty string', () => {
    expect(parseBurnerFragment('')).toBeNull();
  });

  it('returns null for non-k= prefix', () => {
    expect(parseBurnerFragment('#x=stuff')).toBeNull();
  });

  it('returns null for k= with empty payload', () => {
    expect(parseBurnerFragment('k=')).toBeNull();
  });

  // #354: standalone parsers return LITERAL payload — no percent-decoding.
  it('returns literal payload for percent-encoded values (#354)', () => {
    const result = parseBurnerFragment('k=a%2Eb');
    expect(result).toEqual({ fragB64: 'a%2Eb' });
  });

  it('returns literal payload for malformed percent-encoding (#354)', () => {
    expect(parseBurnerFragment('k=%')).toEqual({ fragB64: '%' });
  });
});

// ── buildRoomFragment + parseRoomFragment ────────────────────────────────────

describe('buildRoomFragment + parseRoomFragment', () => {
  it('buildRoomFragment produces secret.pubkey', () => {
    expect(buildRoomFragment('mySecret', 'myPubkey')).toBe('mySecret.myPubkey');
  });

  it('parseRoomFragment round-trips with buildRoomFragment', () => {
    const secret = 'aBcDeFgHiJkLmNoPqRsTuV';
    const pubkey = '0123456789abcdef';
    const fragment = buildRoomFragment(secret, pubkey);
    const parsed = parseRoomFragment(fragment);
    expect(parsed).toEqual({ secret, hostPubkey: pubkey });
  });

  it('parseRoomFragment accepts leading #', () => {
    const result = parseRoomFragment('#secret.pubkey');
    expect(result).toEqual({ secret: 'secret', hostPubkey: 'pubkey' });
  });

  it('parseRoomFragment returns null for empty', () => {
    expect(parseRoomFragment('')).toBeNull();
  });

  it('parseRoomFragment returns null for no dot', () => {
    expect(parseRoomFragment('noseparator')).toBeNull();
  });

  // #354: standalone parsers return LITERAL payload — no percent-decoding.
  it('parseRoomFragment returns literal payload for percent-encoded values (#354)', () => {
    const result = parseRoomFragment('a%2Eb.c');
    expect(result).toEqual({ secret: 'a%2Eb', hostPubkey: 'c' });
  });

  it('parseRoomFragment returns literal payload for malformed percent-encoding (#354)', () => {
    expect(parseRoomFragment('a%.b')).toEqual({ secret: 'a%', hostPubkey: 'b' });
  });
});

// ── Cross-function round-trip ────────────────────────────────────────────────

describe('build + parse cross-function round-trip', () => {
  it('100 random opaque room IDs round-trip through 1:1 call build + parse', () => {
    for (let i = 0; i < 100; i++) {
      const roomId = asRoomId(generateOpaqueRoomId());
      const url = buildCall1to1Url(ORIGIN, roomId);
      const parsed = parseRoomUrl(url);
      expect(parsed, `iteration ${i}`).not.toBeNull();
      expect(parsed!.roomId).toBe(roomId);
    }
  });

  it('100 random group codes round-trip through group call build + parse', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode('group');
      const roomId = asRoomId(code);
      const url = buildGroupCallUrl(ORIGIN, roomId);
      const parsed = parseRoomUrl(url);
      expect(parsed, `iteration ${i}`).not.toBeNull();
      // parseRoomCode strips the checksum → roomId is 9-char payload
      expect(parsed!.kind).toBe('group');
      expect(parsed!.routePrefix).toBe('/r/');
      expect(parsed!.roomId).toHaveLength(9);
    }
  });
});
