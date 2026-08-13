import { describe, it, expect } from 'vitest';
import {
	encodeMessageEnvelope,
	decodeMessageEnvelope,
	HEADER_BYTES,
	MESSAGE_ENVELOPE_MAGIC,
	MESSAGE_ENVELOPE_VERSION,
	type MessageEnvelopeV2,
} from '../envelope.ts';

function makeEnv(icLen: number = 64): MessageEnvelopeV2 {
	return {
		flags: 0,
		msgId: crypto.getRandomValues(new Uint8Array(16)),
		recipientAddr: crypto.getRandomValues(new Uint8Array(8)),
		senderSig: crypto.getRandomValues(new Uint8Array(64)),
		innerCiphertext: crypto.getRandomValues(new Uint8Array(icLen)),
	};
}

describe('envelope', () => {
	it('HEADER_BYTES is 98', () => {
		expect(HEADER_BYTES).toBe(98);
	});

	it('round-trip: encode → decode produces same field values', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		const decoded = decodeMessageEnvelope(bytes);

		expect(decoded.flags).toBe(env.flags);
		expect(decoded.msgId).toEqual(env.msgId);
		expect(decoded.recipientAddr).toEqual(env.recipientAddr);
		expect(decoded.senderSig).toEqual(env.senderSig);
		expect(decoded.innerCiphertext).toEqual(env.innerCiphertext);
	});

	it('total length is HEADER_BYTES + inner_len', () => {
		const env = makeEnv(100);
		const bytes = encodeMessageEnvelope(env);
		expect(bytes.byteLength).toBe(HEADER_BYTES + 100);
	});

	it('magic bytes are "OXPE" at offset 0', () => {
		const bytes = encodeMessageEnvelope(makeEnv());
		expect(bytes[0]).toBe(MESSAGE_ENVELOPE_MAGIC[0]); // 0x4F
		expect(bytes[1]).toBe(MESSAGE_ENVELOPE_MAGIC[1]); // 0x58
		expect(bytes[2]).toBe(MESSAGE_ENVELOPE_MAGIC[2]); // 0x50
		expect(bytes[3]).toBe(MESSAGE_ENVELOPE_MAGIC[3]); // 0x45
	});

	it('version byte is 0x02 at offset 4', () => {
		const bytes = encodeMessageEnvelope(makeEnv());
		expect(bytes[4]).toBe(MESSAGE_ENVELOPE_VERSION);
	});

	it('inner_len is little-endian u32 at offset 94', () => {
		const ic = new Uint8Array(300);
		const bytes = encodeMessageEnvelope({ ...makeEnv(), innerCiphertext: ic });
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(view.getUint32(94, true)).toBe(300);
	});

	it('rejects wrong magic', () => {
		const bytes = encodeMessageEnvelope(makeEnv());
		bytes[0] = 0x41; // 'A' instead of 'O'
		expect(() => decodeMessageEnvelope(bytes)).toThrow();
	});

	it('rejects version 0x00', () => {
		const bytes = encodeMessageEnvelope(makeEnv());
		bytes[4] = 0x00;
		expect(() => decodeMessageEnvelope(bytes)).toThrow(
			'crypto-primitives/envelope: unsupported version',
		);
	});

	it('rejects version 0x01 (v1 hard break, ADR-8)', () => {
		const bytes = encodeMessageEnvelope(makeEnv());
		bytes[4] = 0x01;
		expect(() => decodeMessageEnvelope(bytes)).toThrow(
			'crypto-primitives/envelope: unsupported version',
		);
	});

	it('rejects buffer shorter than 98 bytes', () => {
		expect(() => decodeMessageEnvelope(new Uint8Array(50))).toThrow();
	});

	it('rejects inner_len mismatch (too short actual bytes)', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		// Truncate to lose 10 bytes of IC
		const truncated = bytes.subarray(0, bytes.byteLength - 10);
		expect(() => decodeMessageEnvelope(truncated)).toThrow();
	});

	it('rejects trailing bytes after declared inner_len', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		// Append 5 extra bytes
		const padded = new Uint8Array(bytes.byteLength + 5);
		padded.set(bytes);
		expect(() => decodeMessageEnvelope(padded)).toThrow();
	});

	it('boundary: inner_len = 0 is a valid codec output', () => {
		const env = makeEnv(0);
		const bytes = encodeMessageEnvelope(env);
		expect(bytes.byteLength).toBe(HEADER_BYTES);
		const decoded = decodeMessageEnvelope(bytes);
		expect(decoded.innerCiphertext.byteLength).toBe(0);
	});

	it('HIGH 1 — fixed-size fields are owned copies: mutating source buffer does not corrupt returned msgId', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		const decoded = decodeMessageEnvelope(bytes);
		const msgIdBefore = decoded.msgId.slice();
		// Mutate the entire source buffer
		bytes.fill(0xff);
		// msgId must still equal the original value (not all-0xff)
		expect(decoded.msgId).toEqual(msgIdBefore);
	});

	it('HIGH 1 — fixed-size fields are owned copies: mutating source buffer does not corrupt recipientAddr', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		const decoded = decodeMessageEnvelope(bytes);
		const addrBefore = decoded.recipientAddr.slice();
		bytes.fill(0xff);
		expect(decoded.recipientAddr).toEqual(addrBefore);
	});

	it('HIGH 1 — fixed-size fields are owned copies: mutating source buffer does not corrupt senderSig', () => {
		const env = makeEnv(64);
		const bytes = encodeMessageEnvelope(env);
		const decoded = decodeMessageEnvelope(bytes);
		const sigBefore = decoded.senderSig.slice();
		bytes.fill(0xff);
		expect(decoded.senderSig).toEqual(sigBefore);
	});
});
