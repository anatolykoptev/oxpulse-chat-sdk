import { describe, it, expect } from 'vitest';
import {
  encodeIntroMessage,
  decodeIntroMessage,
  verifySessionIdRedundancy,
  IntroMessageSchema,
  type IntroMessage,
} from '../intro-wire.ts';

// ---------------------------------------------------------------------------
// Helpers — build valid 22-char base64url sessionIds and 43-char pubkeys.
// ---------------------------------------------------------------------------

/** Encode raw bytes to base64url (no padding). */
function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A valid 22-char sessionId = b64u(16 bytes). */
function makeSessionId(seed: number): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (seed + i) & 0xff;
  return toB64u(bytes);
}

/** A valid 43-char pubkey b64u = b64u(32 bytes). */
function makePubkeyB64u(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i * 7) & 0xff;
  return toB64u(bytes);
}

/** A valid >=54-char AEAD ciphertext b64u. */
function makeAeadCiphertext(seed: number): string {
  const bytes = new Uint8Array(64); // 24 nonce + 24 payload + 16 tag
  for (let i = 0; i < 64; i++) bytes[i] = (seed + i * 3) & 0xff;
  return toB64u(bytes);
}

/**
 * Flip a single b64url char at `idx` to a different valid char that changes
 * the DECODED bytes. For a 22-char sessionId (16 bytes), the last char has
 * 4 zero padding bits, so a small alphabet increment (+4) would only flip a
 * padding bit and leave the decoded bytes identical. We therefore flip by
 * +32 (bit 5, the top bit of the 6-bit group) which is always a meaningful
 * bit for any char position in a 16-byte/22-char encoding. For other
 * positions +4 suffices, but +32 is universally safe here.
 */
function flipChar(s: string, idx: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const original = s[idx]!;
  const replacement = chars[(chars.indexOf(original) + 32) % chars.length];
  return s.slice(0, idx) + replacement + s.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// verifySessionIdRedundancy — CWE-208 regression tests (ADR-011)
// ---------------------------------------------------------------------------

describe('verifySessionIdRedundancy (CWE-208 fix — ADR-011)', () => {
  const sid = makeSessionId(1);

  it('returns true for equal sessionIds', () => {
    const msg: IntroMessage = {
      kind: 'intro_accept_v1',
      sessionId: sid,
      eph_pub_b64u: makePubkeyB64u(2),
      accepted_at: 1000,
      transport_props: {},
    };
    expect(verifySessionIdRedundancy(msg, sid)).toBe(true);
  });

  it('returns false when sessionIds differ in the first char', () => {
    const tampered = flipChar(sid, 0);
    const msg: IntroMessage = {
      kind: 'intro_accept_v1',
      sessionId: tampered,
      eph_pub_b64u: makePubkeyB64u(2),
      accepted_at: 1000,
      transport_props: {},
    };
    expect(verifySessionIdRedundancy(msg, sid)).toBe(false);
  });

  it('returns false when sessionIds differ in the last char', () => {
    const tampered = flipChar(sid, sid.length - 1);
    const msg: IntroMessage = {
      kind: 'intro_accept_v1',
      sessionId: tampered,
      eph_pub_b64u: makePubkeyB64u(2),
      accepted_at: 1000,
      transport_props: {},
    };
    expect(verifySessionIdRedundancy(msg, sid)).toBe(false);
  });

  it('returns false for different-length sessionIds', () => {
    // msg.sessionId is a valid 22-char b64u; derivedSessionId is a valid
    // 43-char b64u (a pubkey). Lengths differ → timingSafePubkeyEqualB64u
    // returns false immediately on the length check (length is non-secret),
    // before any decoding. No throw.
    const msg: IntroMessage = {
      kind: 'intro_accept_v1',
      sessionId: sid,
      eph_pub_b64u: makePubkeyB64u(2),
      accepted_at: 1000,
      transport_props: {},
    };
    const derivedDifferentLength = makePubkeyB64u(99); // 43 chars, valid b64u
    expect(verifySessionIdRedundancy(msg, derivedDifferentLength)).toBe(false);
  });

  it('does not short-circuit on first-byte mismatch — last-byte-only difference returns false', () => {
    // Two sessionIds that are identical except the last char. A
    // short-circuiting `===` would return false faster for a first-char
    // mismatch than a last-char mismatch. The constant-time fix walks all
    // bytes regardless. We assert the function returns a boolean (false)
    // and does not throw — the timing difference itself is not asserted
    // (JS timing is non-deterministic in CI), but the correctness of the
    // last-byte mismatch result IS the regression guard: a broken
    // implementation that compared only a prefix would return true here.
    const sidA = makeSessionId(5);
    const sidB = flipChar(sidA, sidA.length - 1);
    const msg: IntroMessage = {
      kind: 'intro_auth_v1',
      sessionId: sidA,
      aead_ciphertext: makeAeadCiphertext(9),
    };
    expect(verifySessionIdRedundancy(msg, sidB)).toBe(false);
    expect(typeof verifySessionIdRedundancy(msg, sidB)).toBe('boolean');
  });

  it('returns true for equal sessionIds across all message kinds', () => {
    for (const kind of [
      'intro_request_v1',
      'intro_accept_v1',
      'intro_decline_v1',
      'intro_auth_v1',
      'intro_activate_v1',
      'intro_abort_v1',
    ] as const) {
      const msg = buildMessage(kind, sid);
      expect(verifySessionIdRedundancy(msg, sid)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip encode → decode → verify for all 6 message types
// ---------------------------------------------------------------------------

describe('encode/decode round-trip — all 6 message types', () => {
  const sid = makeSessionId(1);

  it('intro_request_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_request_v1',
      sessionId: sid,
      target: {
        pubkey_b64u: makePubkeyB64u(10),
        author_b64u: makePubkeyB64u(20),
        profile_key_b64u: makeAeadCiphertext(30),
        short_id: 'abc',
        handle: 'alice',
        transport_props: { foo: 'bar' },
      },
      note: 'hi bob',
      created_at: 12345,
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });

  it('intro_accept_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_accept_v1',
      sessionId: sid,
      eph_pub_b64u: makePubkeyB64u(11),
      accepted_at: 9999,
      transport_props: {},
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });

  it('intro_decline_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_decline_v1',
      sessionId: sid,
      reason: 'declined',
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });

  it('intro_auth_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_auth_v1',
      sessionId: sid,
      aead_ciphertext: makeAeadCiphertext(42),
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });

  it('intro_activate_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_activate_v1',
      sessionId: sid,
      aead_ciphertext: makeAeadCiphertext(77),
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });

  it('intro_abort_v1 round-trips', () => {
    const msg: IntroMessage = {
      kind: 'intro_abort_v1',
      sessionId: sid,
      reason: 'timeout',
    };
    const wire = encodeIntroMessage(msg);
    const decoded = decodeIntroMessage(JSON.parse(wire));
    expect(decoded).toEqual(msg);
    expect(verifySessionIdRedundancy(decoded, sid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('decodeIntroMessage validation', () => {
  it('rejects an unknown kind', () => {
    expect(() => decodeIntroMessage({ kind: 'intro_bogus_v1', sessionId: makeSessionId(1) })).toThrow();
  });

  it('rejects a malformed sessionId (wrong length)', () => {
    expect(() =>
      decodeIntroMessage({ kind: 'intro_decline_v1', sessionId: 'tooShort' }),
    ).toThrow();
  });

  it('rejects a missing required field', () => {
    expect(() => decodeIntroMessage({ kind: 'intro_abort_v1' })).toThrow();
  });

  it('IntroMessageSchema parses a valid message', () => {
    const msg = { kind: 'intro_decline_v1' as const, sessionId: makeSessionId(3) };
    expect(IntroMessageSchema.parse(msg)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid message of a given kind
// ---------------------------------------------------------------------------

function buildMessage(kind: IntroMessage['kind'], sid: string): IntroMessage {
  switch (kind) {
    case 'intro_request_v1':
      return {
        kind,
        sessionId: sid,
        target: {
          pubkey_b64u: makePubkeyB64u(10),
          author_b64u: makePubkeyB64u(20),
          profile_key_b64u: makeAeadCiphertext(30),
          transport_props: {},
        },
        created_at: 1,
      };
    case 'intro_accept_v1':
      return {
        kind,
        sessionId: sid,
        eph_pub_b64u: makePubkeyB64u(11),
        accepted_at: 1,
        transport_props: {},
      };
    case 'intro_decline_v1':
      return { kind, sessionId: sid };
    case 'intro_auth_v1':
      return { kind, sessionId: sid, aead_ciphertext: makeAeadCiphertext(42) };
    case 'intro_activate_v1':
      return { kind, sessionId: sid, aead_ciphertext: makeAeadCiphertext(77) };
    case 'intro_abort_v1':
      return { kind, sessionId: sid, reason: 'timeout' };
  }
}
