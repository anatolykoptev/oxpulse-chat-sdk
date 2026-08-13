import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

// RFC 8032 §7.1 — Ed25519 test vectors.
// https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1
//
// We verify via @noble/curves (our dependency) to confirm the library
// matches the standard. This is a KAT for the underlying Ed25519
// implementation that pairwise-seal.ts relies on for signatures.

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return out;
}

describe('KAT: RFC 8032 §7.1 Ed25519', () => {
	// -----TEST 1: empty message
	const tv1 = {
		secretKey: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
		publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
		message: '',
		signature:
			'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
	};

	it('TV1: getPublicKey matches RFC 8032', () => {
		const sk = hexToBytes(tv1.secretKey);
		const pk = ed25519.getPublicKey(sk);
		expect(pk).toEqual(hexToBytes(tv1.publicKey));
	});

	it('TV1: sign(empty message) matches RFC 8032', () => {
		const sk = hexToBytes(tv1.secretKey);
		const msg = new Uint8Array(0);
		const sig = ed25519.sign(msg, sk);
		expect(sig).toEqual(hexToBytes(tv1.signature));
	});

	it('TV1: verify accepts the RFC 8032 signature', () => {
		const pk = hexToBytes(tv1.publicKey);
		const msg = new Uint8Array(0);
		const sig = hexToBytes(tv1.signature);
		expect(ed25519.verify(sig, msg, pk)).toBe(true);
	});

	// -----TEST 2: 1-byte message (0x72)
	const tv2 = {
		secretKey: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
		publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
		message: '72',
		signature:
			'92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
	};

	it('TV2: getPublicKey matches RFC 8032', () => {
		const sk = hexToBytes(tv2.secretKey);
		const pk = ed25519.getPublicKey(sk);
		expect(pk).toEqual(hexToBytes(tv2.publicKey));
	});

	it('TV2: sign(1-byte message) matches RFC 8032', () => {
		const sk = hexToBytes(tv2.secretKey);
		const msg = hexToBytes(tv2.message);
		const sig = ed25519.sign(msg, sk);
		expect(sig).toEqual(hexToBytes(tv2.signature));
	});

	it('TV2: verify accepts the RFC 8032 signature', () => {
		const pk = hexToBytes(tv2.publicKey);
		const msg = hexToBytes(tv2.message);
		const sig = hexToBytes(tv2.signature);
		expect(ed25519.verify(sig, msg, pk)).toBe(true);
	});

	// Negative tests
	it('rejects tampered signature', () => {
		const pk = hexToBytes(tv1.publicKey);
		const msg = new Uint8Array(0);
		const sig = hexToBytes(tv1.signature);
		sig[0] ^= 0xff;
		expect(ed25519.verify(sig, msg, pk)).toBe(false);
	});

	it('rejects tampered message', () => {
		const pk = hexToBytes(tv2.publicKey);
		const msg = hexToBytes(tv2.message);
		const sig = hexToBytes(tv2.signature);
		const tamperedMsg = new Uint8Array([0x73]); // 0x72 → 0x73
		expect(ed25519.verify(sig, tamperedMsg, pk)).toBe(false);
	});

	it('rejects wrong public key', () => {
		const pk1 = hexToBytes(tv1.publicKey);
		const pk2 = hexToBytes(tv2.publicKey);
		const msg = new Uint8Array(0);
		const sig = hexToBytes(tv1.signature);
		expect(ed25519.verify(sig, msg, pk2)).toBe(false);
	});

	// Strict mode (zip215: false) — aligns with server dalek::verify_strict
	it('strict mode: rejects small-order pubkey', () => {
		const kp = ed25519.keygen();
		const msg = new TextEncoder().encode('test');
		const sig = ed25519.sign(msg, kp.secretKey);

		// Identity point (y=1, x=0): compressed LE = 0x01 + 31 zeros
		const smallOrderPub = new Uint8Array(32);
		smallOrderPub[0] = 0x01;

		expect(ed25519.verify(sig, msg, smallOrderPub, { zip215: false })).toBe(false);
	});

	// Determinism: same key + message → same signature (Ed25519 is deterministic)
	it('determinism: same key + message → same signature', () => {
		const sk = hexToBytes(tv1.secretKey);
		const msg = new Uint8Array(0);
		const sig1 = ed25519.sign(msg, sk);
		const sig2 = ed25519.sign(msg, sk);
		expect(sig1).toEqual(sig2);
	});
});
