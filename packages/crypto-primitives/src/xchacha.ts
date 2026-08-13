/**
 * XChaCha20-Poly1305 AEAD with key commitment.
 *
 * XChaCha20 uses a 24-byte (192-bit) nonce, making random-nonce selection safe
 * up to 2^80 messages per key — vs AES-GCM's 2^32 birthday bound with a
 * 96-bit nonce. This eliminates the catastrophic nonce-reuse footgun for
 * callers using static keys.
 *
 * Key commitment: an 8-byte HMAC-SHA256(key, "oxp/commit/v1") prefix is
 * prepended to the ciphertext. On open, the commitment is verified before
 * AEAD decryption — if the key is wrong, the commitment check fails and the
 * AEAD is never invoked. This prevents partition oracle attacks (CCS '21,
 * Albert-Lück et al. USENIX Security 2022) where a ciphertext validates
 * under multiple keys, leaking which key was used.
 *
 * Wire format: commit[8] ‖ nonce[24] ‖ ct_and_tag[...]
 *   - commit: HMAC-SHA256(key, "oxp/commit/v1")[0..7]
 *   - nonce: 24-byte random nonce
 *   - ct_and_tag: XChaCha20-Poly1305 ciphertext + 16-byte Poly1305 tag
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { zeroize } from './zeroize.ts';

const COMMIT_LABEL = new TextEncoder().encode('oxp/commit/v1');
const COMMIT_LEN = 8; // 64-bit commitment prefix
const NONCE_LEN = 24; // XChaCha20 nonce
const TAG_LEN = 16; // Poly1305 tag

/**
 * Compute the 8-byte key commitment: HMAC-SHA256(key, label)[0..7].
 */
function computeCommitment(key: Uint8Array): Uint8Array {
	const full = hmac(sha256, key, COMMIT_LABEL);
	return full.slice(0, COMMIT_LEN);
}

/**
 * Seal plaintext with XChaCha20-Poly1305 + key commitment.
 *
 * @param key       32-byte symmetric key
 * @param nonce     24-byte nonce (use `crypto.getRandomValues` for random)
 * @param aad       Additional authenticated data (cleartext, authenticated)
 * @param plaintext Plaintext to encrypt
 * @returns         commit[8] ‖ nonce[24] ‖ ct_and_tag[...]
 */
export function xchachaSeal(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	plaintext: Uint8Array,
): Uint8Array {
	if (key.byteLength !== 32) throw new Error('crypto-primitives/xchacha: key must be 32 bytes');
	if (nonce.byteLength !== NONCE_LEN) throw new Error(`crypto-primitives/xchacha: nonce must be ${NONCE_LEN} bytes`);

	const commit = computeCommitment(key);
	const cipher = xchacha20poly1305(key, nonce, aad);
	const ctAndTag = cipher.encrypt(plaintext);

	// Wire: commit[8] ‖ nonce[24] ‖ ct_and_tag[...]
	return concatBytes(commit, nonce, ctAndTag);
}

/**
 * Open XChaCha20-Poly1305 ciphertext with key commitment verification.
 *
 * Verifies the key commitment BEFORE AEAD decryption — if the commitment
 * does not match, fails immediately without invoking the AEAD (prevents
 * partition oracle).
 *
 * @param key        32-byte symmetric key
 * @param aad        Additional authenticated data (must match seal)
 * @param sealed     commit[8] ‖ nonce[24] ‖ ct_and_tag[...] (output of xchachaSeal)
 * @returns          Plaintext
 * @throws           If commitment mismatch or AEAD authentication fails
 */
export function xchachaOpen(key: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
	if (key.byteLength !== 32) throw new Error('crypto-primitives/xchacha: key must be 32 bytes');
	if (sealed.byteLength < COMMIT_LEN + NONCE_LEN + TAG_LEN) {
		throw new Error('crypto-primitives/xchacha: sealed too short');
	}

	const expectedCommit = computeCommitment(key);
	const actualCommit = sealed.subarray(0, COMMIT_LEN);

	// Best-effort constant-time commitment check — prevents partition oracle.
	// XOR-reduce: if any byte differs, the OR accumulates to non-zero.
	// NOTE: JS provides no constant-time guarantees (JIT may short-circuit).
	// For true constant-time, use WASM-based crypto (e.g. libsodium).
	let diff = 0;
	for (let i = 0; i < COMMIT_LEN; i++) {
		diff |= expectedCommit[i]! ^ actualCommit[i]!;
	}
	zeroize(expectedCommit);
	if (diff !== 0) {
		throw new Error('crypto-primitives/xchacha: key commitment mismatch');
	}

	const nonce = sealed.subarray(COMMIT_LEN, COMMIT_LEN + NONCE_LEN);
	const ctAndTag = sealed.subarray(COMMIT_LEN + NONCE_LEN);

	const decipher = xchacha20poly1305(key, nonce, aad);
	let plaintext: Uint8Array;
	try {
		plaintext = decipher.decrypt(ctAndTag);
	} catch {
		throw new Error('crypto-primitives/xchacha: AEAD authentication failed');
	}
	return plaintext;
}

/**
 * Generate a random 24-byte nonce for XChaCha20-Poly1305.
 * Safe to use with random nonces up to 2^80 messages per key.
 */
export function xchachaRandomNonce(): Uint8Array {
	try {
		return crypto.getRandomValues(new Uint8Array(NONCE_LEN));
	} catch {
		throw new Error('crypto-primitives/xchacha: CSPRNG failure — cannot generate nonce');
	}
}
