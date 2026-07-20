/**
 * Low-level AES-256-GCM AEAD primitive.
 *
 * **WARNING:** `aesGcmSeal` accepts a raw 32-byte key. Random nonces are safe
 * ONLY when the key is fresh per message (e.g., via ephemeral X25519 ECDH).
 * For long-lived static keys, use a counter-based nonce strategy — random
 * 96-bit nonces have a 2^32 birthday bound and risk catastrophic key reuse.
 *
 * Consumers in oxpulse-chat should prefer `pairwise-seal.ts::sealMessage`
 * which manages key derivation safely.
 */
import { toArrayBuffer } from './_internal.ts';

const TAG_BITS = 128;

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
	if (rawKey.byteLength !== 32) {
		throw new Error('crypto-primitives/aead: key must be 32 bytes');
	}
	return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
}

export async function aesGcmSeal(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	if (nonce.byteLength !== 12) throw new Error('crypto-primitives/aead: nonce must be 12 bytes');
	const k = await importAesKey(key);
	const ct = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: toArrayBuffer(nonce),
			additionalData: toArrayBuffer(aad),
			tagLength: TAG_BITS,
		},
		k,
		toArrayBuffer(plaintext),
	);
	return new Uint8Array(ct);
}

export async function aesGcmOpen(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	ciphertext: Uint8Array,
): Promise<Uint8Array> {
	if (nonce.byteLength !== 12) throw new Error('crypto-primitives/aead: nonce must be 12 bytes');
	const k = await importAesKey(key);
	const pt = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: toArrayBuffer(nonce),
			additionalData: toArrayBuffer(aad),
			tagLength: TAG_BITS,
		},
		k,
		toArrayBuffer(ciphertext),
	);
	return new Uint8Array(pt);
}
