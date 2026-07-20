import { x25519 } from '@noble/curves/ed25519.js';

export function generateEphemeralKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
	const kp = x25519.keygen();
	return { privateKey: kp.secretKey, publicKey: kp.publicKey };
}

export function deriveSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
	let ss: Uint8Array;
	try {
		ss = x25519.getSharedSecret(privateKey, publicKey);
	} catch {
		throw new Error('crypto-primitives/x25519: invalid public key');
	}
	// Defense against low-order points that produce a zero shared secret per RFC 7748 §6.1.
	// A zero shared secret leaks a known value into HKDF, making derived keys predictable.
	if (ss.every((b) => b === 0)) {
		throw new Error('crypto-primitives/x25519: invalid public key');
	}
	return ss;
}
