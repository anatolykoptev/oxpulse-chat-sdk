import { describe, it, expect } from 'vitest';
import { deriveKey, hkdfExtract, hkdfExpand } from '../hkdf.ts';

// RFC 5869 §A — HKDF-SHA256 test vectors.
// https://datatracker.ietf.org/doc/html/rfc5869#appendix-A

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return out;
}

describe('KAT: RFC 5869 §A HKDF-SHA256', () => {
	// Test Case 1 — Basic test with SHA-256
	// IKM = 22 bytes of 0x0b, salt = 13 bytes, info = 10 bytes, L = 42
	const tc1 = {
		ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', // 22 octets
		salt: '000102030405060708090a0b0c', // 13 octets
		info: 'f0f1f2f3f4f5f6f7f8f9', // 10 octets
		prk: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
		okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
		okmLen: 42,
	};

	it('TC1: hkdfExtract produces correct PRK', () => {
		const prk = hkdfExtract(hexToBytes(tc1.ikm), hexToBytes(tc1.salt));
		expect(prk).toEqual(hexToBytes(tc1.prk));
	});

	it('TC1: hkdfExpand produces correct OKM', () => {
		const prk = hexToBytes(tc1.prk);
		const okm = hkdfExpand(prk, hexToBytes(tc1.info), tc1.okmLen);
		expect(okm).toEqual(hexToBytes(tc1.okm));
	});

	it('TC1: deriveKey (extract+expand) matches extract-then-expand', () => {
		const ikm = hexToBytes(tc1.ikm);
		const salt = hexToBytes(tc1.salt);
		const info = hexToBytes(tc1.info);

		const viaDeriveKey = deriveKey(ikm, salt, info, tc1.okmLen);
		const viaSplit = hkdfExpand(hkdfExtract(ikm, salt), info, tc1.okmLen);
		expect(viaDeriveKey).toEqual(viaSplit);
	});

	it('TC1: deriveKey produces correct OKM directly', () => {
		const okm = deriveKey(hexToBytes(tc1.ikm), hexToBytes(tc1.salt), hexToBytes(tc1.info), tc1.okmLen);
		expect(okm).toEqual(hexToBytes(tc1.okm));
	});

	// Test Case 3 — SHA-256, zero-length salt and info
	const tc3 = {
		ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', // 22 octets
		salt: '',
		info: '',
		prk: '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
		okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
		okmLen: 42,
	};

	it('TC3: hkdfExtract with empty salt produces correct PRK', () => {
		const prk = hkdfExtract(hexToBytes(tc3.ikm), new Uint8Array(0));
		expect(prk).toEqual(hexToBytes(tc3.prk));
	});

	it('TC3: hkdfExpand with empty info produces correct OKM', () => {
		const prk = hexToBytes(tc3.prk);
		const okm = hkdfExpand(prk, new Uint8Array(0), tc3.okmLen);
		expect(okm).toEqual(hexToBytes(tc3.okm));
	});

	it('TC3: deriveKey with empty salt+info produces correct OKM', () => {
		const okm = deriveKey(hexToBytes(tc3.ikm), new Uint8Array(0), new Uint8Array(0), tc3.okmLen);
		expect(okm).toEqual(hexToBytes(tc3.okm));
	});
});
