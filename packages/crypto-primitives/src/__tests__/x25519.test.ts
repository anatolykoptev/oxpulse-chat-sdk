import { describe, it, expect } from 'vitest';
import { generateEphemeralKeypair, deriveSharedSecret } from '../x25519.ts';

describe('x25519', () => {
	it('generateEphemeralKeypair returns 32-byte keys', () => {
		const kp = generateEphemeralKeypair();
		expect(kp.privateKey).toBeInstanceOf(Uint8Array);
		expect(kp.publicKey).toBeInstanceOf(Uint8Array);
		expect(kp.privateKey.byteLength).toBe(32);
		expect(kp.publicKey.byteLength).toBe(32);
	});

	it('generateEphemeralKeypair is non-deterministic', () => {
		const kp1 = generateEphemeralKeypair();
		const kp2 = generateEphemeralKeypair();
		expect(kp1.publicKey).not.toEqual(kp2.publicKey);
	});

	it('DH symmetry: deriveSharedSecret(alicePriv, bobPub) === deriveSharedSecret(bobPriv, alicePub)', () => {
		const alice = generateEphemeralKeypair();
		const bob = generateEphemeralKeypair();
		const ss1 = deriveSharedSecret(alice.privateKey, bob.publicKey);
		const ss2 = deriveSharedSecret(bob.privateKey, alice.publicKey);
		expect(ss1).toEqual(ss2);
	});

	it('rejects all-zero (low-order) public key with descriptive error', () => {
		const { privateKey } = generateEphemeralKeypair();
		const zeroPub = new Uint8Array(32);
		expect(() => deriveSharedSecret(privateKey, zeroPub)).toThrow(
			'crypto-primitives/x25519: invalid public key',
		);
	});

	// RFC 7748 §6.1 — low-order points that yield a zero shared secret.
	// Noble/curves may not reject these natively; our wrapper must detect zero output.
	it('HIGH 2 — rejects order-2 low-order point (produces zero shared secret)', () => {
		const { privateKey } = generateEphemeralKeypair();
		// Order-2 point: [0xe0, 0x..., 0x..., 0x00] — represented as 0 with high bit set,
		// i.e. the "negative" of the identity = 325606250916557431795983626356110631294008115727848805560023387167927233504 (mod p).
		// Canonical hex from RFC 7748: p = 2^255 - 19, so -1 mod p = p-1.
		// Low-order points from https://cr.yp.to/ecdh.html#validate (subset):
		const lowOrderPoints = [
			// Order 1: identity point = 0
			new Uint8Array(32),
			// Order 2: p = 2^255-19 (little-endian)
			// 2^255 - 19 = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed
			Uint8Array.from([
				0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff, 0xff, 0x7f,
			]),
			// Order 4: x = 1 (produces zero via specific sub-group arithmetic)
			Uint8Array.from([
				0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0x00, 0x00,
			]),
		];
		for (const pt of lowOrderPoints) {
			expect(
				() => deriveSharedSecret(privateKey, pt),
				`should reject low-order point ${pt[0]}...`,
			).toThrow('crypto-primitives/x25519: invalid public key');
		}
	});
});
