import { describe, it, expect } from 'vitest';
import { derivePeerIdTarget } from '../peer-id.ts';

describe('peer-id', () => {
	it('returns exactly 8 bytes', () => {
		const pub = crypto.getRandomValues(new Uint8Array(32));
		expect(derivePeerIdTarget(pub).byteLength).toBe(8);
	});

	it('is deterministic: same input → same output across calls', () => {
		const pub = crypto.getRandomValues(new Uint8Array(32));
		const a = derivePeerIdTarget(pub);
		const b = derivePeerIdTarget(pub);
		expect(a).toEqual(b);
	});

	it('different inputs produce different outputs (probability)', () => {
		const pub1 = crypto.getRandomValues(new Uint8Array(32));
		const pub2 = crypto.getRandomValues(new Uint8Array(32));
		// Statistically near-impossible collision in 8 bytes with random 32-byte inputs
		expect(derivePeerIdTarget(pub1)).not.toEqual(derivePeerIdTarget(pub2));
	});

	it('rejects non-32-byte input', () => {
		const badPub = new Uint8Array(16);
		expect(() => derivePeerIdTarget(badPub)).toThrow(
			'crypto-primitives/peer-id: x25519 pubkey must be 32 bytes',
		);
	});
});
