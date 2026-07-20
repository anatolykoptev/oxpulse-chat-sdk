// X25519 primitives
export { generateEphemeralKeypair, deriveSharedSecret } from './x25519.ts';

// HKDF
export { deriveKey } from './hkdf.ts';

// AEAD
export { aesGcmSeal, aesGcmOpen } from './aead.ts';

// Addressing
export { derivePeerIdTarget } from './peer-id.ts';

// Envelope codec
export {
	encodeMessageEnvelope,
	decodeMessageEnvelope,
	MESSAGE_ENVELOPE_MAGIC,
	MESSAGE_ENVELOPE_VERSION,
	HEADER_BYTES,
	type MessageEnvelopeV1,
} from './envelope.ts';

// Pairwise seal (headline API for Phase 2 consumers)
export {
	sealMessage,
	openMessage,
	type SealMessageArgs,
	type OpenMessageArgs,
	type OpenMessageResult,
} from './pairwise-seal.ts';

// Timing-safe comparison (ADR-008: public exports)
export { timingSafeEqual, timingSafePubkeyEqualB64u } from './timing-safe.ts';
