import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export function deriveKey(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number = 32,
): Uint8Array {
	const prk = extract(sha256, ikm, salt);
	return expand(sha256, prk, info, length);
}
