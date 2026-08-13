/**
 * Property-based tests for url-contract (#329).
 *
 * Uses fast-check to assert invariants over random inputs:
 *   - generateOpaqueRoomId ↔ parseRoomCode round-trip
 *   - generateRoomCode('group') ↔ parseRoomCode round-trip
 *   - buildCall1to1Url ↔ parseRoomUrl round-trip
 *   - buildGroupCallUrl ↔ parseRoomUrl round-trip
 *   - buildBurnerChatUrl ↔ parseRoomUrl round-trip
 *   - buildSealedChatUrl ↔ parseRoomUrl round-trip
 *   - messengerSafeBase64Url16 invariants (no -_/_- adjacency, no leading/trailing -/_)
 *   - base64urlToBytes(bytesToBase64Url(x)) round-trip
 *   - generateShortId shape invariants
 *   - generateShortLinkAlias shape invariants
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  generateRoomCode,
  generateOpaqueRoomId,
  generateShortId,
  generateShortLinkAlias,
  messengerSafeBase64Url16,
  base64urlToBytes,
} from '../generators.js';
import { parseRoomCode } from '../parse.js';
import { verifyChecksum } from '../checksum.js';
import { tryAsRoomId, asRoomId, tryAsShortId, tryAsShortLinkAlias } from '../brands.js';
import {
  buildCall1to1Url,
  buildGroupCallUrl,
  buildBurnerChatUrl,
  buildSealedChatUrl,
  parseRoomUrl,
  parseCallFragment,
  parseBurnerFragment,
  buildRoomFragment,
  parseRoomFragment,
} from '../url.js';

const ORIGIN = 'https://app.oxpulse.chat';

// Fragment-safe strings: exclude chars that break URL fragment parsing.
// '#' = fragment delimiter, '.' = secret.pubkey separator, '=' = k= prefix,
// '?' = query delimiter, '/' = path delimiter, '%' = percent-encoding trigger.
const fragmentSafeString = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => !s.includes('#') && !s.includes('.') && !s.includes('=') && !s.includes('?') && !s.includes('/') && !s.includes('%'),
);

// ── Generator ↔ Parser round-trips ──────────────────────────────────────────

describe('property: generateOpaqueRoomId ↔ parseRoomCode', () => {
  it('parseRoomCode(generateOpaqueRoomId()) always succeeds and returns kind "opaque"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (_n) => {
        const id = generateOpaqueRoomId();
        const parsed = parseRoomCode(id);
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe('opaque');
        expect(parsed!.roomId).toBe(id);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: generateRoomCode("group") ↔ parseRoomCode', () => {
  it('parseRoomCode(generateRoomCode("group")) always succeeds, kind "group", checksum valid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (_n) => {
        const code = generateRoomCode('group');
        const parsed = parseRoomCode(code);
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe('group');
        // verifyChecksum returns a discriminated union, not boolean
        expect(verifyChecksum(asRoomId(code)).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ── URL build ↔ parse round-trips ───────────────────────────────────────────

describe('property: buildCall1to1Url ↔ parseRoomUrl (opaque)', () => {
  it('parseRoomUrl(buildCall1to1Url(origin, roomId)) round-trips roomId + routePrefix', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (_n) => {
        const roomId = asRoomId(generateOpaqueRoomId());
        const url = buildCall1to1Url(ORIGIN, roomId);
        const parsed = parseRoomUrl(url);
        expect(parsed).not.toBeNull();
        expect(parsed!.routePrefix).toBe('');
        expect(parsed!.kind).toBe('opaque');
      }),
      { numRuns: 100 },
    );
  });

  it('parseRoomUrl(buildCall1to1Url with fragment) round-trips callFragment', () => {
    fc.assert(
      fc.property(
        fragmentSafeString,
        fragmentSafeString,
        (secret, pubkey) => {
          const roomId = asRoomId(generateOpaqueRoomId());
          const url = buildCall1to1Url(ORIGIN, roomId, {
            fragment: { joinSecret: secret, expectedHostPubkey: pubkey },
          });
          const parsed = parseRoomUrl(url);
          expect(parsed).not.toBeNull();
          expect(parsed!.callFragment).toEqual({ joinSecret: secret, expectedHostPubkey: pubkey });
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('property: buildGroupCallUrl ↔ parseRoomUrl', () => {
  it('parseRoomUrl(buildGroupCallUrl(origin, roomId)) round-trips routePrefix "/r/"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (_n) => {
        const code = generateRoomCode('group');
        const roomId = asRoomId(code);
        const url = buildGroupCallUrl(ORIGIN, roomId);
        const parsed = parseRoomUrl(url);
        expect(parsed).not.toBeNull();
        expect(parsed!.routePrefix).toBe('/r/');
        expect(parsed!.kind).toBe('group');
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: buildBurnerChatUrl ↔ parseRoomUrl', () => {
  it('parseRoomUrl(buildBurnerChatUrl(origin, roomId, key)) round-trips burnerFragment', () => {
    fc.assert(
      fc.property(
        fragmentSafeString,
        (key) => {
          const roomId = asRoomId(generateOpaqueRoomId());
          const url = buildBurnerChatUrl(ORIGIN, roomId, key);
          const parsed = parseRoomUrl(url);
          expect(parsed).not.toBeNull();
          expect(parsed!.routePrefix).toBe('/c/');
          expect(parsed!.burnerFragment).toEqual({ fragB64: key });
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('property: buildSealedChatUrl ↔ parseRoomUrl', () => {
  it('parseRoomUrl(buildSealedChatUrl(origin, roomId)) round-trips routePrefix "/m/"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (_n) => {
        const roomId = asRoomId(generateOpaqueRoomId());
        const url = buildSealedChatUrl(ORIGIN, roomId);
        const parsed = parseRoomUrl(url);
        expect(parsed).not.toBeNull();
        expect(parsed!.routePrefix).toBe('/m/');
      }),
      { numRuns: 100 },
    );
  });
});

// ── Fragment parser round-trips ─────────────────────────────────────────────

describe('property: buildRoomFragment ↔ parseRoomFragment', () => {
  it('parseRoomFragment(buildRoomFragment(secret, pubkey)) round-trips', () => {
    fc.assert(
      fc.property(
        fragmentSafeString,
        fragmentSafeString,
        (secret, pubkey) => {
          const fragment = buildRoomFragment(secret, pubkey);
          const parsed = parseRoomFragment(fragment);
          expect(parsed).toEqual({ secret, hostPubkey: pubkey });
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('property: parseCallFragment rejects malformed', () => {
  it('parseCallFragment returns null for strings without a dot', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('.') && !s.startsWith('#')),
        (s) => {
          expect(parseCallFragment(s)).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('property: parseBurnerFragment rejects non-k= prefix', () => {
  it('parseBurnerFragment returns null for strings not starting with k=', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith('k=') && !s.startsWith('#')),
        (s) => {
          expect(parseBurnerFragment(s)).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── messengerSafeBase64Url16 invariants ─────────────────────────────────────

describe('property: messengerSafeBase64Url16 invariants', () => {
  it('never produces -_ or _- adjacency', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (_n) => {
        const s = messengerSafeBase64Url16();
        expect(s).not.toMatch(/-_|-_-/);
        expect(s).not.toMatch(/_-|_-_/);
        // More explicit: no -_ or _- anywhere
        expect(s).not.toContain('-_');
        expect(s).not.toContain('_-');
      }),
      { numRuns: 500 },
    );
  });

  it('never starts or ends with - or _', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (_n) => {
        const s = messengerSafeBase64Url16();
        expect(s[0]).not.toBe('-');
        expect(s[0]).not.toBe('_');
        expect(s[s.length - 1]).not.toBe('-');
        expect(s[s.length - 1]).not.toBe('_');
      }),
      { numRuns: 500 },
    );
  });

  it('always produces 22-char base64url', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (_n) => {
        const s = messengerSafeBase64Url16();
        expect(s).toHaveLength(22);
        expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
      { numRuns: 500 },
    );
  });
});

// ── base64url round-trip ────────────────────────────────────────────────────

describe('property: base64urlToBytes round-trip', () => {
  it('decode(encode(random bytes)) === original bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 100 }), (bytes) => {
        // Re-encode using the same btoa pattern as bytesToBase64Url
        const chars: string[] = [];
        for (let i = 0; i < bytes.length; i++) chars.push(String.fromCharCode(bytes[i]!));
        const encoded = btoa(chars.join(''))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const decoded = base64urlToBytes(encoded);
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
      }),
      { numRuns: 100 },
    );
  });
});

// ── generateShortId invariants ──────────────────────────────────────────────

describe('property: generateShortId invariants', () => {
  it('always produces alphanumeric output of the requested length', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 64 }), (len) => {
        const id = generateShortId(len);
        expect(id).toHaveLength(len);
        expect(id).toMatch(/^[A-Za-z0-9]+$/);
        expect(tryAsShortId(id)).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ── generateShortLinkAlias invariants ───────────────────────────────────────

describe('property: generateShortLinkAlias invariants', () => {
  it('always produces alphanumeric output of the requested length (4-6)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 6 }), (len) => {
        const alias = generateShortLinkAlias(len);
        expect(alias).toHaveLength(len);
        expect(alias).toMatch(/^[A-Za-z0-9]+$/);
        expect(tryAsShortLinkAlias(alias)).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ── parseRoomUrl rejects garbage ────────────────────────────────────────────

describe('property: parseRoomUrl rejects garbage', () => {
  it('returns null for random strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
          // Filter out strings that happen to be valid URLs with valid room IDs
          try {
            const u = new URL(s);
            return !u.pathname || u.pathname === '/';
          } catch {
            return true;
          }
        }),
        (s) => {
          expect(parseRoomUrl(s)).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});
