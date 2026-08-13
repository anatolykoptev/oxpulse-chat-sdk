import { describe, it, expect } from 'vitest';
import { xchachaSeal, xchachaOpen, xchachaRandomNonce } from '../xchacha.ts';

describe('xchacha20-poly1305 + key commitment', () => {
	const key = new Uint8Array(32).fill(0x42);
	const aad = new TextEncoder().encode('test-aad');
	const plaintext = new TextEncoder().encode('hello xchacha20-poly1305 world');

	it('round-trip: seal → open returns original plaintext', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		const decrypted = xchachaOpen(key, aad, sealed);
		expect(decrypted).toEqual(plaintext);
	});

	it('sealed output is commit[8] + nonce[24] + ct_and_tag[pt+16]', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		// 8 commit + 24 nonce + plaintext.length + 16 tag
		expect(sealed.byteLength).toBe(8 + 24 + plaintext.length + 16);
	});

	it('nonce is embedded in sealed output at offset 8', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		const embeddedNonce = sealed.subarray(8, 32);
		expect(embeddedNonce).toEqual(nonce);
	});

	it('key commitment mismatch: wrong key → open fails (partition oracle defense)', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		const wrongKey = new Uint8Array(32).fill(0x99);
		expect(() => xchachaOpen(wrongKey, aad, sealed)).toThrow('commitment mismatch');
	});

	it('wrong AAD → open fails', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		const wrongAad = new TextEncoder().encode('wrong-aad');
		expect(() => xchachaOpen(key, wrongAad, sealed)).toThrow();
	});

	it('tampered ciphertext → open fails', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		sealed[sealed.byteLength - 1] ^= 0xff; // flip last byte (tag)
		expect(() => xchachaOpen(key, aad, sealed)).toThrow();
	});

	it('tampered commitment → open fails', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		sealed[0] ^= 0xff; // flip first commit byte
		expect(() => xchachaOpen(key, aad, sealed)).toThrow('commitment mismatch');
	});

	it('tampered nonce → open fails', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, plaintext);
		sealed[8] ^= 0xff; // flip first nonce byte
		expect(() => xchachaOpen(key, aad, sealed)).toThrow();
	});

	it('sealed too short → open fails', () => {
		const tooShort = new Uint8Array(8 + 24 + 15); // < 8+24+16
		expect(() => xchachaOpen(key, aad, tooShort)).toThrow('too short');
	});

	it('wrong key length → seal throws', () => {
		const badKey = new Uint8Array(16);
		const nonce = xchachaRandomNonce();
		expect(() => xchachaSeal(badKey, nonce, aad, plaintext)).toThrow('key must be 32 bytes');
	});

	it('wrong nonce length → seal throws', () => {
		const badNonce = new Uint8Array(12);
		expect(() => xchachaSeal(key, badNonce, aad, plaintext)).toThrow('nonce must be 24 bytes');
	});

	it('determinism: same key + nonce + aad + plaintext → same sealed output', () => {
		const nonce = new Uint8Array(24).fill(0x01);
		const sealed1 = xchachaSeal(key, nonce, aad, plaintext);
		const sealed2 = xchachaSeal(key, nonce, aad, plaintext);
		expect(sealed1).toEqual(sealed2);
	});

	it('empty plaintext → round-trip succeeds', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, aad, new Uint8Array(0));
		expect(sealed.byteLength).toBe(8 + 24 + 0 + 16); // commit + nonce + tag only
		const decrypted = xchachaOpen(key, aad, sealed);
		expect(decrypted.byteLength).toBe(0);
	});

	it('empty AAD → round-trip succeeds', () => {
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(key, nonce, new Uint8Array(0), plaintext);
		const decrypted = xchachaOpen(key, new Uint8Array(0), sealed);
		expect(decrypted).toEqual(plaintext);
	});

	it('random nonce: 2^0 different nonces do not collide (basic sanity)', () => {
		const nonces = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			nonces.add(Buffer.from(xchachaRandomNonce()).toString('hex'));
		}
		// All 1000 random 24-byte nonces should be unique
		expect(nonces.size).toBe(1000);
	});

	it('partition oracle: ciphertext under key A fails under key B (not silently succeeds)', () => {
		const keyA = new Uint8Array(32).fill(0x01);
		const keyB = new Uint8Array(32).fill(0x02);
		const nonce = xchachaRandomNonce();
		const sealed = xchachaSeal(keyA, nonce, aad, plaintext);

		// Must fail — not silently decrypt to garbage under keyB
		expect(() => xchachaOpen(keyB, aad, sealed)).toThrow('commitment mismatch');
	});
});
