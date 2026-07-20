import { describe, it, expect } from 'vitest';
import { timingSafeEqual, timingSafePubkeyEqualB64u } from '../timing-safe.ts';
import { b64uEncodeBytes, b64uDecodeBytes } from '../base64url.ts';

describe('timingSafeEqual', () => {
	it('returns true for equal byte arrays', () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([1, 2, 3, 4, 5]);
		expect(timingSafeEqual(a, b)).toBe(true);
	});

	it('returns false when arrays differ in the first byte', () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([0, 2, 3, 4, 5]);
		expect(timingSafeEqual(a, b)).toBe(false);
	});

	it('returns false when arrays differ in a middle byte', () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([1, 2, 0, 4, 5]);
		expect(timingSafeEqual(a, b)).toBe(false);
	});

	it('returns false when arrays differ in the last byte', () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([1, 2, 3, 4, 0]);
		expect(timingSafeEqual(a, b)).toBe(false);
	});

	it('returns false for arrays of different lengths (length is non-secret)', () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([1, 2, 3, 4]);
		expect(timingSafeEqual(a, b)).toBe(false);
	});

	it('returns true for empty arrays (both empty)', () => {
		expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});

	it('handles max-length edge case (256 bytes) — equal', () => {
		const a = new Uint8Array(256);
		const b = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			a[i] = i;
			b[i] = i;
		}
		expect(timingSafeEqual(a, b)).toBe(true);
	});

	it('handles max-length edge case (256 bytes) — single-byte mismatch', () => {
		const a = new Uint8Array(256);
		const b = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			a[i] = i;
			b[i] = i;
		}
		b[255] = 0; // flip last byte
		expect(timingSafeEqual(a, b)).toBe(false);
	});
});

describe('timingSafePubkeyEqualB64u', () => {
	// A 32-byte pubkey encoded as base64url (no padding) = 43 chars.
	const pubkeyBytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) pubkeyBytes[i] = i + 1;
	const b64u = toB64u(pubkeyBytes);

	it('returns true for equal b64url strings', () => {
		expect(timingSafePubkeyEqualB64u(b64u, b64u)).toBe(true);
	});

	it('returns false when b64url strings differ in the first char', () => {
		const tampered = flipChar(b64u, 0);
		expect(timingSafePubkeyEqualB64u(b64u, tampered)).toBe(false);
	});

	it('returns false when b64url strings differ in the last char', () => {
		const tampered = flipChar(b64u, b64u.length - 1);
		expect(timingSafePubkeyEqualB64u(b64u, tampered)).toBe(false);
	});

	it('returns false for different-length b64url strings', () => {
		const shorter = b64u.slice(0, b64u.length - 1);
		expect(timingSafePubkeyEqualB64u(b64u, shorter)).toBe(false);
	});

	it('returns true for the same pubkey encoded as b64url (independent instances)', () => {
		const reencoded = toB64u(pubkeyBytes);
		expect(timingSafePubkeyEqualB64u(b64u, reencoded)).toBe(true);
	});

	it('does NOT throw on valid b64url input', () => {
		expect(() => timingSafePubkeyEqualB64u(b64u, b64u)).not.toThrow();
	});

	it('returns false (does NOT throw) on malformed base64url input (#218 nit #9)', () => {
		// Chars outside [A-Za-z0-9_-] — atob will throw DOMException.
		// timingSafePubkeyEqualB64u must swallow the throw and return false.
		const malformed = '!!!not-base64url!!!';
		expect(() => timingSafePubkeyEqualB64u(b64u, malformed)).not.toThrow();
		expect(timingSafePubkeyEqualB64u(b64u, malformed)).toBe(false);
		expect(timingSafePubkeyEqualB64u(malformed, b64u)).toBe(false);
		// Both malformed — still no throw, returns false.
		expect(timingSafePubkeyEqualB64u(malformed, malformed)).toBe(false);
	});
});

describe('b64uEncodeBytes / b64uDecodeBytes (#218 nit #11)', () => {
	it('round-trips arbitrary bytes', () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
		const encoded = b64uEncodeBytes(bytes);
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(encoded).not.toContain('=');
		expect(encoded).not.toContain('+');
		expect(encoded).not.toContain('/');
		const decoded = b64uDecodeBytes(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(bytes));
	});

	it('round-trips a 32-byte pubkey (43 chars)', () => {
		const pub = new Uint8Array(32);
		for (let i = 0; i < 32; i++) pub[i] = i + 100;
		const encoded = b64uEncodeBytes(pub);
		expect(encoded).toHaveLength(43);
		const decoded = b64uDecodeBytes(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(pub));
	});

	it('round-trips empty bytes', () => {
		expect(b64uEncodeBytes(new Uint8Array(0))).toBe('');
		expect(Array.from(b64uDecodeBytes(''))).toEqual([]);
	});
});

// --- helpers ---

/** Encode raw bytes to base64url (no padding). */
function toB64u(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Flip a single character at `idx` to a different valid b64url char.
 *
 * Increments by 4 (not 1) in the b64url alphabet so that the change always
 * lands in the meaningful bits — the last char of a non-multiple-of-3 byte
 * sequence has 2 or 4 zero padding bits, so +1 would only flip a padding bit
 * and leave the decoded bytes identical. */
function flipChar(s: string, idx: number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const original = s[idx]!;
	const replacement = chars[(chars.indexOf(original) + 4) % chars.length];
	return s.slice(0, idx) + replacement + s.slice(idx + 1);
}
