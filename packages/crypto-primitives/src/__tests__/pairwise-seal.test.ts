import { describe, it, expect } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sealMessage, openMessage, type ReplayWindow } from '../pairwise-seal.ts';

function makeSender() {
	return {
		x: x25519.keygen(),
		e: ed25519.keygen(),
	};
}

function makeRecipient() {
	return { x: x25519.keygen() };
}

async function seal(
	sender: ReturnType<typeof makeSender>,
	recipient: ReturnType<typeof makeRecipient>,
	plaintext: Uint8Array,
	msgId?: Uint8Array,
) {
	const id = msgId ?? crypto.getRandomValues(new Uint8Array(16));
	const env = await sealMessage({
		plaintext,
		recipientX25519Pub: recipient.x.publicKey,
		senderEd25519PrivKey: sender.e.secretKey,
		senderEd25519PubKey: sender.e.publicKey,
		msgId: id,
	});
	return { env, msgId: id };
}

async function open(
	env: Uint8Array,
	recipient: ReturnType<typeof makeRecipient>,
	sender: ReturnType<typeof makeSender>,
) {
	return openMessage({
		envelopeBytes: env,
		recipientX25519Priv: recipient.x.secretKey,
		recipientX25519Pub: recipient.x.publicKey,
		expectedSenderEd25519Pub: sender.e.publicKey,
	});
}

describe('pairwise-seal', () => {
	it('round-trip: seal → open returns original plaintext, msgId, flags', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('hello pairwise');
		const msgId = crypto.getRandomValues(new Uint8Array(16));

		const { env } = await seal(sender, recipient, plaintext, msgId);
		const result = await open(env, recipient, sender);

		expect(result.plaintext).toEqual(plaintext);
		expect(result.msgId).toEqual(msgId);
		expect(result.flags).toBe(0);
	});

	it('round-trip with flags set', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('flagged');
		const msgId = crypto.getRandomValues(new Uint8Array(16));

		const env = await sealMessage({
			plaintext,
			recipientX25519Pub: recipient.x.publicKey,
			senderEd25519PrivKey: sender.e.secretKey,
			senderEd25519PubKey: sender.e.publicKey,
			msgId,
			flags: 0x01, // store_and_forward
		});

		const result = await openMessage({
			envelopeBytes: env,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
		});

		expect(result.flags).toBe(0x01);
		expect(result.plaintext).toEqual(plaintext);
	});

	it('wrong recipient key → recipientAddr cross-check fails before sig verify', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const wrongRecipient = makeRecipient();
		const plaintext = new TextEncoder().encode('secret');

		const { env } = await seal(sender, recipient, plaintext);

		// v2: recipientAddr cross-check (ADR-11) catches wrong recipient BEFORE
		// sig verification — derivePeerIdTarget(wrongPub) != env.recipientAddr.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: wrongRecipient.x.secretKey,
				recipientX25519Pub: wrongRecipient.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
			}),
		).rejects.toThrow('crypto-primitives/pairwise: recipient address mismatch');
	});

	it('tampered sender_sig → rejects before AEAD open', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('secret');

		const { env } = await seal(sender, recipient, plaintext);
		// sig starts at offset 22 (4+1+1+16=22, skip recipientAddr 8 bytes → 30)
		// Header: magic[4] version[1] flags[1] msgId[16] recipientAddr[8] = 30 bytes, then sig[64]
		const sigOffset = 30;
		env[sigOffset] ^= 0xff;

		await expect(open(env, recipient, sender)).rejects.toThrow(
			'crypto-primitives/pairwise: sender signature invalid',
		);
	});

	it('AAD msg_id swap: mutate msgId in envelope → sig verification fails', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('swap-test');

		const { env } = await seal(sender, recipient, plaintext);
		// msg_id is at offset 6 (4 magic + 1 version + 1 flags)
		const msgIdOffset = 6;
		env[msgIdOffset] ^= 0xff; // flip first byte of msgId

		await expect(open(env, recipient, sender)).rejects.toThrow(
			'crypto-primitives/pairwise: sender signature invalid',
		);
	});

	it('cross-pair replay: seal A→B, attempt open as A→C → recipientAddr mismatch', async () => {
		const sender = makeSender();
		const recipientB = makeRecipient();
		const recipientC = makeRecipient();
		const plaintext = new TextEncoder().encode('cross-pair');

		const { env } = await seal(sender, recipientB, plaintext);

		// C tries to open with their own priv key. v2: recipientAddr cross-check
		// (ADR-11) catches this before sig verify — env.recipientAddr was derived
		// from B's pub, not C's.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: recipientC.x.secretKey,
				recipientX25519Pub: recipientC.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
			}),
		).rejects.toThrow('crypto-primitives/pairwise: recipient address mismatch');
	});

	it('recipient-swap defeat: flip recipient_addr bytes → bindingDigest mismatch fails sig', async () => {
		const sender = makeSender();
		const recipientB = makeRecipient();
		const recipientC = makeRecipient();
		const plaintext = new TextEncoder().encode('recipient-swap');

		const { env } = await seal(sender, recipientB, plaintext);

		// Adversary flips recipient_addr in envelope to match C's address, then
		// provides C's priv. v2: recipientAddr cross-check passes (patched addr
		// matches C), but the bindingDigest was computed with B's recipientAddr.
		// Recomputing with the patched (C's) addr → bindingDigest mismatch → sig
		// verification fails.
		// recipientAddr is at offset 22 (4 magic + 1 version + 1 flags + 16 msgId)
		const addrOffset = 22;
		const { derivePeerIdTarget } = await import('../peer-id.ts');
		const cAddr = derivePeerIdTarget(recipientC.x.publicKey);
		env.set(cAddr, addrOffset);

		// Despite addr matching C, bindingDigest mismatch → sig fails
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: recipientC.x.secretKey,
				recipientX25519Pub: recipientC.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
			}),
		).rejects.toThrow('crypto-primitives/pairwise: sender signature invalid');
	});

	it('ephemeral non-reuse: seal same plaintext twice → different bytes', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('same-content');
		const msgId = crypto.getRandomValues(new Uint8Array(16));

		const { env: env1 } = await seal(sender, recipient, plaintext, msgId);
		const { env: env2 } = await seal(sender, recipient, plaintext, msgId);

		// Different ephemeral pub and nonce → different ciphertext bytes
		expect(env1).not.toEqual(env2);
	});

	// SEC-CR-002: openMessage sender-sig verify must use {zip215:false} (strict).
	// Server uses dalek::verify_strict — rejects small-order / non-canonical pubkeys.
	// Client must align: a small-order Ed25519 pubkey as "expectedSender" must be rejected
	// even if zip215:true would accept it.
	it('SEC-CR-002: openMessage rejects small-order expectedSenderEd25519Pub (strict mode)', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('strict-test');

		const { env } = await seal(sender, recipient, plaintext);

		// Identity point (y=1, x=0): compressed little-endian = 0x01 followed by 31 zeros.
		// With zip215:true noble accepts this as a public key; with zip215:false it rejects it.
		const smallOrderPub = new Uint8Array(32);
		smallOrderPub[0] = 0x01;

		// Must throw — strict verify rejects small-order pubkey OR sig mismatch.
		// In either case, openMessage must NOT return a plaintext.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: recipient.x.secretKey,
				recipientX25519Pub: recipient.x.publicKey,
				expectedSenderEd25519Pub: smallOrderPub,
			}),
		).rejects.toThrow(/sender signature invalid/i);
	});

	// ---------------------------------------------------------------------------
	// #288 regression: authenticated binding transcript (v2).
	// Every envelope metadata field is folded into a SHA-256 bindingDigest that
	// is bound into BOTH AEAD AAD and Ed25519 signed bytes. Tampering ANY field
	// must cause openMessage to throw — the relay can no longer flip flags
	// (store_and_forward / system_msg) undetected.
	// ---------------------------------------------------------------------------

	describe('#288 authenticated binding transcript — tamper each field', () => {
		// Wire offsets (v2 = same layout as v1, version=0x02):
		//   0..3   magic
		//   4      version
		//   5      flags
		//   6..21  msgId (16)
		//   22..29 recipientAddr (8)
		//   30..93 senderSig (64)
		//   94..97 inner_len (u32 LE)
		//   98..   IC
		const VERSION_OFFSET = 4;
		const FLAGS_OFFSET = 5;
		const MSGID_OFFSET = 6;
		const RECIPIENT_ADDR_OFFSET = 22;

		it('#288 regression: flipping flags byte → openMessage throws (relay cannot flip store_and_forward)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('#288-regression');

			const { env } = await seal(sender, recipient, plaintext);
			// Flip the flags byte — this is exactly the #288 attack: relay flips
			// store_and_forward or system_msg without detection.
			env[FLAGS_OFFSET] ^= 0x01;

			await expect(open(env, recipient, sender)).rejects.toThrow(
				'crypto-primitives/pairwise: sender signature invalid',
			);
		});

		it('tamper version byte → openMessage throws (downgrade defense)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('version-tamper');

			const { env } = await seal(sender, recipient, plaintext);
			// Flip version 0x02 → 0x03. decodeMessageEnvelope rejects 0x03 as
			// unsupported version (only 0x02 accepted).
			env[VERSION_OFFSET] = 0x03;

			await expect(open(env, recipient, sender)).rejects.toThrow(
				'crypto-primitives/envelope: unsupported version',
			);
		});

		it('tamper version byte to 0x01 → openMessage throws (v1 hard break, ADR-8)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('v1-reject');

			const { env } = await seal(sender, recipient, plaintext);
			env[VERSION_OFFSET] = 0x01;

			await expect(open(env, recipient, sender)).rejects.toThrow(
				'crypto-primitives/envelope: unsupported version',
			);
		});

		it('tamper msgId → openMessage throws (bindingDigest mismatch)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('msgid-tamper');

			const { env } = await seal(sender, recipient, plaintext);
			env[MSGID_OFFSET] ^= 0xff;

			await expect(open(env, recipient, sender)).rejects.toThrow(
				'crypto-primitives/pairwise: sender signature invalid',
			);
		});

		it('tamper recipientAddr → openMessage throws (cross-check fails before sig)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('addr-tamper');

			const { env } = await seal(sender, recipient, plaintext);
			// Flip a recipientAddr byte — recipientAddr cross-check (ADR-11)
			// catches this BEFORE sig verification.
			env[RECIPIENT_ADDR_OFFSET] ^= 0xff;

			await expect(open(env, recipient, sender)).rejects.toThrow(
				'crypto-primitives/pairwise: recipient address mismatch',
			);
		});

		it('tamper senderEd25519PubKey (wrong expectedSender) → openMessage throws', async () => {
			const sender = makeSender();
			const wrongSender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('sender-key-tamper');

			const { env } = await seal(sender, recipient, plaintext);
			// Pass a wrong expectedSenderEd25519Pub — bindingDigest recomputed
			// with wrong key → sig verification fails.
			await expect(
				openMessage({
					envelopeBytes: env,
					recipientX25519Priv: recipient.x.secretKey,
					recipientX25519Pub: recipient.x.publicKey,
					expectedSenderEd25519Pub: wrongSender.e.publicKey,
				}),
			).rejects.toThrow('crypto-primitives/pairwise: sender signature invalid');
		});

		it('flags=0x03 round-trip preserved (store_and_forward | system_msg survives open)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('flag-roundtrip');
			const msgId = crypto.getRandomValues(new Uint8Array(16));

			const env = await sealMessage({
				plaintext,
				recipientX25519Pub: recipient.x.publicKey,
				senderEd25519PrivKey: sender.e.secretKey,
				senderEd25519PubKey: sender.e.publicKey,
				msgId,
				flags: 0x03, // store_and_forward | system_msg
			});

			const result = await open(env, recipient, sender);
			expect(result.flags).toBe(0x03);
			expect(result.plaintext).toEqual(plaintext);
		});

		// Stryker mutation-killing tests — target survived mutants in pairwise-seal.ts.

		it('empty-plaintext round-trip: IC = exactly 60 bytes (32+12+16) — kills <= boundary mutant', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			// Empty plaintext → ctAndTag = 16 bytes (GCM tag only), IC = 32+12+16 = 60.
			const plaintext = new Uint8Array(0);
			const msgId = crypto.getRandomValues(new Uint8Array(16));

			const env = await sealMessage({
				plaintext,
				recipientX25519Pub: recipient.x.publicKey,
				senderEd25519PrivKey: sender.e.secretKey,
				senderEd25519PubKey: sender.e.publicKey,
				msgId,
			});

			const result = await open(env, recipient, sender);
			expect(result.plaintext).toEqual(plaintext);
			expect(result.plaintext.byteLength).toBe(0);
		});

		it('too-short IC → throws "inner ciphertext too short" (kills false/arithmetic/BlockStatement mutants)', async () => {
			const sender = makeSender();
			const recipient = makeRecipient();
			const plaintext = new TextEncoder().encode('short-ic');

			const { env } = await seal(sender, recipient, plaintext);
			// Truncate the IC to 50 bytes (< 60 = 32+12+16 minimum).
			// Modify inner_len field (offset 94, u32 LE) to match the truncated IC.
			const view = new DataView(env.buffer, env.byteOffset, env.byteLength);
			const newIcLen = 50;
			view.setUint32(94, newIcLen, true);
			const truncated = env.subarray(0, 98 + newIcLen);

			await expect(open(truncated, recipient, sender)).rejects.toThrow(
				'crypto-primitives/pairwise: inner ciphertext too short',
			);
		});
	});
});

describe('pairwise-seal: replay protection (#283)', () => {
	/** In-memory ReplayWindow for testing — production uses IndexedDB-backed. */
	class InMemoryReplayWindow implements ReplayWindow {
		private seen = new Map<string, Uint8Array>();

		has(msgId: Uint8Array): boolean {
			for (const [, existing] of this.seen) {
				if (existing.byteLength === msgId.byteLength) {
					let diff = 0;
					for (let i = 0; i < existing.byteLength; i++) {
						diff |= existing[i] ^ msgId[i];
					}
					if (diff === 0) return true;
				}
			}
			return false;
		}

		add(msgId: Uint8Array): void {
			const copy = new Uint8Array(msgId);
			this.seen.set(Buffer.from(copy).toString('hex'), copy);
		}
	}

	it('first open succeeds, second open (replay) is rejected', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('replay me');
		const window = new InMemoryReplayWindow();

		const { env } = await seal(sender, recipient, plaintext);

		// First open — succeeds
		const result1 = await openMessage({
			envelopeBytes: env,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
			replayWindow: window,
		});
		expect(result1.plaintext).toEqual(plaintext);

		// Second open (same envelope) — rejected as replay
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: recipient.x.secretKey,
				recipientX25519Pub: recipient.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
				replayWindow: window,
			}),
		).rejects.toThrow(/replayed message/i);
	});

	it('without replayWindow: same envelope opens twice (backward compat)', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const plaintext = new TextEncoder().encode('no replay window');
		const { env } = await seal(sender, recipient, plaintext);

		const result1 = await open(env, recipient, sender);
		const result2 = await open(env, recipient, sender);
		expect(result1.plaintext).toEqual(plaintext);
		expect(result2.plaintext).toEqual(plaintext);
	});

	it('AEAD failure does NOT add msgId to replay window', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const wrongRecipient = makeRecipient();
		const plaintext = new TextEncoder().encode('wrong key test');
		const window = new InMemoryReplayWindow();

		const { env } = await seal(sender, recipient, plaintext);

		// Open with wrong recipient — v2: recipientAddr cross-check fails before
		// sig/AEAD, msgId must NOT be added to window.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: wrongRecipient.x.secretKey,
				recipientX25519Pub: wrongRecipient.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
				replayWindow: window,
			}),
		).rejects.toThrow();

		// Window must be empty — failure did not add msgId
		expect(window.has(new Uint8Array(16))).toBe(false);

		// Now open with correct recipient — must succeed (not blocked by poisoned window)
		const result = await openMessage({
			envelopeBytes: env,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
			replayWindow: window,
		});
		expect(result.plaintext).toEqual(plaintext);
	});

	it('different msgIds: both open successfully', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const window = new InMemoryReplayWindow();

		const msgId1 = crypto.getRandomValues(new Uint8Array(16));
		const msgId2 = crypto.getRandomValues(new Uint8Array(16));

		const { env: env1 } = await seal(sender, recipient, new TextEncoder().encode('msg1'), msgId1);
		const { env: env2 } = await seal(sender, recipient, new TextEncoder().encode('msg2'), msgId2);

		const r1 = await openMessage({
			envelopeBytes: env1,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
			replayWindow: window,
		});
		expect(new TextDecoder().decode(r1.plaintext)).toBe('msg1');

		const r2 = await openMessage({
			envelopeBytes: env2,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
			replayWindow: window,
		});
		expect(new TextDecoder().decode(r2.plaintext)).toBe('msg2');
	});
});
