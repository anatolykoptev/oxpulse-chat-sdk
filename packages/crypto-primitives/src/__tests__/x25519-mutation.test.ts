import { describe, it, expect } from 'vitest';
import { generateEphemeralKeypair, deriveSharedSecret } from '../x25519.ts';

describe('x25519 — mutation-killing tests', () => {
	it('rejects all-zero shared secret (low-order point defense, RFC 7748 §6.1)', () => {
		// The identity point (x=0) produces an all-zero shared secret.
		// We can't easily craft a key that produces all-zero SS without
		// knowing the low-order points, but we CAN test that the check
		// exists by verifying deriveSharedSecret throws on a key that
		// produces all-zero output.
		//
		// X25519 low-order point: the all-zero public key (0x00 * 32)
		// produces an all-zero shared secret with any private key.
		const { privateKey } = generateEphemeralKeypair();
		const zeroPub = new Uint8Array(32); // all-zero = identity point
		expect(() => deriveSharedSecret(privateKey, zeroPub)).toThrow(
			/invalid public key/i,
		);
	});

	it('low-order point: all-zero pub key throws regardless of priv key', () => {
		// Test with multiple private keys to ensure the check is deterministic
		for (let i = 0; i < 5; i++) {
			const { privateKey } = generateEphemeralKeypair();
			const zeroPub = new Uint8Array(32);
			expect(() => deriveSharedSecret(privateKey, zeroPub)).toThrow();
		}
	});
});
