import { describe, it, expect } from 'vitest';
import { aesGcmSeal, aesGcmOpen } from '../aead.ts';

// NIST GCM test vectors — AES-256-GCM
// Source: NIST GCM Validation Program
// https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program/cavp-testing-block-cipher-modes
//
// Test Case 14 from the GCM specification (McGrew & Viega, "The Galois/Counter
// Mode of Operation (GCM)"):
// AES-256, all-zero key, all-zero IV, empty plaintext, empty AAD.
// Expected tag: 530f8afbc74536b9a963b4f1c4cb738b

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return out;
}

describe('KAT: NIST AES-256-GCM', () => {
	// Test Case 14: AES-256, empty plaintext, empty AAD
	// Key = 32 zero bytes, IV = 12 zero bytes
	const tc14 = {
		key: '0000000000000000000000000000000000000000000000000000000000000000',
		iv: '000000000000000000000000',
		expectedTag: '530f8afbc74536b9a963b4f1c4cb738b',
	};

	it('TC14: empty plaintext + empty AAD → correct tag', async () => {
		const key = hexToBytes(tc14.key);
		const iv = hexToBytes(tc14.iv);
		const aad = new Uint8Array(0);
		const pt = new Uint8Array(0);

		const ct = await aesGcmSeal(key, iv, aad, pt);
		// AES-GCM with empty plaintext → output is just the 16-byte tag
		expect(ct.byteLength).toBe(16);
		expect(ct).toEqual(hexToBytes(tc14.expectedTag));
	});

	// Test Case 14 round-trip: empty plaintext decrypts to empty
	it('TC14: empty ciphertext round-trips to empty plaintext', async () => {
		const key = hexToBytes(tc14.key);
		const iv = hexToBytes(tc14.iv);
		const aad = new Uint8Array(0);
		const ct = hexToBytes(tc14.expectedTag);

		const pt = await aesGcmOpen(key, iv, aad, ct);
		expect(pt.byteLength).toBe(0);
	});

	// Test Case 15: AES-256, single block plaintext, no AAD
	// Key = all zeros, IV = all zeros, PT = one 128-bit block
	const tc15 = {
		key: '0000000000000000000000000000000000000000000000000000000000000000',
		iv: '000000000000000000000000',
		plaintext: '00000000000000000000000000000000',
		// Expected ciphertext+tag (verified via WebCrypto):
		expectedCt: 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
	};

	it('TC15: single zero block → correct ciphertext+tag', async () => {
		const key = hexToBytes(tc15.key);
		const iv = hexToBytes(tc15.iv);
		const aad = new Uint8Array(0);
		const pt = hexToBytes(tc15.plaintext);

		const ct = await aesGcmSeal(key, iv, aad, pt);
		// 16 bytes ciphertext + 16 bytes tag = 32 bytes
		expect(ct.byteLength).toBe(32);
		expect(ct).toEqual(hexToBytes(tc15.expectedCt));
	});

	it('TC15: round-trip returns original plaintext', async () => {
		const key = hexToBytes(tc15.key);
		const iv = hexToBytes(tc15.iv);
		const aad = new Uint8Array(0);
		const pt = hexToBytes(tc15.plaintext);

		const ct = await aesGcmSeal(key, iv, aad, pt);
		const decrypted = await aesGcmOpen(key, iv, aad, ct);
		expect(decrypted).toEqual(pt);
	});

	// Determinism: same key/iv/plaintext/aad → same ciphertext (KAT property)
	it('determinism: same inputs → same ciphertext', async () => {
		const key = hexToBytes(tc15.key);
		const iv = hexToBytes(tc15.iv);
		const aad = new Uint8Array(0);
		const pt = hexToBytes(tc15.plaintext);

		const ct1 = await aesGcmSeal(key, iv, aad, pt);
		const ct2 = await aesGcmSeal(key, iv, aad, pt);
		expect(ct1).toEqual(ct2);
	});

	// Non-empty AAD round-trip
	it('with AAD → round-trip returns original plaintext', async () => {
		const key = new Uint8Array(32).fill(0x42);
		const iv = new Uint8Array(12).fill(0x01);
		const aad = new TextEncoder().encode('test-aad-for-kat');
		const pt = new TextEncoder().encode('KAT plaintext for AES-256-GCM');

		const ct = await aesGcmSeal(key, iv, aad, pt);
		const decrypted = await aesGcmOpen(key, iv, aad, ct);
		expect(decrypted).toEqual(pt);
	});

	it('wrong AAD → open fails', async () => {
		const key = new Uint8Array(32).fill(0x42);
		const iv = new Uint8Array(12).fill(0x01);
		const aad = new TextEncoder().encode('correct-aad');
		const pt = new TextEncoder().encode('secret');

		const ct = await aesGcmSeal(key, iv, aad, pt);
		const wrongAad = new TextEncoder().encode('wrong-aad');
		await expect(aesGcmOpen(key, iv, wrongAad, ct)).rejects.toThrow();
	});
});
