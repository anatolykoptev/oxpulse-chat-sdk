import { describe, it, expect } from 'vitest';
import {
  asRoomId, tryAsRoomId,
  asShortId, tryAsShortId,
  asShortLinkAlias, tryAsShortLinkAlias,
} from '../brands.js';

// ---------------------------------------------------------------------------
// RoomId — structural shape check (no Luhn validation here, see roomcode.ts)
// ---------------------------------------------------------------------------

describe('RoomId', () => {
  it('accepts 9-char bare form AAAA-0000', () => {
    expect(asRoomId('ABCD-1234')).toBe('ABCD-1234');
    expect(asRoomId('GHKL-0000')).toBe('GHKL-0000');
  });

  it('accepts 10-char typed form AAAA-0000C', () => {
    // Note: Luhn correctness not checked at this layer — structural check only.
    expect(asRoomId('ABCD-12340')).toBe('ABCD-12340');
    expect(asRoomId('GHKL-0000A')).toBe('GHKL-0000A');
  });

  it('accepts 22-char opaque base64url form', () => {
    expect(asRoomId('ABCDEFGHIJKLMNOPQRSTUa')).toBe('ABCDEFGHIJKLMNOPQRSTUa');
    expect(asRoomId('aBcDeFgHiJkLmNoPqRsTuV')).toBe('aBcDeFgHiJkLmNoPqRsTuV');
    // base64url allows - and _
    expect(asRoomId('ABCDEFGHIJKLMNOPQRSTU-')).toBe('ABCDEFGHIJKLMNOPQRSTU-');
    expect(asRoomId('ABCDEFGHIJKLMNOPQRSTU_')).toBe('ABCDEFGHIJKLMNOPQRSTU_');
  });

  it('accepts 36-char dashed-UUID opaque form (server-minted sdk ids)', () => {
    const uuid = 'a0b4600e-c0f6-4843-98ee-51bb634931c4';
    expect(asRoomId(uuid)).toBe(uuid);
    expect(tryAsRoomId(uuid)).toBe(uuid);
  });

  // The tightening direction must be gated here, not only in parse.test.ts:
  // the catch-all route consumes the BRAND (asRoomId/tryAsRoomId), and a
  // brands-only widening (e.g. [0-9a-fA-F]) would make the brand and the
  // parser silently disagree on the trust boundary.
  it('rejects uppercase-hex UUID (brand matches the parser exactly)', () => {
    const upper = 'A0B4600E-C0F6-4843-98EE-51BB634931C4';
    expect(() => asRoomId(upper)).toThrow(TypeError);
    expect(tryAsRoomId(upper)).toBeNull();
  });

  it('rejects 36-char non-UUID dash placement', () => {
    expect(tryAsRoomId('a0b4600ec-0f6-4843-98ee-51bb634931c4')).toBeNull();
  });

  it('rejects 8-char (too short for any form)', () => {
    expect(() => asRoomId('ABCD-123')).toThrow(TypeError);
    expect(tryAsRoomId('ABCD-123')).toBeNull();
  });

  it('rejects r: prefix (not a valid shape)', () => {
    expect(() => asRoomId('r:ABCD-1234')).toThrow(TypeError);
    expect(tryAsRoomId('r:ABCD-1234')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(() => asRoomId('')).toThrow(TypeError);
    expect(tryAsRoomId('')).toBeNull();
  });

  it('rejects bare form with I or O (excluded letters)', () => {
    expect(tryAsRoomId('AIOU-0000')).toBeNull();
    expect(tryAsRoomId('ABCO-1234')).toBeNull();
  });

  it('rejects 21-char opaque (one char short)', () => {
    expect(tryAsRoomId('ABCDEFGHIJKLMNOPQRSTa')).toBeNull();
  });

  it('rejects 23-char opaque (one char long)', () => {
    expect(tryAsRoomId('ABCDEFGHIJKLMNOPQRSTUaB')).toBeNull();
  });

  it('rejects opaque with out-of-alphabet chars (+ / = not in base64url)', () => {
    expect(tryAsRoomId('ABCDEFGHIJKLMNOPQRSTU+')).toBeNull();
    expect(tryAsRoomId('ABCDEFGHIJKLMNOPQRSTU/')).toBeNull();
  });

  it('tryAsRoomId returns branded value for valid input', () => {
    expect(tryAsRoomId('ABCD-1234')).toBe('ABCD-1234');
    expect(tryAsRoomId('ABCDEFGHIJKLMNOPQRSTUa')).toBe('ABCDEFGHIJKLMNOPQRSTUa');
  });
});

// ---------------------------------------------------------------------------
// ShortId — opaque alphanumeric, ≥4 chars
// ---------------------------------------------------------------------------

describe('ShortId', () => {
  it('accepts alphanumeric ≥4 chars', () => {
    expect(asShortId('a1b2')).toBe('a1b2');
    expect(asShortId('ABCD')).toBe('ABCD');
    expect(asShortId('abc1234567')).toBe('abc1234567');
  });

  it('rejects 3-char (too short)', () => {
    expect(() => asShortId('abc')).toThrow(TypeError);
    expect(tryAsShortId('abc')).toBeNull();
  });

  it('rejects underscore (not alphanumeric)', () => {
    expect(() => asShortId('abc_123')).toThrow(TypeError);
    expect(tryAsShortId('abc_123')).toBeNull();
  });

  it('rejects dash (not alphanumeric)', () => {
    expect(() => asShortId('a-b-c')).toThrow(TypeError);
    expect(tryAsShortId('a-b-c')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(() => asShortId('')).toThrow(TypeError);
    expect(tryAsShortId('')).toBeNull();
  });

  it('tryAsShortId returns branded value for valid input', () => {
    expect(tryAsShortId('abcd')).toBe('abcd');
    expect(tryAsShortId('abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ShortLinkAlias — /s/<alias> URL space, ^[A-Za-z0-9]{4,6}$
// Authority: crates/server/src/alias_resolver/alphabet.rs (ALIAS_LEN_MIN..MAX = 4..6)
// ---------------------------------------------------------------------------

describe('ShortLinkAlias', () => {
  it('accepts 4-char (minimum length)', () => {
    expect(asShortLinkAlias('AbC1')).toBe('AbC1');
    expect(asShortLinkAlias('xyz9')).toBe('xyz9');
  });

  it('accepts 5-char (middle of range)', () => {
    expect(asShortLinkAlias('abc12')).toBe('abc12');
  });

  it('accepts 6-char (maximum length)', () => {
    expect(asShortLinkAlias('ABCD12')).toBe('ABCD12');
    expect(asShortLinkAlias('abc123')).toBe('abc123');
  });

  it('rejects 3-char (too short)', () => {
    expect(() => asShortLinkAlias('AbC')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('AbC')).toBeNull();
  });

  it('rejects 7-char (too long)', () => {
    expect(() => asShortLinkAlias('ABCD123')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('ABCD123')).toBeNull();
  });

  it('rejects 8-char (too long)', () => {
    expect(() => asShortLinkAlias('ABCD1234')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('ABCD1234')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(() => asShortLinkAlias('')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('')).toBeNull();
  });

  it('rejects dash (non-alphanumeric)', () => {
    expect(() => asShortLinkAlias('AB-12')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('AB-12')).toBeNull();
  });

  it('rejects underscore (non-alphanumeric)', () => {
    expect(() => asShortLinkAlias('ab_de')).toThrow(TypeError);
    expect(tryAsShortLinkAlias('ab_de')).toBeNull();
  });

  it('tryAsShortLinkAlias returns branded value for valid alias', () => {
    expect(tryAsShortLinkAlias('abc12')).toBe('abc12');
    expect(tryAsShortLinkAlias('xyz4')).toBe('xyz4');
  });

  it('tryAsShortLinkAlias returns null for invalid shapes', () => {
    expect(tryAsShortLinkAlias('')).toBeNull();
    expect(tryAsShortLinkAlias('abc')).toBeNull();
    expect(tryAsShortLinkAlias('abcdefg')).toBeNull();
  });
});
