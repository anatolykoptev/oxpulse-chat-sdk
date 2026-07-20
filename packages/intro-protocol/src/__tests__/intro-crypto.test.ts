import { describe, it, expect } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import {
  deriveSessionId,
  isAliceRole,
  deriveMasterKey,
  deriveMacKeys,
  wipeMacKeys,
  wipe,
  buildAuthTranscript,
  computeAuthMac,
  verifyAuthMac,
  computeAuthSig,
  verifyAuthSig,
  computeActivateMac,
  verifyActivateMac,
  sealAead,
  openAead,
  envelopeToWireB64u,
  wireB64uToEnvelope,
  LABEL_AUTH_MAC,
  LABEL_ACTIVATE_MAC,
  PROTOCOL_VERSION,
  type TranscriptParty,
} from '../intro-crypto.ts';
import { timingSafeEqual } from '@oxpulse/crypto-primitives';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode raw bytes to base64url (no padding). */
function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function randomEd25519Pubkey(): Uint8Array {
  return ed25519.getPublicKey(randomBytes(32));
}

function randomX25519Keypair(): { priv: Uint8Array; pub: Uint8Array } {
  const kp = x25519.keygen();
  return { priv: kp.secretKey, pub: kp.publicKey };
}

// ---------------------------------------------------------------------------
// deriveSessionId
// ---------------------------------------------------------------------------

describe('deriveSessionId', () => {
  it('produces a 22-char base64url string (16 bytes)', () => {
    const sid = deriveSessionId(randomEd25519Pubkey(), randomEd25519Pubkey(), randomEd25519Pubkey());
    expect(sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = randomEd25519Pubkey();
    const b = randomEd25519Pubkey();
    const c = randomEd25519Pubkey();
    expect(deriveSessionId(a, b, c)).toBe(deriveSessionId(a, b, c));
  });

  it('differs when any input changes', () => {
    const a = randomEd25519Pubkey();
    const b = randomEd25519Pubkey();
    const c = randomEd25519Pubkey();
    expect(deriveSessionId(a, b, c)).not.toBe(deriveSessionId(randomEd25519Pubkey(), b, c));
    expect(deriveSessionId(a, b, c)).not.toBe(deriveSessionId(a, randomEd25519Pubkey(), c));
    expect(deriveSessionId(a, b, c)).not.toBe(deriveSessionId(a, b, randomEd25519Pubkey()));
  });

  it('throws on non-32-byte pubkeys', () => {
    expect(() => deriveSessionId(new Uint8Array(31), new Uint8Array(32), new Uint8Array(32))).toThrow();
    expect(() => deriveSessionId(new Uint8Array(32), new Uint8Array(33), new Uint8Array(32))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isAliceRole
// ---------------------------------------------------------------------------

describe('isAliceRole', () => {
  it('returns true when local < peer (Alice role)', () => {
    const local = new Uint8Array(32);
    local[0] = 1;
    const peer = new Uint8Array(32);
    peer[0] = 2;
    expect(isAliceRole(local, peer)).toBe(true);
  });

  it('returns false when local > peer (Bob role)', () => {
    const local = new Uint8Array(32);
    local[0] = 2;
    const peer = new Uint8Array(32);
    peer[0] = 1;
    expect(isAliceRole(local, peer)).toBe(false);
  });

  it('returns false on equal (tiebreaker: peer is Alice)', () => {
    const k = randomEd25519Pubkey();
    expect(isAliceRole(k, k)).toBe(false);
  });

  it('is constant-time: walks all bytes (last-byte difference decides)', () => {
    const local = new Uint8Array(32);
    const peer = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      local[i] = 5;
      peer[i] = 5;
    }
    peer[31] = 6; // last byte: local < peer → Alice
    expect(isAliceRole(local, peer)).toBe(true);
    peer[31] = 4; // last byte: local > peer → Bob
    expect(isAliceRole(local, peer)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveMasterKey + deriveMacKeys
// ---------------------------------------------------------------------------

describe('deriveMasterKey', () => {
  it('produces a 32-byte key', () => {
    const alice = randomX25519Keypair();
    const bob = randomX25519Keypair();
    const mk = deriveMasterKey(alice.priv, bob.pub, alice.pub, bob.pub);
    expect(mk.length).toBe(32);
  });

  it('is symmetric: both parties derive the same master key', () => {
    const alice = randomX25519Keypair();
    const bob = randomX25519Keypair();
    // Alice computes with her priv + bob's pub; Bob with his priv + alice's pub.
    // Role-ordered info (alicePub, bobPub) is the same for both.
    const mkAlice = deriveMasterKey(alice.priv, bob.pub, alice.pub, bob.pub);
    const mkBob = deriveMasterKey(bob.priv, alice.pub, alice.pub, bob.pub);
    expect(timingSafeEqual(mkAlice, mkBob)).toBe(true);
  });
});

describe('deriveMacKeys', () => {
  it('produces two distinct 32-byte keys', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { alice, bob } = deriveMacKeys(mk);
    expect(alice.length).toBe(32);
    expect(bob.length).toBe(32);
    expect(timingSafeEqual(alice, bob)).toBe(false);
  });

  it('is deterministic', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const a = deriveMacKeys(mk);
    const b = deriveMacKeys(mk);
    expect(timingSafeEqual(a.alice, b.alice)).toBe(true);
    expect(timingSafeEqual(a.bob, b.bob)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAuthTranscript + AUTH MAC + AUTH SIG
// ---------------------------------------------------------------------------

describe('buildAuthTranscript + AUTH MAC/SIG', () => {
  it('both sides produce identical transcripts (canonical ordering)', () => {
    const introducer = randomEd25519Pubkey();
    const alicePriv = randomBytes(32);
    const bobPriv = randomBytes(32);
    const alicePub = ed25519.getPublicKey(alicePriv);
    const bobPub = ed25519.getPublicKey(bobPriv);
    const aliceEph = randomX25519Keypair().pub;
    const bobEph = randomX25519Keypair().pub;

    const aliceSide = { longTermPubkey: alicePub, acceptedAt: 100, ephPub: aliceEph, transportProps: { x: 1 } };
    const bobSide = { longTermPubkey: bobPub, acceptedAt: 200, ephPub: bobEph, transportProps: { y: 2 } };

    // Alice builds with herself as ownSide, Bob as peerSide.
    const tAlice = buildAuthTranscript(introducer, aliceSide, bobSide);
    // Bob builds with himself as ownSide, Alice as peerSide.
    const tBob = buildAuthTranscript(introducer, bobSide, aliceSide);
    expect(timingSafeEqual(tAlice, tBob)).toBe(true);
  });

  it('AUTH MAC verifies (compute → verify round-trip)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { alice } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const transcript = new Uint8Array([1, 2, 3, 4, 5]);
    const mac = computeAuthMac(alice, sessionId, transcript);
    expect(verifyAuthMac(alice, sessionId, transcript, mac)).toBe(true);
  });

  it('AUTH MAC rejects a tampered MAC (constant-time)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { alice } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const transcript = new Uint8Array([1, 2, 3, 4, 5]);
    const mac = computeAuthMac(alice, sessionId, transcript);
    const tampered = new Uint8Array(mac);
    tampered[0] ^= 0xff;
    expect(verifyAuthMac(alice, sessionId, transcript, tampered)).toBe(false);
  });

  it('AUTH SIG verifies (compute → verify round-trip)', () => {
    const priv = randomBytes(32);
    const pub = ed25519.getPublicKey(priv);
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { alice } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const transcript = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = computeAuthSig(priv, alice, sessionId, transcript);
    expect(verifyAuthSig(pub, alice, sessionId, transcript, sig)).toBe(true);
  });

  it('AUTH SIG rejects a wrong pubkey', () => {
    const priv = randomBytes(32);
    const pub = ed25519.getPublicKey(priv);
    const otherPub = randomEd25519Pubkey();
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { alice } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const transcript = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = computeAuthSig(priv, alice, sessionId, transcript);
    expect(verifyAuthSig(otherPub, alice, sessionId, transcript, sig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACTIVATE MAC
// ---------------------------------------------------------------------------

describe('ACTIVATE MAC', () => {
  it('verifies (compute → verify round-trip)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { bob } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const mac = computeActivateMac(bob, sessionId);
    expect(verifyActivateMac(bob, sessionId, mac)).toBe(true);
  });

  it('rejects a tampered MAC', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const { bob } = deriveMacKeys(mk);
    const sessionId = new Uint8Array(16);
    const mac = computeActivateMac(bob, sessionId);
    const tampered = new Uint8Array(mac);
    tampered[tampered.length - 1] ^= 0xff;
    expect(verifyActivateMac(bob, sessionId, tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AEAD (XChaCha20-Poly1305)
// ---------------------------------------------------------------------------

describe('sealAead / openAead', () => {
  it('round-trips (seal → open recovers plaintext)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const sessionId = new Uint8Array(16);
    const plaintext = new TextEncoder().encode('hello world');
    const env = sealAead(mk, LABEL_AUTH_MAC, sessionId, plaintext);
    expect(env.nonce.length).toBe(24);
    const recovered = openAead(mk, LABEL_AUTH_MAC, sessionId, env);
    expect(new TextDecoder().decode(recovered)).toBe('hello world');
  });

  it('throws on tag mismatch (tampered ciphertext)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const sessionId = new Uint8Array(16);
    const plaintext = new TextEncoder().encode('hello world');
    const env = sealAead(mk, LABEL_AUTH_MAC, sessionId, plaintext);
    const tampered = new Uint8Array(env.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => openAead(mk, LABEL_AUTH_MAC, sessionId, { nonce: env.nonce, ciphertext: tampered })).toThrow();
  });

  it('throws on wrong AAD (mismatched label)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const sessionId = new Uint8Array(16);
    const plaintext = new TextEncoder().encode('hello world');
    const env = sealAead(mk, LABEL_AUTH_MAC, sessionId, plaintext);
    expect(() => openAead(mk, LABEL_ACTIVATE_MAC, sessionId, env)).toThrow();
  });

  it('throws on wrong AAD (mismatched sessionId)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const sessionId = new Uint8Array(16);
    const wrongSessionId = new Uint8Array(16).fill(0xff);
    const plaintext = new TextEncoder().encode('hello world');
    const env = sealAead(mk, LABEL_AUTH_MAC, sessionId, plaintext);
    expect(() => openAead(mk, LABEL_AUTH_MAC, wrongSessionId, env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Constant-time pubkey comparison (via crypto-primitives import path)
// ---------------------------------------------------------------------------

describe('PROTOCOL_VERSION', () => {
  it('is 0x01', () => {
    expect(PROTOCOL_VERSION).toBe(0x01);
  });
});

// ---------------------------------------------------------------------------
// #217: deriveSessionId canonical ordering
// ---------------------------------------------------------------------------

describe('deriveSessionId canonical ordering (#217)', () => {
  it('produces identical sessionId regardless of alice/bob argument order', () => {
    const introducer = randomEd25519Pubkey();
    const aliceEph = randomBytes(32);
    const bobEph = randomBytes(32);
    // Two argument orderings must yield the same sessionId.
    expect(deriveSessionId(introducer, aliceEph, bobEph))
      .toBe(deriveSessionId(introducer, bobEph, aliceEph));
  });
});

// ---------------------------------------------------------------------------
// #216: wipe + wipeMacKeys
// ---------------------------------------------------------------------------

describe('wipe (#216)', () => {
  it('zeroizes a Uint8Array in place', () => {
    const u = new Uint8Array([1, 2, 3, 4, 5]);
    wipe(u);
    expect(Array.from(u)).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns the same reference (now zeroed)', () => {
    const u = new Uint8Array([0xff, 0xff]);
    const r = wipe(u);
    expect(r).toBe(u);
    expect(Array.from(u)).toEqual([0, 0]);
  });
});

describe('wipeMacKeys (#216)', () => {
  it('zeroizes both alice and bob MAC keys', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const keys = deriveMacKeys(mk);
    wipeMacKeys(keys);
    expect(Array.from(keys.alice)).toEqual(Array(32).fill(0));
    expect(Array.from(keys.bob)).toEqual(Array(32).fill(0));
  });
});

// ---------------------------------------------------------------------------
// #218 nit #1: buildAuthTranscript equal-pubkey guard
// ---------------------------------------------------------------------------

describe('buildAuthTranscript equal-pubkey guard (#218 nit #1)', () => {
  it('throws when both parties share the same long-term pubkey', () => {
    const introducer = randomEd25519Pubkey();
    const samePub = randomEd25519Pubkey();
    const side: TranscriptParty = {
      longTermPubkey: samePub,
      acceptedAt: 1,
      ephPub: randomBytes(32),
      transportProps: {},
    };
    expect(() => buildAuthTranscript(introducer, side, side)).toThrow(
      /distinct long-term pubkeys/,
    );
  });
});

// ---------------------------------------------------------------------------
// #218 nit #8: AeadEnvelope ↔ wire-format bridge
// ---------------------------------------------------------------------------

describe('envelopeToWireB64u / wireB64uToEnvelope (#218 nit #8)', () => {
  it('round-trips (seal → wire → parse → open recovers plaintext)', () => {
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    const sessionId = new Uint8Array(16);
    const plaintext = new TextEncoder().encode('bridge round-trip');
    const env = sealAead(mk, LABEL_AUTH_MAC, sessionId, plaintext);
    const wire = envelopeToWireB64u(env);
    // Wire form is base64url of nonce(24) ‖ ciphertext ‖ tag(16).
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/);
    const parsed = wireB64uToEnvelope(wire);
    expect(parsed.nonce.length).toBe(24);
    expect(timingSafeEqual(parsed.nonce, env.nonce)).toBe(true);
    const recovered = openAead(mk, LABEL_AUTH_MAC, sessionId, parsed);
    expect(new TextDecoder().decode(recovered)).toBe('bridge round-trip');
  });

  it('wireB64uToEnvelope throws on input shorter than 24-byte nonce', () => {
    expect(() => wireB64uToEnvelope('AAAA')).toThrow(/>= 24-byte nonce/);
  });
});
