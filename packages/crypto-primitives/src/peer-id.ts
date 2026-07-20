import { sha256 } from '@noble/hashes/sha2.js';

export function derivePeerIdTarget(x25519PubKey: Uint8Array): Uint8Array {
	if (x25519PubKey.byteLength !== 32) {
		throw new Error('crypto-primitives/peer-id: x25519 pubkey must be 32 bytes');
	}
	return sha256(x25519PubKey).slice(0, 8);
}
