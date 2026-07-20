import { describe, it, expect } from 'vitest';
import { aesGcmSeal, aesGcmOpen } from '../aead.ts';

function randomBytes(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

describe('aead', () => {
	it('round-trip: seal then open returns same plaintext', async () => {
		const key = randomBytes(32);
		const nonce = randomBytes(12);
		const aad = new TextEncoder().encode('test-aad');
		const plaintext = new TextEncoder().encode('hello, aead!');

		const ct = await aesGcmSeal(key, nonce, aad, plaintext);
		const pt = await aesGcmOpen(key, nonce, aad, ct);
		expect(pt).toEqual(plaintext);
	});

	it('tamper: flip last byte → open throws', async () => {
		const key = randomBytes(32);
		const nonce = randomBytes(12);
		const aad = new TextEncoder().encode('aad');
		const plaintext = new TextEncoder().encode('secret');

		const ct = await aesGcmSeal(key, nonce, aad, plaintext);
		ct[ct.length - 1] ^= 0xff;
		await expect(aesGcmOpen(key, nonce, aad, ct)).rejects.toThrow();
	});

	it('AAD mismatch → open throws', async () => {
		const key = randomBytes(32);
		const nonce = randomBytes(12);
		const aad = new TextEncoder().encode('correct-aad');
		const wrongAad = new TextEncoder().encode('wrong-aad');
		const plaintext = new TextEncoder().encode('secret');

		const ct = await aesGcmSeal(key, nonce, aad, plaintext);
		await expect(aesGcmOpen(key, nonce, wrongAad, ct)).rejects.toThrow();
	});

	it('rejects non-32-byte key', async () => {
		const badKey = randomBytes(16);
		const nonce = randomBytes(12);
		const aad = new Uint8Array(0);
		const pt = new TextEncoder().encode('x');
		await expect(aesGcmSeal(badKey, nonce, aad, pt)).rejects.toThrow(
			'crypto-primitives/aead: key must be 32 bytes',
		);
	});

	it('rejects non-12-byte nonce', async () => {
		const key = randomBytes(32);
		const badNonce = randomBytes(8);
		const aad = new Uint8Array(0);
		const pt = new TextEncoder().encode('x');
		await expect(aesGcmSeal(key, badNonce, aad, pt)).rejects.toThrow(
			'crypto-primitives/aead: nonce must be 12 bytes',
		);
	});
});
