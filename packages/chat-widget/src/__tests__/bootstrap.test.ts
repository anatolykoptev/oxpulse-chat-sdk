/**
 * bootstrap.test.ts — TDD RED phase
 *
 * Tests: JWT origin check logic.
 * Cases per W2.1 spec:
 *  1. Valid JWT + matching origin → passes
 *  2. JWT aud_origins ['https://other.com'] + location https://us.com → OriginNotAllowedError
 *  3. JWT aud_origins ['http://localhost:*'] + location http://localhost:3000 → passes
 *  4. Missing aud_origins (pre-W1.1 JWT) → warn + pass-through (backwards compat)
 *  5. Empty aud_origins → deny
 *  6. *.example.com wildcard — matches subdomain, not root
 *  7. JWT_MALFORMED on invalid token structure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeJwtPayload, matchOriginPattern, checkOrigin } from '../bootstrap.js';
import { WidgetError, OriginNotAllowedError } from '../types.js';
import type { WidgetConfig } from '../types.js';

// ── Helper: build a minimal JWT with a given payload ─────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

function makeConfig(overrides: Partial<WidgetConfig> & { jwt: string }): WidgetConfig {
  return {
    appId: 'test-app',
    roomId: 'test-room',
    ...overrides,
  };
}

// ── decodeJwtPayload ──────────────────────────────────────────────────────────

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const jwt = makeJwt({ aud_origins: ['https://example.com'], sub: 'user1' });
    const payload = decodeJwtPayload(jwt);
    expect(payload.aud_origins).toEqual(['https://example.com']);
    expect(payload['sub']).toBe('user1');
  });

  it('throws JWT_MALFORMED for a non-JWT string', () => {
    expect(() => decodeJwtPayload('not.a.jwt.with.too.many.parts')).toThrow(WidgetError);
  });

  it('throws JWT_MALFORMED for a 2-part token', () => {
    expect(() => decodeJwtPayload('only.twoparts')).toThrow(WidgetError);
  });

  it('throws JWT_MALFORMED for invalid base64 payload', () => {
    expect(() => decodeJwtPayload('hdr.!!!invalid_base64!!!.sig')).toThrow(WidgetError);
  });
});

// ── matchOriginPattern ────────────────────────────────────────────────────────

describe('matchOriginPattern', () => {
  it('exact match returns true', () => {
    expect(matchOriginPattern('https://example.com', 'https://example.com')).toBe(true);
  });

  it('different origin returns false', () => {
    expect(matchOriginPattern('https://other.com', 'https://example.com')).toBe(false);
  });

  it('http:// does not match https://', () => {
    expect(matchOriginPattern('http://example.com', 'https://example.com')).toBe(false);
  });

  it('port wildcard http://localhost:* matches http://localhost:3000', () => {
    expect(matchOriginPattern('http://localhost:3000', 'http://localhost:*')).toBe(true);
  });

  it('port wildcard http://localhost:* matches http://localhost:5173', () => {
    expect(matchOriginPattern('http://localhost:5173', 'http://localhost:*')).toBe(true);
  });

  it('port wildcard does not match different hostname', () => {
    expect(matchOriginPattern('http://remotehost:3000', 'http://localhost:*')).toBe(false);
  });

  it('*.example.com matches foo.example.com', () => {
    expect(matchOriginPattern('https://foo.example.com', 'https://*.example.com')).toBe(true);
  });

  it('*.example.com does NOT match example.com (root)', () => {
    expect(matchOriginPattern('https://example.com', 'https://*.example.com')).toBe(false);
  });

  it('*.example.com does NOT match other.com', () => {
    expect(matchOriginPattern('https://other.com', 'https://*.example.com')).toBe(false);
  });
});

// ── checkOrigin ───────────────────────────────────────────────────────────────

describe('checkOrigin', () => {
  // Stub window.location.origin for each test
  const originalLocation = globalThis.location;

  function setOrigin(origin: string): void {
    Object.defineProperty(globalThis, 'location', {
      value: { ...originalLocation, origin, hostname: new URL(origin).hostname },
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('valid JWT + matching origin → passes', async () => {
    setOrigin('https://example.com');
    const jwt = makeJwt({ aud_origins: ['https://example.com'] });
    const result = await checkOrigin(makeConfig({ jwt }));
    expect(result.allowed).toBe(true);
    expect(result.matchedPattern).toBe('https://example.com');
  });

  it('JWT aud_origins [https://other.com] + location https://us.com → OriginNotAllowedError', async () => {
    setOrigin('https://us.com');
    const jwt = makeJwt({ aud_origins: ['https://other.com'] });
    await expect(checkOrigin(makeConfig({ jwt }))).rejects.toBeInstanceOf(OriginNotAllowedError);
  });

  it('JWT aud_origins [http://localhost:*] + location http://localhost:3000 → passes', async () => {
    setOrigin('http://localhost:3000');
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'http://localhost:3000', hostname: 'remotehost' }, // not localhost hostname → no dev shortcut
      writable: true,
      configurable: true,
    });
    const jwt = makeJwt({ aud_origins: ['http://localhost:*'] });
    const result = await checkOrigin(makeConfig({ jwt, mode: 'iframe' }));
    expect(result.allowed).toBe(true);
  });

  it('missing aud_origins with allowLegacyToken:true → warn + pass-through (backwards compat)', async () => {
    setOrigin('https://whatever.com');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const jwt = makeJwt({ sub: 'user1' }); // no aud_origins
    const result = await checkOrigin(makeConfig({ jwt, allowLegacyToken: true }));
    expect(result.allowed).toBe(true);
    expect(result.matchedPattern).toBe('aud_origins-missing-passthrough');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aud_origins'));
    consoleSpy.mockRestore();
  });

  it('empty aud_origins → OriginNotAllowedError', async () => {
    setOrigin('https://example.com');
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://example.com', hostname: 'example.com' },
      writable: true,
      configurable: true,
    });
    const jwt = makeJwt({ aud_origins: [] });
    await expect(checkOrigin(makeConfig({ jwt }))).rejects.toBeInstanceOf(OriginNotAllowedError);
  });

  it('localhost dev mode passes even without aud_origins match', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'http://localhost:3000', hostname: 'localhost' },
      writable: true,
      configurable: true,
    });
    const jwt = makeJwt({ aud_origins: ['https://production.com'] });
    const result = await checkOrigin(makeConfig({ jwt, mode: 'inline' }));
    expect(result.allowed).toBe(true);
    expect(result.matchedPattern).toBe('localhost-dev');
  });

  it('malformed JWT throws WidgetError JWT_MALFORMED', async () => {
    setOrigin('https://example.com');
    await expect(checkOrigin(makeConfig({ jwt: 'bad-token' }))).rejects.toBeInstanceOf(WidgetError);
  });
});

// ── M4: origin-match parity with crates/sdk/src/origin_match.rs ──────────────
// These tests encode the server's actual semantics (as of W1.1 origin_match.rs).

describe('matchOriginPattern — server parity (M4)', () => {
  // (i) bare subdomain pattern `*.example.com` (no https:// prefix in pattern)
  it('bare *.example.com pattern matches https://app.example.com', () => {
    expect(matchOriginPattern('https://app.example.com', '*.example.com')).toBe(true);
  });

  it('bare *.example.com pattern does NOT match http://app.example.com (https-only)', () => {
    expect(matchOriginPattern('http://app.example.com', '*.example.com')).toBe(false);
  });

  // (ii) single-level subdomain only
  it('*.example.com does NOT match two-level subdomain a.b.example.com', () => {
    expect(matchOriginPattern('https://a.b.example.com', '*.example.com')).toBe(false);
  });

  // (iii) port wildcard: `http://localhost` (no port) does NOT match `http://localhost:*`
  it('http://localhost:* does NOT match http://localhost (no port)', () => {
    expect(matchOriginPattern('http://localhost', 'http://localhost:*')).toBe(false);
  });

  // (iv) subdomain wildcard requires https — widget should mirror server
  it('https://*.example.com pattern (widget-style) matches https://app.example.com', () => {
    expect(matchOriginPattern('https://app.example.com', 'https://*.example.com')).toBe(true);
  });

  it('https://*.example.com pattern does NOT match http://app.example.com', () => {
    expect(matchOriginPattern('http://app.example.com', 'https://*.example.com')).toBe(false);
  });

  // (v) case-insensitive matching
  it('case-insensitive: HTTPS://EXAMPLE.COM matches https://example.com', () => {
    expect(matchOriginPattern('https://example.com', 'HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('case-insensitive: *.Example.COM matches https://app.example.com', () => {
    expect(matchOriginPattern('https://app.example.com', '*.Example.COM')).toBe(true);
  });

  // (vi) malformed entry → never matches (treat as deny)
  it('malformed pattern (no scheme, not a wildcard) → false', () => {
    expect(matchOriginPattern('https://example.com', 'example.com')).toBe(false);
  });

  it('bare * pattern → false (denied by validate)', () => {
    expect(matchOriginPattern('https://anything.com', '*')).toBe(false);
  });
});

// ── M5: default deny on missing aud_origins ───────────────────────────────────

describe('checkOrigin — M5 default deny', () => {
  const originalLocation = globalThis.location;

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('missing aud_origins with allowLegacyToken:false (default) → OriginNotAllowedError', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://example.com', hostname: 'example.com' },
      writable: true,
      configurable: true,
    });
    const jwt = makeJwt({ sub: 'user1' }); // no aud_origins
    // Must NOT warn + pass through — must DENY
    await expect(checkOrigin(makeConfig({ jwt }))).rejects.toBeInstanceOf(WidgetError);
  });

  it('missing aud_origins with allowLegacyToken:true → warns + passes through', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://example.com', hostname: 'example.com' },
      writable: true,
      configurable: true,
    });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const jwt = makeJwt({ sub: 'user1' }); // no aud_origins
    const result = await checkOrigin(makeConfig({ jwt, allowLegacyToken: true }));
    expect(result.allowed).toBe(true);
    expect(result.matchedPattern).toBe('aud_origins-missing-passthrough');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aud_origins'));
    consoleSpy.mockRestore();
  });
});

// ── MINOR: exp claim check ────────────────────────────────────────────────────

describe('decodeJwtPayload — exp claim', () => {
  it('expired JWT (exp in the past) throws WidgetError JWT_EXPIRED', () => {
    const expiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 100, sub: 'u1' });
    expect(() => decodeJwtPayload(expiredJwt)).toThrow(WidgetError);
  });

  it('non-expired JWT (exp in the future) does not throw', () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' });
    expect(() => decodeJwtPayload(validJwt)).not.toThrow();
  });
});
