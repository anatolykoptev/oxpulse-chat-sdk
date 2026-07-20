/**
 * Briar-faithful crypto primitives for the L2 introduction protocol.
 *
 * All functions are pure — no side-effects beyond the returned values.
 * Implements sub-spec §4.2 (labels, key derivation, MAC/sig, AEAD).
 *
 * Label encoding: UTF-8 at use-site, no NUL terminators (architect nit #2).
 * MAC comparison: always constant-time via timingSafeEqual (W4).
 *
 * ADR-010: This module is part of the @oxpulse/intro-protocol bounded
 * context (intro-crypto + intro-wire + intro-safety-number in ONE package).
 *
 * ADR-008: timingSafeEqual + timingSafePubkeyEqualB64u are imported from
 * @oxpulse/crypto-primitives (the single public source of truth for
 * constant-time comparison). concatBytes + utf8 stay local here — they are
 * internal general-purpose helpers, not part of the crypto-primitives
 * public surface.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf, expand } from '@noble/hashes/hkdf.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { encode as cborgEncode, rfc8949EncodeOptions } from 'cborg';

// Constant-time comparison — single source of truth (ADR-008).
// deriveSharedSecret — RFC 7748 §6.1 all-zero-shared-secret defense (low-order point guard).
// b64uEncodeBytes / b64uDecodeBytes — single canonical base64url home (ADR-013 / #218 nit #11).
import {
  timingSafeEqual,
  deriveSharedSecret,
  b64uEncodeBytes,
  b64uDecodeBytes,
} from '@oxpulse/crypto-primitives';

// ---------------------------------------------------------------------------
// Label constants (sub-spec §4.2) — UTF-8 encoded at use-site.
// ---------------------------------------------------------------------------

export const LABEL_SESSION_ID    = 'oxpulse-intro-v1/SESSION_ID';
export const LABEL_MASTER_KEY    = 'oxpulse-intro-v1/MASTER_KEY';
export const LABEL_ALICE_MAC_KEY = 'oxpulse-intro-v1/ALICE_MAC_KEY';
export const LABEL_BOB_MAC_KEY   = 'oxpulse-intro-v1/BOB_MAC_KEY';
export const LABEL_AUTH_MAC      = 'oxpulse-intro-v1/AUTH_MAC';
export const LABEL_AUTH_NONCE    = 'oxpulse-intro-v1/AUTH_NONCE';
export const LABEL_AUTH_SIGN     = 'oxpulse-intro-v1/AUTH_SIGN';
export const LABEL_ACTIVATE_MAC  = 'oxpulse-intro-v1/ACTIVATE_MAC';

export const PROTOCOL_VERSION = 0x01;

// ---------------------------------------------------------------------------
// Internal helpers (ADR-008: concatBytes + utf8 stay local/general-purpose;
// only timingSafeEqual + timingSafePubkeyEqualB64u are public exports from
// crypto-primitives).
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Encode a LABEL_* string to UTF-8 bytes. */
function utf8(label: string): Uint8Array {
  return enc.encode(label);
}

/** Concatenate multiple Uint8Arrays into one. */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Best-effort zeroization of secret key material (ADR-013 / #216).
 *
 * Overwrites the buffer with zeros. JS zeroization is best-effort — V8 may
 * copy Uint8Array contents during GC compaction, so this is NOT a guarantee
 * that no copy survives — but it is the recognized hardening baseline and
 * the SECURITY.md threat model already promises these values are secret.
 *
 * Callers MUST wipe:
 *   - ephemeral private keys after `deriveMasterKey`
 *   - `masterKey` when done with all derived MAC keys + AEAD operations
 *   - MAC keys via {@link wipeMacKeys} when the handshake completes/aborts
 *
 * Returns the same Uint8Array reference (now zeroed) for convenience.
 */
export function wipe(u: Uint8Array): Uint8Array {
  u.fill(0);
  return u;
}

// ---------------------------------------------------------------------------
// base64url helpers — imported from @oxpulse/crypto-primitives (ADR-013 / #218 nit #11).
// Local copies removed; b64uEncodeBytes / b64uDecodeBytes are the canonical home.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic 16-byte (22-char base64url) session ID.
 *
 * input  = utf8(LABEL_SESSION_ID) || introducerPub || firstPub || secondPub
 * result = SHA-256(input)[0..16] encoded as base64url
 *
 * All pubkeys must be 32-byte Ed25519 pubkeys (raw bytes, not base64url).
 * Callers holding b64u strings decode first: `b64uDecodeBytes(b64uStr)`
 * from `@oxpulse/crypto-primitives`.
 *
 * alicePub + bobPub are canonical-ordered internally via {@link isAliceRole}
 * (lex-smaller pubkey first), matching {@link buildAuthTranscript}. This
 * guarantees both parties produce identical sessionIds regardless of which
 * side calls deriveSessionId(introducer, own, peer) — see ADR-013 / #217.
 *
 * @param introducerPub - Introducer long-term Ed25519 pubkey (32 bytes)
 * @param alicePub      - Alice ephemeral pubkey (32 bytes) — auto role-ordered
 * @param bobPub        - Bob ephemeral pubkey (32 bytes)   — auto role-ordered
 */
export function deriveSessionId(
  introducerPub: Uint8Array,
  alicePub: Uint8Array,
  bobPub: Uint8Array,
): string {
  if (introducerPub.length !== 32 || alicePub.length !== 32 || bobPub.length !== 32) {
    throw new Error('deriveSessionId: all pubkeys must be 32-byte Ed25519 pubkeys');
  }
  // Canonical-order alice/bob via isAliceRole (lex-smaller first), matching
  // buildAuthTranscript. Without this, a receiver re-deriving sessionId for
  // verifySessionIdRedundancy who passes (ownEphPub, peerEphPub) in the wrong
  // order would get a different sessionId than the introducer placed on the
  // wire, causing a spurious forgery alarm + protocol abort (DoS).
  const [firstPub, secondPub] = isAliceRole(alicePub, bobPub)
    ? [alicePub, bobPub]
    : [bobPub, alicePub];
  const input  = concatBytes(utf8(LABEL_SESSION_ID), introducerPub, firstPub, secondPub);
  const digest = sha256(input);
  return b64uEncodeBytes(digest.slice(0, 16));
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

/**
 * Constant-time lexicographic compare of two Ed25519/X25519 pubkeys.
 * Returns true if localPubkey < peerPubkey (Alice role).
 * Returns false on equal (tiebreaker: peer is Alice, local is Bob).
 */
export function isAliceRole(localPubkey: Uint8Array, peerPubkey: Uint8Array): boolean {
  const len = Math.min(localPubkey.length, peerPubkey.length);
  // Walk all bytes to avoid timing leak on early-exit comparison.
  // Result: first differing byte where local < peer → Alice; local >= peer → Bob.
  let result = 0;  // 0 = equal so far
  let decided = 0; // 1 once first difference found
  for (let i = 0; i < len; i++) {
    const diff = (localPubkey[i]! - peerPubkey[i]!) | 0;
    // If not decided and diff != 0, set result and mark decided.
    const notDecided = 1 - decided;
    const hasDiff = diff !== 0 ? 1 : 0;
    const shouldDecide = notDecided & hasDiff;
    result = (result & (1 - shouldDecide)) | (((diff >> 31) & 1) & shouldDecide);
    decided = decided | shouldDecide;
  }
  return result === 1;
}

// ---------------------------------------------------------------------------
// Master key derivation (X25519 + HKDF-SHA256)
// ---------------------------------------------------------------------------

/**
 * Derives the shared master key from an ephemeral X25519 DH + HKDF.
 *
 * ikm  = X25519(ownEphPriv, peerEphPub)  — wiped before return (#216)
 * salt = utf8(LABEL_MASTER_KEY)
 * info = [PROTOCOL_VERSION] || aliceEphPub || bobEphPub
 * return HKDF-SHA256(salt, ikm, info, 32)
 *
 * aliceEphPub + bobEphPub are role-ordered so both parties use identical info.
 * The caller is responsible for wiping the returned masterKey (via {@link wipe})
 * once all MAC keys are derived and AEAD operations complete, and for wiping
 * the ownEphPriv argument after this call returns.
 */
export function deriveMasterKey(
  ownEphPriv:  Uint8Array,
  peerEphPub:  Uint8Array,
  aliceEphPub: Uint8Array,
  bobEphPub:   Uint8Array,
): Uint8Array {
  const ikm  = deriveSharedSecret(ownEphPriv, peerEphPub);
  const salt = utf8(LABEL_MASTER_KEY);
  const info = concatBytes(new Uint8Array([PROTOCOL_VERSION]), aliceEphPub, bobEphPub);
  const masterKey = hkdf(sha256, ikm, salt, info, 32);
  // Best-effort zeroize the raw DH shared secret — no longer needed after HKDF.
  wipe(ikm);
  return masterKey;
}

// ---------------------------------------------------------------------------
// MAC key derivation (HKDF-Expand only, RFC 5869 §2.3)
// ---------------------------------------------------------------------------

/**
 * Derives alice and bob MAC keys from masterKey via HKDF-Expand-only.
 *
 * expand(masterKey, utf8(LABEL_ALICE_MAC_KEY), 32)
 * expand(masterKey, utf8(LABEL_BOB_MAC_KEY),   32)
 *
 * Uses `expand` (HKDF-Expand) directly — masterKey is already a PRK.
 */
export function deriveMacKeys(masterKey: Uint8Array): { alice: Uint8Array; bob: Uint8Array } {
  const alice = expand(sha256, masterKey, utf8(LABEL_ALICE_MAC_KEY), 32);
  const bob   = expand(sha256, masterKey, utf8(LABEL_BOB_MAC_KEY),   32);
  return { alice, bob };
}

/**
 * Best-effort zeroize both MAC keys returned by {@link deriveMacKeys} (#216).
 *
 * Call when the handshake completes or aborts and the MAC keys are no longer
 * needed. After this call, `keys.alice` and `keys.bob` are zeroed — further
 * use will produce wrong results / throw, which is the intended fail-closed
 * behaviour.
 */
export function wipeMacKeys(keys: { alice: Uint8Array; bob: Uint8Array }): void {
  wipe(keys.alice);
  wipe(keys.bob);
}

// ---------------------------------------------------------------------------
// Auth transcript (canonical CBOR)
// ---------------------------------------------------------------------------

export interface TranscriptParty {
  longTermPubkey: Uint8Array;
  acceptedAt: number;
  ephPub: Uint8Array;
  transportProps: Record<string, unknown>;
}

/**
 * Builds the canonical CBOR auth transcript.
 *
 * canonicalCBOR([
 *   introducer.longTermPub,
 *   [alice.longTermPub, alice.acceptedAt, alice.ephPub, alice.transportProps],
 *   [bob.longTermPub,   bob.acceptedAt,   bob.ephPub,   bob.transportProps],
 * ])
 *
 * Parties are canonically ordered: the party whose longTermPubkey is
 * lexicographically smaller (isAliceRole) is always listed first.
 * This ensures both sides produce identical CBOR bytes regardless of
 * which side calls buildAuthTranscript(introducer, own, peer).
 */
export function buildAuthTranscript(
  introducerLongTermPub: Uint8Array,
  ownSide:  TranscriptParty,
  peerSide: TranscriptParty,
): Uint8Array {
  // Defensive guard: two parties with the same long-term pubkey is a
  // degenerate case that should never occur in a real introduction (two
  // different people). Without this, isAliceRole returns false on equal
  // pubkeys (tiebreaker: peer is Alice), so each side places the PEER first
  // → transcripts diverge → MAC verify fails silently. Throw loudly instead.
  if (timingSafeEqual(ownSide.longTermPubkey, peerSide.longTermPubkey)) {
    throw new Error('buildAuthTranscript: both parties must have distinct long-term pubkeys');
  }
  // Determine canonical ordering: alice (lex-smaller pubkey) is always first.
  const ownIsAlice = isAliceRole(ownSide.longTermPubkey, peerSide.longTermPubkey);
  const [firstSide, secondSide] = ownIsAlice
    ? [ownSide, peerSide]
    : [peerSide, ownSide];

  const value = [
    introducerLongTermPub,
    [firstSide.longTermPubkey,  firstSide.acceptedAt,  firstSide.ephPub,  firstSide.transportProps],
    [secondSide.longTermPubkey, secondSide.acceptedAt, secondSide.ephPub, secondSide.transportProps],
  ];
  return cborgEncode(value, rfc8949EncodeOptions);
}

// ---------------------------------------------------------------------------
// AUTH MAC
// ---------------------------------------------------------------------------

/**
 * Computes HMAC-SHA256(ownMacKey, utf8(LABEL_AUTH_MAC) || sessionId || transcript).
 *
 * sessionId is mixed in explicitly (ADR-013 / #218 nit #7) so the binding to
 * the introducer's announced sessionId survives future transcript-shape
 * changes. Previously the binding was only transitive (sessionId inputs are
 * also transcript fields); explicit binding is more robust against refactor.
 */
export function computeAuthMac(
  ownMacKey:  Uint8Array,
  sessionId:  Uint8Array,
  transcript: Uint8Array,
): Uint8Array {
  return hmac(sha256, ownMacKey, concatBytes(utf8(LABEL_AUTH_MAC), sessionId, transcript));
}

/**
 * Verifies the peer's auth MAC.
 *
 * Recomputes HMAC-SHA256(peerMacKey, utf8(LABEL_AUTH_MAC) || sessionId ||
 * canonicalTranscript) and compares using constant-time equality.
 *
 * With canonical-ordering in buildAuthTranscript, both sides produce identical
 * transcript bytes — the verifier passes its own locally-built transcript, which
 * equals the sender's transcript exactly (the "swap" is identity by design).
 */
export function verifyAuthMac(
  peerMacKey:          Uint8Array,
  sessionId:           Uint8Array,
  canonicalTranscript: Uint8Array,
  receivedMac:         Uint8Array,
): boolean {
  const expected = hmac(sha256, peerMacKey, concatBytes(utf8(LABEL_AUTH_MAC), sessionId, canonicalTranscript));
  return timingSafeEqual(expected, receivedMac);
}

// ---------------------------------------------------------------------------
// AUTH SIG (Ed25519 over HMAC-derived nonce)
// ---------------------------------------------------------------------------

/**
 * Computes the auth signature.
 *
 * nonce = HMAC-SHA256(ownMacKey, utf8(LABEL_AUTH_NONCE) || sessionId || transcript)
 * return Ed25519-sign(ownLongTermPriv, utf8(LABEL_AUTH_SIGN) || nonce)
 *
 * sessionId is mixed into the nonce explicitly (ADR-013 / #218 nit #7) for
 * the same reason as in {@link computeAuthMac} — explicit binding survives
 * future transcript-shape changes.
 */
export function computeAuthSig(
  ownLongTermPriv: Uint8Array,
  ownMacKey:       Uint8Array,
  sessionId:       Uint8Array,
  transcript:      Uint8Array,
): Uint8Array {
  const nonce   = hmac(sha256, ownMacKey, concatBytes(utf8(LABEL_AUTH_NONCE), sessionId, transcript));
  const message = concatBytes(utf8(LABEL_AUTH_SIGN), nonce);
  return ed25519.sign(message, ownLongTermPriv);
}

/**
 * Verifies the peer's auth signature.
 *
 * nonce = HMAC-SHA256(peerMacKey, utf8(LABEL_AUTH_NONCE) || sessionId ||
 *                     canonicalTranscript)
 * return Ed25519-verify(peerLongTermPub, utf8(LABEL_AUTH_SIGN) || nonce, receivedSig)
 *
 * With canonical-ordering in buildAuthTranscript, both sides produce identical
 * transcript bytes — pass the locally-built canonical transcript here.
 */
export function verifyAuthSig(
  peerLongTermPub:     Uint8Array,
  peerMacKey:          Uint8Array,
  sessionId:           Uint8Array,
  canonicalTranscript: Uint8Array,
  receivedSig:         Uint8Array,
): boolean {
  try {
    const nonce   = hmac(sha256, peerMacKey, concatBytes(utf8(LABEL_AUTH_NONCE), sessionId, canonicalTranscript));
    const message = concatBytes(utf8(LABEL_AUTH_SIGN), nonce);
    return ed25519.verify(receivedSig, message, peerLongTermPub);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ACTIVATE MAC
// ---------------------------------------------------------------------------

/**
 * Computes HMAC-SHA256(ownMacKey, utf8(LABEL_ACTIVATE_MAC) || sessionId).
 */
export function computeActivateMac(ownMacKey: Uint8Array, sessionId: Uint8Array): Uint8Array {
  return hmac(sha256, ownMacKey, concatBytes(utf8(LABEL_ACTIVATE_MAC), sessionId));
}

/**
 * Verifies activate MAC using constant-time comparison.
 */
export function verifyActivateMac(
  peerMacKey:  Uint8Array,
  sessionId:   Uint8Array,
  receivedMac: Uint8Array,
): boolean {
  const expected = hmac(sha256, peerMacKey, concatBytes(utf8(LABEL_ACTIVATE_MAC), sessionId));
  return timingSafeEqual(expected, receivedMac);
}

// ---------------------------------------------------------------------------
// AEAD (XChaCha20-Poly1305, §4.4)
// ---------------------------------------------------------------------------

export interface AeadEnvelope {
  nonce:      Uint8Array;
  ciphertext: Uint8Array;
}

/** Permitted labels for AEAD operations — prevents cross-context misuse. */
export type AeadLabel = typeof LABEL_AUTH_MAC | typeof LABEL_ACTIVATE_MAC;

/**
 * Encrypts plaintext with XChaCha20-Poly1305.
 *
 * nonce  = random(24B)
 * AAD    = utf8(label) || sessionId
 * cipher = XChaCha20-Poly1305(masterKey, nonce, AAD)
 * return { nonce, ciphertext: cipher.encrypt(plaintext) }
 */
export function sealAead(
  masterKey: Uint8Array,
  label:     AeadLabel,
  sessionId: Uint8Array,
  plaintext: Uint8Array,
): AeadEnvelope {
  const nonce  = randomBytes(24);
  const aad    = concatBytes(utf8(label), sessionId);
  const cipher = xchacha20poly1305(masterKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);
  return { nonce, ciphertext };
}

/**
 * Decrypts an AEAD envelope. Throws on authentication tag mismatch.
 *
 * AAD    = utf8(label) || sessionId  (must match seal-time values)
 * cipher = XChaCha20-Poly1305(masterKey, env.nonce, AAD)
 * return cipher.decrypt(env.ciphertext)
 */
export function openAead(
  masterKey: Uint8Array,
  label:     AeadLabel,
  sessionId: Uint8Array,
  env:       AeadEnvelope,
): Uint8Array {
  const aad    = concatBytes(utf8(label), sessionId);
  const cipher = xchacha20poly1305(masterKey, env.nonce, aad);
  return cipher.decrypt(env.ciphertext);
}

// ---------------------------------------------------------------------------
// AeadEnvelope ↔ wire-format bridge (#218 nit #8)
// ---------------------------------------------------------------------------
//
// The wire format encodes AEAD ciphertext as a single base64url string of
// `nonce(24B) ‖ ciphertext ‖ tag(16B)` (see intro-wire IntroAuthV1Schema).
// sealAead/openAead operate on the structured {nonce, ciphertext} form.
// These bridge helpers eliminate a class of caller bugs (wrong concat order,
// wrong split offset, mismatched b64u encode/decode).

/**
 * Serialize an AeadEnvelope to the wire-format base64url string
 * `b64u(nonce || ciphertext)`.
 */
export function envelopeToWireB64u(env: AeadEnvelope): string {
  return b64uEncodeBytes(concatBytes(env.nonce, env.ciphertext));
}

/**
 * Parse a wire-format base64url string `b64u(nonce || ciphertext)` into an
 * AeadEnvelope. Throws if the input is shorter than the 24-byte nonce.
 *
 * Note: uses `b64uDecodeBytes` from `@oxpulse/crypto-primitives` — for
 * attacker-influenced inputs callers should pre-validate via the wire Zod
 * schema, which constrains the charset to base64url.
 */
export function wireB64uToEnvelope(s: string): AeadEnvelope {
  const bytes = b64uDecodeBytes(s);
  if (bytes.length < 24) {
    throw new Error('wireB64uToEnvelope: input too short — must be >= 24-byte nonce');
  }
  return { nonce: bytes.subarray(0, 24), ciphertext: bytes.subarray(24) };
}
