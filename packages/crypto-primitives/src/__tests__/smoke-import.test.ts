import { describe, it, expect } from 'vitest';
import {
	sealMessage,
	openMessage,
	decodeMessageEnvelope,
	MESSAGE_ENVELOPE_MAGIC,
	MESSAGE_ENVELOPE_VERSION,
	HEADER_BYTES,
	derivePeerIdTarget,
} from '../index.ts';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';

describe('crypto-primitives public API smoke', () => {
	it('barrel exposes full seal/open round-trip', async () => {
		const sender = { x: x25519.keygen(), e: ed25519.keygen() };
		const recipient = { x: x25519.keygen() };
		const msgId = crypto.getRandomValues(new Uint8Array(16));
		const plaintext = new TextEncoder().encode('hello phase-1');

		const env = await sealMessage({
			plaintext,
			recipientX25519Pub: recipient.x.publicKey,
			senderEd25519PrivKey: sender.e.secretKey,
			senderEd25519PubKey: sender.e.publicKey,
			msgId,
		});

		// Verify outer structure via barrel-exported codec + constants
		const peeked = decodeMessageEnvelope(env);
		expect(peeked.recipientAddr).toEqual(derivePeerIdTarget(recipient.x.publicKey));
		expect(env[0]).toBe(MESSAGE_ENVELOPE_MAGIC[0]);
		expect(env[4]).toBe(MESSAGE_ENVELOPE_VERSION);
		expect(env.length).toBeGreaterThan(HEADER_BYTES);

		// Verify full open round-trip via barrel
		const opened = await openMessage({
			envelopeBytes: env,
			recipientX25519Priv: recipient.x.secretKey,
			recipientX25519Pub: recipient.x.publicKey,
			expectedSenderEd25519Pub: sender.e.publicKey,
		});
		expect(opened.plaintext).toEqual(plaintext);
		expect(opened.msgId).toEqual(msgId);
	});

	it('HEADER_BYTES is exactly 98', () => {
		expect(HEADER_BYTES).toBe(98);
	});

	it('MESSAGE_ENVELOPE_MAGIC spells OXPE', () => {
		const magic = new TextDecoder().decode(MESSAGE_ENVELOPE_MAGIC);
		expect(magic).toBe('OXPE');
	});

	it('MESSAGE_ENVELOPE_VERSION is 0x02', () => {
		expect(MESSAGE_ENVELOPE_VERSION).toBe(0x02);
	});
});
