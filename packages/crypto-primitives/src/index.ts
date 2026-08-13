// X25519 primitives
export { generateEphemeralKeypair, deriveSharedSecret } from './x25519.ts';

// PQXDH hybrid key agreement (X25519 + ML-KEM-768) — post-quantum forward secrecy
export {
	mlKemKeygen,
	hybridKemKeygen,
	hybridKemEncaps,
	hybridKemDecaps,
	type MlKemKeyPair,
	type HybridKemKeyPair,
	type HybridKemEncapsulation,
} from './kem.ts';

// HKDF
export { deriveKey, hkdfExtract, hkdfExpand } from './hkdf.ts';

// AEAD
export { aesGcmSeal, aesGcmOpen } from './aead.ts';

// XChaCha20-Poly1305 AEAD with key commitment (192-bit nonce, random-safe)
export { xchachaSeal, xchachaOpen, xchachaRandomNonce } from './xchacha.ts';

// Addressing
export { derivePeerIdTarget } from './peer-id.ts';

// Envelope codec
export {
	encodeMessageEnvelope,
	decodeMessageEnvelope,
	MESSAGE_ENVELOPE_MAGIC,
	MESSAGE_ENVELOPE_VERSION,
	HEADER_BYTES,
	type MessageEnvelopeV2,
} from './envelope.ts';

// Pairwise seal (headline API for Phase 2 consumers)
export {
	sealMessage,
	openMessage,
	type SealMessageArgs,
	type OpenMessageArgs,
	type OpenMessageResult,
	type ReplayWindow,
} from './pairwise-seal.ts';

// Timing-safe comparison (ADR-008: public exports)
export { timingSafeEqual, timingSafePubkeyEqualB64u } from './timing-safe.ts';

// base64url encode/decode (ADR-013 / #218 nit #11: single canonical home)
export { b64uEncodeBytes, b64uDecodeBytes } from './base64url.ts';
