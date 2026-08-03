// envelope-v3-bench.test.ts — realistic benchmark for v1/v2/v3 envelope sizes.
//
// The existing wire-codec.bench.test.ts uses `'b'.repeat(64)` for `from` —
// a repeating single byte that zstd compresses extremely well. Real Ed25519
// pubkeys are random hex (0-9a-f), which zstd barely compresses. This bench
// measures the ACTUAL wire savings of v3 (peer-index) vs v2 vs v1 using:
//
//   - Realistic random hex pubkeys (64-char, uniform random hex digits)
//   - Realistic UUIDs (proper format with random hex)
//   - Each shipped dict (RU/FA/EN) + dictless
//   - Multiple body sizes (2 chars → 200 chars)
//
// The v3 savings should be largest for short messages (where envelope overhead
// dominates) and smallest for long messages (where body dominates).
//
// This is an INFORMATIONAL bench — assertions only check v3 <= v2 <= v1.
// The absolute numbers are logged for human review.

import { describe, it, expect, beforeAll } from 'vitest';
import { encode, ensureWireCodecReady } from '../codec.ts';
import { ROOM_EPOCH } from '../envelope-v2.ts';

// Deterministic PRNG (xorshift32) — reproducible bench runs.
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5; s >>>= 0;
		return s;
	};
}

const HEX = '0123456789abcdef';

function randomHex(rng: () => number, len: number): string {
	const chars: string[] = new Array(len);
	for (let i = 0; i < len; i++) chars[i] = HEX[rng() & 0xf];
	return chars.join('');
}

function randomUuid(rng: () => number): string {
	// UUID v4 format: 8-4-4-4-12 with version/variant bits.
	const p = (n: number) => randomHex(rng, n);
	return `${p(8)}-${p(4)}-4${p(3)}-a${p(3)}-${p(12)}`;
}

beforeAll(async () => {
	await ensureWireCodecReady();
});

describe('envelope-v3 realistic bench (random hex pubkeys)', () => {
	// Generate 5 different realistic envelopes with random pubkeys.
	const samples = Array.from({ length: 5 }, (_, i) => {
		const rngLocal = makeRng(0xb3e0c001 + i * 7919);
		return {
			uuid: randomUuid(rngLocal),
			from: randomHex(rngLocal, 64),
			ts: ROOM_EPOCH + 60_000 + i * 1000,
		};
	});

	const bodies: Array<{ name: string; body: string }> = [
		{ name: '2 chars (ок)', body: 'ок' },
		{ name: '10 chars', body: 'Привет, как дела?' },
		{ name: '50 chars', body: 'Привет! Я уже еду к тебе, буду примерно через 20 минут, жди' },
		{ name: '100 chars', body: 'A'.repeat(100) },
		{ name: '200 chars', body: 'Привет! Это длинное сообщение для теста сжатия. '.repeat(5) },
	];

	const dicts: Array<{ name: string; dict: undefined | 'zstd-dict-ru-v1' | 'zstd-dict-fa-v1' | 'zstd-dict-en-v1' }> = [
		{ name: 'dictless', dict: undefined },
		{ name: 'RU dict', dict: 'zstd-dict-ru-v1' },
		{ name: 'FA dict', dict: 'zstd-dict-fa-v1' },
		{ name: 'EN dict', dict: 'zstd-dict-en-v1' },
	];

	for (const dictCase of dicts) {
		describe(`${dictCase.name}`, () => {
			for (const bodyCase of bodies) {
				const bodyName = bodyCase.name;
				it(`v1 vs v2 vs v3 — ${bodyName}`, () => {
					// Use first sample envelope (deterministic).
					const s = samples[0]!;
					const env = {
						v: 1,
						id: s.uuid,
						ts: s.ts,
						from: s.from,
						kind: 'chat-msg',
						body: bodyCase.body,
					};
					const opts = { cbor: true, zstd: true } as const;
					const v1 = encode(env, { ...opts, envelope: 1, ...(dictCase.dict ? { dict: dictCase.dict } : {}) });
					const v2 = encode(env, { ...opts, envelope: 2, ...(dictCase.dict ? { dict: dictCase.dict } : {}) });
					const v3 = encode(env, { ...opts, envelope: 3, peerIndex: 0, ...(dictCase.dict ? { dict: dictCase.dict } : {}) });

					const v2Savings = v1.length - v2.length;
					const v3Savings = v1.length - v3.length;
					const v3VsV2 = v2.length - v3.length;

					// eslint-disable-next-line no-console
					console.log(
						`[v3-bench] ${dictCase.name.padEnd(10)} ${bodyName.padEnd(20)}: ` +
						`v1=${String(v1.length).padStart(4)}B  ` +
						`v2=${String(v2.length).padStart(4)}B (Δ${v2Savings >= 0 ? '-' : '+'}${Math.abs(v2Savings)}B)  ` +
						`v3=${String(v3.length).padStart(4)}B (Δ${v3Savings >= 0 ? '-' : '+'}${Math.abs(v3Savings)}B vs v1, ${v3VsV2 >= 0 ? '-' : '+'}${Math.abs(v3VsV2)}B vs v2)`,
					);

					// Assertions: v3 <= v2 <= v1 (envelope compaction never grows).
					expect(v2.length).toBeLessThanOrEqual(v1.length);
					expect(v3.length).toBeLessThanOrEqual(v2.length);
					expect(v3.length).toBeGreaterThan(0);
				});
			}
		});
	}

	it('v3 savings summary across all 5 random pubkeys (dictless, 2-char body)', () => {
		const savings: number[] = [];
		for (const s of samples) {
			const env = {
				v: 1, id: s.uuid, ts: s.ts, from: s.from,
				kind: 'chat-msg', body: 'ок',
			};
			const v2 = encode(env, { cbor: true, zstd: true, envelope: 2 });
			const v3 = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
			savings.push(v2.length - v3.length);
		}
		const min = Math.min(...savings);
		const max = Math.max(...savings);
		const avg = (savings.reduce((a, b) => a + b, 0) / savings.length).toFixed(1);
		// eslint-disable-next-line no-console
		console.log(`[v3-bench-summary] v2→v3 savings (dictless, "ок", 5 random pubkeys): min=${min}B max=${max}B avg=${avg}B`);
		// v3 should save at least 1 byte vs v2 for every random pubkey.
		expect(Math.min(...savings)).toBeGreaterThan(0);
	});

	it('v3 with dict savings summary (RU dict, 2-char body, 5 random pubkeys)', () => {
		const savings: number[] = [];
		for (const s of samples) {
			const env = {
				v: 1, id: s.uuid, ts: s.ts, from: s.from,
				kind: 'chat-msg', body: 'ок',
			};
			const v2 = encode(env, { cbor: true, zstd: true, envelope: 2, dict: 'zstd-dict-ru-v1' });
			const v3 = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0, dict: 'zstd-dict-ru-v1' });
			savings.push(v2.length - v3.length);
		}
		const min = Math.min(...savings);
		const max = Math.max(...savings);
		const avg = (savings.reduce((a, b) => a + b, 0) / savings.length).toFixed(1);
		// eslint-disable-next-line no-console
		console.log(`[v3-bench-summary] v2→v3 savings (RU dict, "ок", 5 random pubkeys): min=${min}B max=${max}B avg=${avg}B`);
		expect(Math.min(...savings)).toBeGreaterThan(0);
	});
});
