import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * HKDF-Extract (RFC 5869 §2.2) with SHA-256.
 *
 * Extracts a fixed-length pseudorandom key (PRK) from input keying material.
 * Use when you need to derive multiple independent keys from the same IKM —
 * call `hkdfExtract` once, then `hkdfExpand` multiple times with different
 * `info` labels (e.g., Double Ratchet root/chain/message key derivation).
 *
 * @param ikm  Input keying material (e.g., X25519 shared secret)
 * @param salt Salt (≥128-bit random recommended; empty salt is valid per RFC 5869)
 * @returns 32-byte PRK
 */
export function hkdfExtract(ikm: Uint8Array, salt: Uint8Array): Uint8Array {
	return extract(sha256, ikm, salt);
}

/**
 * HKDF-Expand (RFC 5869 §2.3) with SHA-256.
 *
 * Expands a PRK (from `hkdfExtract`) into length-bytes of pseudorandom output.
 * The `info` field provides domain separation — use a protocol-specific label
 * like `"oxp/pairwise/v1"` (RFC 5869 §3.2).
 *
 * @param prk    Pseudorandom key from `hkdfExtract` (must be 32 bytes for SHA-256)
 * @param info   Domain-separation context string
 * @param length Output length in bytes (≤255×32=8160 for SHA-256)
 * @returns Derived key material
 */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number = 32): Uint8Array {
	return expand(sha256, prk, info, length);
}

/**
 * HKDF-SHA256 extract-then-expand convenience wrapper (RFC 5869).
 *
 * Equivalent to `hkdfExpand(hkdfExtract(ikm, salt), info, length)`.
 * Prefer `hkdfExtract` + `hkdfExpand` separately when deriving multiple keys
 * from the same IKM (avoids redundant extract calls).
 */
export function deriveKey(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number = 32,
): Uint8Array {
	const prk = extract(sha256, ikm, salt);
	return expand(sha256, prk, info, length);
}
