import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateEphemeralKeypair, deriveSharedSecret } from './x25519.ts';
import { deriveKey } from './hkdf.ts';
import { aesGcmSeal, aesGcmOpen } from './aead.ts';
import { encodeMessageEnvelope, decodeMessageEnvelope, type MessageEnvelopeV1 } from './envelope.ts';
import { derivePeerIdTarget } from './peer-id.ts';
import { zeroize } from './zeroize.ts';
import { timingSafeEqual } from './timing-safe.ts';

const AAD_PREFIX = new TextEncoder().encode('oxp/pw/v1'); // 9 bytes
const HKDF_INFO = new TextEncoder().encode('oxp/pairwise/v1'); // 15 bytes

/**
 * Builds the bytes signed by the sender: SHA-256(IC) ‖ msg_id(16) ‖ recipient_x25519_pub(32).
 * Single source of truth for the sig-bytes layout (decision #11).
 * Internal — not exported from the barrel.
 */
function buildSignedBytes(ic: Uint8Array, msgId: Uint8Array, recipientPub: Uint8Array): Uint8Array {
	const icHash = sha256(ic);
	const signedBytes = new Uint8Array(icHash.length + 16 + 32);
	signedBytes.set(icHash, 0);
	signedBytes.set(msgId, icHash.length);
	signedBytes.set(recipientPub, icHash.length + 16);
	return signedBytes;
}

export interface SealMessageArgs {
	plaintext: Uint8Array;
	recipientX25519Pub: Uint8Array; // 32 bytes
	senderEd25519PrivKey: Uint8Array; // 32-byte seed accepted by noble
	senderEd25519PubKey: Uint8Array; // 32 bytes
	msgId: Uint8Array; // 16 bytes (UUIDv7)
	flags?: number; // default 0
}

export async function sealMessage(args: SealMessageArgs): Promise<Uint8Array> {
	// 1. Ephemeral DH
	const { privateKey: ephPriv, publicKey: ephPub } = generateEphemeralKeypair();
	const ss = deriveSharedSecret(ephPriv, args.recipientX25519Pub);

	// 2. HKDF key — salt = recipient_pub ‖ eph_pub (64 bytes)
	const salt = new Uint8Array(64);
	salt.set(args.recipientX25519Pub, 0);
	salt.set(ephPub, 32);
	const kdfKey = deriveKey(ss, salt, HKDF_INFO, 32);

	try {
		// 3. AAD = "oxp/pw/v1" ‖ sender_ed25519_pub(32) ‖ msg_id(16) = 57 bytes
		const aad = new Uint8Array(AAD_PREFIX.length + 32 + 16);
		aad.set(AAD_PREFIX, 0);
		aad.set(args.senderEd25519PubKey, AAD_PREFIX.length);
		aad.set(args.msgId, AAD_PREFIX.length + 32);

		// 4. AEAD seal
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const ctAndTag = await aesGcmSeal(kdfKey, nonce, aad, args.plaintext);

		// 5. Assemble IC = eph_pub[32] ‖ nonce[12] ‖ ct_and_tag[…]
		const ic = new Uint8Array(32 + 12 + ctAndTag.length);
		ic.set(ephPub, 0);
		ic.set(nonce, 32);
		ic.set(ctAndTag, 44);

		// 6. Sender signature — covers SHA-256(IC) ‖ msg_id ‖ recipient_x25519_pub (decision #11)
		const signedBytes = buildSignedBytes(ic, args.msgId, args.recipientX25519Pub);
		const senderSig = ed25519.sign(signedBytes, args.senderEd25519PrivKey);

		// 7. Assemble envelope
		const env: MessageEnvelopeV1 = {
			flags: args.flags ?? 0,
			msgId: args.msgId,
			recipientAddr: derivePeerIdTarget(args.recipientX25519Pub),
			senderSig,
			innerCiphertext: ic,
		};
		return encodeMessageEnvelope(env);
	} finally {
		// Zeroize ephemeral secrets on ALL paths (success + failure) (#282).
		zeroize(ephPriv);
		zeroize(ss);
		zeroize(kdfKey);
	}
}

/**
 * Replay window interface — caller provides the storage backing.
 *
 * Per e2ee-invariants §5: replay defense must be DURABLE (survive reload).
 * `crypto-primitives` does not implement storage — the caller (`chat-sdk`)
 * provides a concrete implementation (in-memory Set for tests, IndexedDB
 * for production). The interface is minimal so any backend can adapt.
 *
 * INVARIANT: `add` is called ONLY after a successful unseal — never on
 * AEAD failure or sig failure. This prevents an attacker from poisoning
 * the window with invalid msgIds that would block legitimate future messages.
 *
 * TIMING: `has()` is called after signature verification but before AEAD
 * decryption. A timing-varying `has()` leaks which msgIds have been seen
 * (replay state). Callers SHOULD implement `has()` in constant time (e.g.,
 * XOR-reduce comparison). JS provides no CT guarantees — this is best-effort.
 * The timing leak is low-severity (reveals replay state, not key material).
 */
export interface ReplayWindow {
	/** Returns true if msgId has been seen before. SHOULD be constant-time. */
	has(msgId: Uint8Array): boolean;
	/** Record msgId as seen. Called ONLY after successful AEAD open. */
	add(msgId: Uint8Array): void;
}

export interface OpenMessageArgs {
	envelopeBytes: Uint8Array;
	recipientX25519Priv: Uint8Array; // 32 bytes
	recipientX25519Pub: Uint8Array; // 32 bytes — for HKDF salt + sig verify
	expectedSenderEd25519Pub: Uint8Array; // caller looks up from contact cache
	/** Optional replay window — if provided, replayed msgIds are rejected. */
	replayWindow?: ReplayWindow;
}

export interface OpenMessageResult {
	plaintext: Uint8Array;
	msgId: Uint8Array;
	flags: number;
}

export async function openMessage(args: OpenMessageArgs): Promise<OpenMessageResult> {
	// 1. Decode envelope
	const env = decodeMessageEnvelope(args.envelopeBytes);

	// 2. Parse IC fields
	if (env.innerCiphertext.byteLength < 32 + 12 + 16) {
		throw new Error('crypto-primitives/pairwise: inner ciphertext too short');
	}
	const ephPub = env.innerCiphertext.subarray(0, 32);
	const nonce = env.innerCiphertext.subarray(32, 44);
	const ctAndTag = env.innerCiphertext.subarray(44);

	// 3. Verify sender signature BEFORE AEAD (fail-fast, decision #11).
	//    Sig covers: SHA-256(IC) ‖ msg_id ‖ recipient_x25519_pub
	//    zip215:false aligns with server dalek::verify_strict (RFC 8032 strict).
	if (
		!ed25519.verify(
			env.senderSig,
			buildSignedBytes(env.innerCiphertext, env.msgId, args.recipientX25519Pub),
			args.expectedSenderEd25519Pub,
			{ zip215: false },
		)
	) {
		throw new Error('crypto-primitives/pairwise: sender signature invalid');
	}

	// 4. Replay check — AFTER sig verify, BEFORE AEAD.
	//    Checked after sig to avoid timing oracle on replay state (an attacker
	//    could distinguish "replayed" from "not replayed" by response time if
	//    the check preceded the expensive sig verify).
	if (args.replayWindow && args.replayWindow.has(env.msgId)) {
		throw new Error('crypto-primitives/pairwise: replayed message (msgId already seen)');
	}

	// 5. DH + HKDF
	const ss = deriveSharedSecret(args.recipientX25519Priv, ephPub);
	const salt = new Uint8Array(64);
	salt.set(args.recipientX25519Pub, 0);
	salt.set(ephPub, 32);
	const kdfKey = deriveKey(ss, salt, HKDF_INFO, 32);

	try {
		// 6. AAD = "oxp/pw/v1" ‖ sender_ed25519_pub(32) ‖ msg_id(16)
		const aad = new Uint8Array(AAD_PREFIX.length + 32 + 16);
		aad.set(AAD_PREFIX, 0);
		aad.set(args.expectedSenderEd25519Pub, AAD_PREFIX.length);
		aad.set(env.msgId, AAD_PREFIX.length + 32);

		// 7. AEAD open
		let plaintext: Uint8Array;
		try {
			plaintext = await aesGcmOpen(kdfKey, nonce, aad, ctAndTag);
		} catch {
			throw new Error('crypto-primitives/pairwise: AEAD authentication failed');
		}

		// 8. Record msgId in replay window — ONLY after successful AEAD open
		//    (e2ee-invariants §5: advance window only after successful unseal).
		if (args.replayWindow) {
			args.replayWindow.add(env.msgId);
		}

		return { plaintext, msgId: env.msgId, flags: env.flags };
	} finally {
		// Zeroize shared secret + KDF key on ALL paths (#282).
		zeroize(ss);
		zeroize(kdfKey);
	}
}
