import { describe, it, expect } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sealMessage, openMessage, type ReplayWindow } from '../pairwise-seal.ts';
import { decodeMessageEnvelope } from '../envelope.ts';

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

	it('wrong recipient key → AEAD authentication failed', async () => {
		const sender = makeSender();
		const recipient = makeRecipient();
		const wrongRecipient = makeRecipient();
		const plaintext = new TextEncoder().encode('secret');

		const { env } = await seal(sender, recipient, plaintext);

		// Sig binds recipient_pub → wrong recipient pub fails sig BEFORE AEAD.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: wrongRecipient.x.secretKey,
				recipientX25519Pub: wrongRecipient.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
			}),
		).rejects.toThrow('crypto-primitives/pairwise: sender signature invalid');
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

	it('cross-pair replay: seal A→B, attempt open as A→C → AEAD fails', async () => {
		const sender = makeSender();
		const recipientB = makeRecipient();
		const recipientC = makeRecipient();
		const plaintext = new TextEncoder().encode('cross-pair');

		const { env } = await seal(sender, recipientB, plaintext);

		// C tries to open with their own priv key. Sig check: sig covers recipient_B_pub,
		// so providing C's pub for sig verification must fail.
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: recipientC.x.secretKey,
				recipientX25519Pub: recipientC.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
			}),
		).rejects.toThrow('crypto-primitives/pairwise: sender signature invalid');
	});

	it('recipient-swap defeat (decision #11): flip recipient_addr bytes → sig covers real pub', async () => {
		const sender = makeSender();
		const recipientB = makeRecipient();
		const recipientC = makeRecipient();
		const plaintext = new TextEncoder().encode('recipient-swap');

		const { env } = await seal(sender, recipientB, plaintext);

		// Adversary flips recipient_addr in envelope to match C's address, then provides C's priv.
		// Sig was computed over recipient_B_pub — verifying with C's pub must fail.
		const decoded = decodeMessageEnvelope(env);
		// Compute C's addr and patch it in (recipientAddr is at offset 30-38... actually:
		// 4+1+1+16 = 22 offset for recipientAddr)
		const addrOffset = 22;
		// Import derivePeerIdTarget to compute C's addr
		const { derivePeerIdTarget } = await import('../peer-id.ts');
		const cAddr = derivePeerIdTarget(recipientC.x.publicKey);
		env.set(cAddr, addrOffset);

		// Despite addr matching C, sig verification covers recipient_B_pub → must fail
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

		// Open with wrong recipient — AEAD will fail, msgId must NOT be added to window
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: wrongRecipient.x.secretKey,
				recipientX25519Pub: wrongRecipient.x.publicKey,
				expectedSenderEd25519Pub: sender.e.publicKey,
				replayWindow: window,
			}),
		).rejects.toThrow();

		// Window must be empty — AEAD failure did not add msgId
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
