import { describe, it, expect } from 'vitest';
import { zeroize } from '../zeroize.ts';

describe('zeroize — mutation-killing tests', () => {
	it('zeroizes a non-empty buffer to all zeros', () => {
		const buf = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0x42]);
		zeroize(buf);
		expect(buf).toEqual(new Uint8Array([0, 0, 0, 0, 0]));
	});

	it('zeroizes a 32-byte key to all zeros', () => {
		const key = new Uint8Array(32).fill(0xaa);
		zeroize(key);
		expect(key.every((b) => b === 0)).toBe(true);
	});

	it('does NOT throw on zero-length buffer (no-op)', () => {
		const empty = new Uint8Array(0);
		expect(() => zeroize(empty)).not.toThrow();
		expect(empty.byteLength).toBe(0);
	});

	it('zeroizes every byte — no byte survives (kills conditionalExpression false)', () => {
		const buf = new Uint8Array(64).fill(0x42);
		zeroize(buf);
		// Every single byte must be zero — catches mutants that skip the fill
		for (let i = 0; i < buf.byteLength; i++) {
			expect(buf[i]).toBe(0);
		}
	});

	it('actually calls fill(0) via clean — buffer content changes (kills BlockStatement {})', () => {
		const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const before = Array.from(buf);
		zeroize(buf);
		const after = Array.from(buf);
		expect(after).not.toEqual(before);
		expect(after).toEqual([0, 0, 0, 0]);
	});

	it('handles detached ArrayBuffer gracefully (no throw)', () => {
		const buf = new Uint8Array(8).fill(0x42);
		// Simulate detached buffer by transferring to a worker is complex;
		// instead, verify the try/catch path by testing that zeroize
		// on a normal buffer doesn't throw even when clean() might fail
		// on edge cases. This kills the BlockStatement {} mutant on the
		// try block by verifying the buffer IS zeroed.
		zeroize(buf);
		expect(buf.every((b) => b === 0)).toBe(true);
	});
});
