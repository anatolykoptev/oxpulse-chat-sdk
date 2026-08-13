// Wire format: MessageEnvelope v2
//
// ME = magic[4]           "OXPE" (0x4F 0x58 0x50 0x45)
//    ‖ version[1]          0x02
//    ‖ flags[1]            bit0=store_and_forward, bit1=system_msg, bits2-7 reserved
//    ‖ msg_id[16]          UUIDv7 bytes
//    ‖ recipient_addr[8]   SHA-256(recipient_x25519_pub)[0..8]
//    ‖ sender_sig[64]      Ed25519 signature over bindingDigest ‖ sha256(IC)
//    ‖ inner_len[4]        u32 little-endian
//    ‖ IC[inner_len]       inner ciphertext (eph_pub ‖ nonce ‖ ct_and_tag)
//
// v2 wire layout is IDENTICAL to v1 except version=0x02 (zero wire overhead).
// The difference is cryptographic: in v2 every envelope metadata field
// (version, flags, msgId, recipientAddr, senderEd25519PubKey) is folded into
// a single SHA-256 binding transcript digest, and that digest is bound into
// BOTH the AEAD AAD and the Ed25519 signed bytes. This closes #288 (flags
// not authenticated — relay could flip store_and_forward / system_msg
// undetected). v1 decoders are rejected (hard break, ADR-8).
//
// Fixed header = 4+1+1+16+8+64+4 = 98 bytes.

export const MESSAGE_ENVELOPE_MAGIC = new Uint8Array([0x4f, 0x58, 0x50, 0x45]); // "OXPE"
export const MESSAGE_ENVELOPE_VERSION = 0x02;
export const HEADER_BYTES = 4 + 1 + 1 + 16 + 8 + 64 + 4; // 98

/**
 * Decoded representation of a MessageEnvelope v2.
 *
 * @remarks
 * `innerCiphertext` is a **subarray view** into the caller's input buffer.
 * Callers must not mutate the source buffer until they are done with `innerCiphertext`.
 *
 * All fixed-size fields (`msgId`, `recipientAddr`, `senderSig`) are **owned copies**
 * and are safe to use after the source buffer is modified or freed.
 */
export interface MessageEnvelopeV2 {
	flags: number; // u8 bitfield
	msgId: Uint8Array; // 16 bytes (UUIDv7) — owned copy
	recipientAddr: Uint8Array; // 8 bytes — owned copy
	senderSig: Uint8Array; // 64 bytes (Ed25519) — owned copy
	innerCiphertext: Uint8Array; // subarray view — see @remarks
}

export function encodeMessageEnvelope(env: MessageEnvelopeV2): Uint8Array {
	if (env.msgId.byteLength !== 16)
		throw new Error('crypto-primitives/envelope: msgId must be 16 bytes');
	if (env.recipientAddr.byteLength !== 8)
		throw new Error('crypto-primitives/envelope: recipientAddr must be 8 bytes');
	if (env.senderSig.byteLength !== 64)
		throw new Error('crypto-primitives/envelope: senderSig must be 64 bytes');

	const total = HEADER_BYTES + env.innerCiphertext.byteLength;
	const buf = new Uint8Array(total);
	let offset = 0;

	// magic
	buf.set(MESSAGE_ENVELOPE_MAGIC, offset);
	offset += 4;
	// version
	buf[offset++] = MESSAGE_ENVELOPE_VERSION;
	// flags
	buf[offset++] = env.flags & 0xff;
	// msg_id
	buf.set(env.msgId, offset);
	offset += 16;
	// recipient_addr
	buf.set(env.recipientAddr, offset);
	offset += 8;
	// sender_sig
	buf.set(env.senderSig, offset);
	offset += 64;
	// inner_len (u32 LE)
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	view.setUint32(offset, env.innerCiphertext.byteLength, true);
	offset += 4;
	// IC
	buf.set(env.innerCiphertext, offset);

	return buf;
}

export function decodeMessageEnvelope(bytes: Uint8Array): MessageEnvelopeV2 {
	if (bytes.byteLength < HEADER_BYTES) {
		throw new Error(
			`crypto-primitives/envelope: buffer too short (${bytes.byteLength} < ${HEADER_BYTES})`,
		);
	}

	// Verify magic
	if (
		bytes[0] !== MESSAGE_ENVELOPE_MAGIC[0] ||
		bytes[1] !== MESSAGE_ENVELOPE_MAGIC[1] ||
		bytes[2] !== MESSAGE_ENVELOPE_MAGIC[2] ||
		bytes[3] !== MESSAGE_ENVELOPE_MAGIC[3]
	) {
		throw new Error('crypto-primitives/envelope: bad magic bytes');
	}

	// Verify version — v2 rejects v1 (hard break, ADR-8)
	if (bytes[4] !== MESSAGE_ENVELOPE_VERSION) {
		throw new Error('crypto-primitives/envelope: unsupported version');
	}

	let offset = 5;
	const flags = bytes[offset++]!;

	const msgId = bytes.slice(offset, offset + 16);
	offset += 16;

	const recipientAddr = bytes.slice(offset, offset + 8);
	offset += 8;

	const senderSig = bytes.slice(offset, offset + 64);
	offset += 64;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const innerLen = view.getUint32(offset, true);
	offset += 4;

	// Strict length check — no trailing bytes
	if (bytes.byteLength !== HEADER_BYTES + innerLen) {
		throw new Error(
			`crypto-primitives/envelope: length mismatch (declared ${innerLen}, actual ${bytes.byteLength - HEADER_BYTES})`,
		);
	}

	const innerCiphertext = bytes.subarray(offset, offset + innerLen);

	return { flags, msgId, recipientAddr, senderSig, innerCiphertext };
}
