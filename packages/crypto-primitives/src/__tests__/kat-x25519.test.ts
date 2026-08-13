import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { generateEphemeralKeypair, deriveSharedSecret } from '../x25519.ts';

// RFC 7748 §6.1 — X25519 test vectors.
// https://datatracker.ietf.org/doc/html/rfc7748#section-6.1


describe('KAT: RFC 7748 §6.1 X25519', () => {
	// Vector 1 — Alice and Bob's keys + shared secret
	const v1 = {
		alicePriv: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
		alicePub: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
		bobPriv: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
		bobPub: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
		shared: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
	};

	it('vector 1: Alice private + Bob public → correct shared secret', () => {
		const alicePriv = hexToBytes(v1.alicePriv);
		const bobPub = hexToBytes(v1.bobPub);
		const shared = deriveSharedSecret(alicePriv, bobPub);
		expect(shared).toEqual(hexToBytes(v1.shared));
	});

	it('vector 1: Bob private + Alice public → correct shared secret (DH symmetry)', () => {
		const bobPriv = hexToBytes(v1.bobPriv);
		const alicePub = hexToBytes(v1.alicePub);
		const shared = deriveSharedSecret(bobPriv, alicePub);
		expect(shared).toEqual(hexToBytes(v1.shared));
	});

	it('vector 1: both directions produce identical shared secret', () => {
		const alicePriv = hexToBytes(v1.alicePriv);
		const bobPriv = hexToBytes(v1.bobPriv);
		const alicePub = hexToBytes(v1.alicePub);
		const bobPub = hexToBytes(v1.bobPub);

		const ss1 = deriveSharedSecret(alicePriv, bobPub);
		const ss2 = deriveSharedSecret(bobPriv, alicePub);
		expect(ss1).toEqual(ss2);
	});

	it('vector 1: shared secret is 32 bytes', () => {
		const alicePriv = hexToBytes(v1.alicePriv);
		const bobPub = hexToBytes(v1.bobPub);
		const shared = deriveSharedSecret(alicePriv, bobPub);
		expect(shared.byteLength).toBe(32);
	});

	// Vector 2 — RFC 7748 §6.1 iteration test (1-bit change)
	// This is a single-party test (scalar applied to a u-coordinate), not a DH exchange.
	// scalar: a546e36b..., u-coord: e6db6867..., output: c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552
	const v2 = {
		scalar: 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
		uCoord: 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
		output: 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
	};

	it('vector 2: scalar multiplication matches RFC 7748 §6.1', () => {
		const scalar = hexToBytes(v2.scalar);
		const uCoord = hexToBytes(v2.uCoord);
		const output = deriveSharedSecret(scalar, uCoord);
		expect(output).toEqual(hexToBytes(v2.output));
	});

	it('generateEphemeralKeypair: DH symmetry holds for random keys', () => {
		const alice = generateEphemeralKeypair();
		const bob = generateEphemeralKeypair();
		const ss1 = deriveSharedSecret(alice.privateKey, bob.publicKey);
		const ss2 = deriveSharedSecret(bob.privateKey, alice.publicKey);
		expect(ss1).toEqual(ss2);
		expect(ss1.byteLength).toBe(32);
		expect(ss1.some((b) => b !== 0)).toBe(true);
	});
});
