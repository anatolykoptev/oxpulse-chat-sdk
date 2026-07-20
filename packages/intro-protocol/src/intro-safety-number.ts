/**
 * Signal-style safety number derivation for the L2 introduction protocol.
 *
 * Per sub-spec §7.3 (Q3 resolution):
 *
 *   fp_input = canonicalCBOR([min(alice, bob), max(alice, bob), masterKey])
 *   fp_hash  = SHA-512(fp_input)[0..30]   // 30 bytes
 *   fp_dec   = bytesToDecimalString(fp_hash) // 60 digits exactly
 *
 * Implementation: 30-byte SHA-512 slice → big-endian BigInt → decimal string,
 * left-zero-padded to 72 digits, take leftmost 60, grouped as 12 × 5.
 *
 * 2^240 ≈ 1.77 × 10^72 (up to 73 decimal digits). padStart(72) is a no-op
 * for 73-digit values; slice(0, 60) always yields exactly 60 digits.
 *
 * Symmetric property: alice/bob inputs are canonically ordered (lex-smaller
 * first) before CBOR encoding, so swap(alice,bob) → identical output.
 */

import { sha512 } from '@noble/hashes/sha2.js';
import { encode as cborgEncode, rfc8949EncodeOptions } from 'cborg';

/**
 * Derives a Signal-style safety number for an introduction session.
 *
 * @param alicePub  - Alice's long-term pubkey (32 bytes)
 * @param bobPub    - Bob's long-term pubkey (32 bytes)
 * @param masterKey - Shared master key from DH (32 bytes)
 * @returns 60-digit decimal string in 12 groups of 5 separated by spaces
 *
 * @example
 * deriveSafetyNumber(alice, bob, masterKey)
 * // → "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
 *
 * SECURITY_COST-8 (SAS human comparison): The returned safety number is a
 * Short Authentication String (SAS) intended to be read aloud or compared
 * visually by the two human parties over an authenticated channel (in-person,
 * phone call). It is NOT compared in code as part of a security decision —
 * the comparison is performed by humans, who are inherently non-constant-time.
 * Therefore no constant-time comparison is required or meaningful for the SAS
 * value itself. The underlying deriveSafetyNumber computation is
 * deterministic and side-channel-free (pure hash/CBOR, no secret-dependent
 * branches on attacker-controlled input beyond the public pubkey ordering).
 */
export function deriveSafetyNumber(
  alicePub:  Uint8Array,
  bobPub:    Uint8Array,
  masterKey: Uint8Array,
): string {
  // Canonical ordering: lex-smaller pubkey is always first.
  // This ensures symmetry: swap(alice,bob) → same output.
  //
  // ADR-012: lexLess below is NOT constant-time. This is SAFE because the
  // pubkeys being ordered are already PUBLIC — they are exchanged over the
  // QR code / introduction channel in cleartext and are not secret material.
  // The ordering only determines array position in the CBOR input; it does
  // not gate any security decision on secret data. See ADR-012.
  const [first, second] = lexLess(alicePub, bobPub)
    ? [alicePub, bobPub]
    : [bobPub, alicePub];

  // Build CBOR input: [min(alice,bob), max(alice,bob), masterKey]
  const input = cborgEncode([first, second, masterKey], rfc8949EncodeOptions);

  // Hash and take first 30 bytes
  const hash30 = sha512(input).subarray(0, 30);

  // Convert 30 bytes to a decimal string, exactly 60 digits.
  // 30 bytes = 240 bits. 2^240 ≈ 1.77 × 10^72.
  // We take the BigInt, stringify, zero-pad to 72 digits, then take first 60.
  const decimal = bigIntFrom(hash30).toString(10).padStart(72, '0').slice(0, 60);

  // Group as 12 groups of 5
  return groupsOfFive(decimal);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a is lexicographically less than b.
 *
 * ADR-012: This function is NOT constant-time — it returns early on the
 * first differing byte. This is SAFE because the inputs are public Ed25519
 * long-term pubkeys that are already transmitted in cleartext over the QR
 * code / introduction channel. The byte values being compared are not
 * secret, so leaking the first-differing-byte position via timing reveals
 * nothing an attacker does not already know. The ordering result only
 * determines canonical array position in the CBOR safety-number input; it
 * does not gate any security decision on secret data. A constant-time
 * version (isAliceRole in intro-crypto.ts) exists where the comparison
 * itself IS security-relevant (role assignment). See ADR-012.
 */
function lexLess(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return a.length < b.length;
}

/** Interprets bytes as a big-endian unsigned integer. */
function bigIntFrom(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  return n;
}

/** Splits a 60-character string into 12 groups of 5 separated by spaces. */
function groupsOfFive(s: string): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += 5) {
    parts.push(s.slice(i, i + 5));
  }
  return parts.join(' ');
}
