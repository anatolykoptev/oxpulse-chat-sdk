import { describe, it, expect } from 'vitest';
import { deriveKey } from '../hkdf.ts';

// RFC 5869 §A.1 — Test Case 1 (SHA-256)
// https://www.rfc-editor.org/rfc/rfc5869#appendix-A.1
const hex = (s: string) => new Uint8Array(s.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

describe('hkdf', () => {
	it('RFC 5869 §A.1 — Test Case 1 (L=42)', () => {
		const ikm = hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'); // 22 bytes
		const salt = hex('000102030405060708090a0b0c'); // 13 bytes
		const info = hex('f0f1f2f3f4f5f6f7f8f9'); // 10 bytes
		const expected = hex(
			'3cb25f25faacd57a90434f64d0362f2a' +
				'2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
				'34007208d5b887185865',
		); // 42 bytes
		const okm = deriveKey(ikm, salt, info, 42);
		expect(okm).toEqual(expected);
	});

	it('returns 32 bytes by default', () => {
		const ikm = new Uint8Array(32).fill(0x42);
		const salt = new Uint8Array(32).fill(0x11);
		const info = new Uint8Array(8).fill(0xaa);
		const okm = deriveKey(ikm, salt, info);
		expect(okm.byteLength).toBe(32);
	});

	it('deterministic: same inputs → same output', () => {
		const ikm = new Uint8Array(32).fill(1);
		const salt = new Uint8Array(32).fill(2);
		const info = new Uint8Array(8).fill(3);
		expect(deriveKey(ikm, salt, info, 32)).toEqual(deriveKey(ikm, salt, info, 32));
	});
});
