import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateEphemeralKeypair, deriveSharedSecret } from './x25519.ts';
import { deriveKey } from './hkdf.ts';
import { aesGcmSeal, aesGcmOpen } from './aead.ts';
import { encodeMessageEnvelope, decodeMessageEnvelope, type MessageEnvelopeV2 } from './envelope.ts';
import { derivePeerIdTarget } from './peer-id.ts';
import { zeroize } from './zeroize.ts';
import { timingSafeEqual } from './timing-safe.ts';

const AAD_PREFIX = new TextEncoder().encode('oxp/pw/v1'); // 9 bytes
const HKDF_INFO = new TextEncoder().encode('oxp/pairwise/v1'); // 15 bytes

// Binding transcript field sizes (all fixed — ADR-2: no length prefixes).
const BINDING_VERSION_LEN = 1;
const BINDING_FLAGS_LEN = 1;
const BINDING_MSGID_LEN = 16;
const BINDING_RECIPIENT_ADDR_LEN = 8;
const BINDING_SENDER_PUB_LEN = 32;
const BINDING_TRANSCRIPT_LEN =
	AAD_PREFIX.length +
	BINDING_VERSION_LEN +
	BINDING_FLAGS_LEN +
	BINDING_MSGID_LEN +
	BINDING_RECIPIENT_ADDR_LEN +
	BINDING_SENDER_PUB_LEN; // 9 + 1 + 1 + 16 + 8 + 32 = 67 bytes

/**
 * Computes the SHA-256 binding transcript digest — the single anchor that
 * authenticates ALL envelope metadata. Bound into BOTH the AEAD AAD and the
 * Ed25519 signed bytes (ADR-1, ADR-6).
 *
 * Transcript (fixed-offset concatenation, ADR-2):
 *   digest = SHA-256( AAD_PREFIX[9] ‖ version[1] ‖ flags[1]
 *                      ‖ msgId[16] ‖ recipientAddr[8] ‖ senderEd25519PubKey[32] )
 *          = SHA-256 over 67 bytes
 *
 * AAD_PREFIX is included directly (ADR-3) — it is the actual constant used
 * in AEAD operations, so binding it is strictly stronger than a synthetic
 * domain tag. ephPub and nonce are intentionally omitted (ADR-10): both are
 * inside IC, sha256(IC) is in signedBytes, so they are authenticated by the
 * Ed25519 signature — an attacker cannot strip them without breaking the IC
 * hash.
 *
 * Internal — not exported from the barrel (ADR-12). Named function (not
 * inlined) for Stryker testability + conceptual continuity with the v1
 * transcript pattern (`buildSignedBytes`).
 */
function computeBindingDigest(
	version: number,
	flags: number,
	msgId: Uint8Array,
	recipientAddr: Uint8Array,
	senderEd25519PubKey: Uint8Array,
): Uint8Array {
	const transcript = new Uint8Array(BINDING_TRANSCRIPT_LEN);
	let offset = 0;
	transcript.set(AAD_PREFIX, offset);
	offset += AAD_PREFIX.length;
	transcript[offset++] = version;
	transcript[offset++] = flags;
	transcript.set(msgId, offset);
	offset += BINDING_MSGID_LEN;
	transcript.set(recipientAddr, offset);
	offset += BINDING_RECIPIENT_ADDR_LEN;
	transcript.set(senderEd25519PubKey, offset);
	return sha256(transcript);
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
		// 3. recipientAddr = SHA-256(recipient_x25519_pub)[0..8]
		const recipientAddr = derivePeerIdTarget(args.recipientX25519Pub);

		// 4. Binding transcript digest — authenticates ALL envelope metadata (ADR-6).
		//    version=0x02 is the v2 wire version; binding it prevents a v1/v2
		//    downgrade where an attacker rewrites the version byte.
		const bindingDigest = computeBindingDigest(
			0x02,
			args.flags ?? 0,
			args.msgId,
			recipientAddr,
			args.senderEd25519PubKey,
		);

		// 5. AAD = AAD_PREFIX[9] ‖ senderEd25519PubKey[32] ‖ bindingDigest[32] = 73 bytes
		//    (msgId REMOVED from AAD — now inside bindingDigest)
		const aad = new Uint8Array(AAD_PREFIX.length + 32 + bindingDigest.length);
		aad.set(AAD_PREFIX, 0);
		aad.set(args.senderEd25519PubKey, AAD_PREFIX.length);
		aad.set(bindingDigest, AAD_PREFIX.length + 32);

		// 6. AEAD seal
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const ctAndTag = await aesGcmSeal(kdfKey, nonce, aad, args.plaintext);

		// 7. Assemble IC = eph_pub[32] ‖ nonce[12] ‖ ct_and_tag[…]
		const ic = new Uint8Array(32 + 12 + ctAndTag.length);
		ic.set(ephPub, 0);
		ic.set(nonce, 32);
		ic.set(ctAndTag, 44);

		// 8. Sender signature — covers bindingDigest ‖ sha256(IC) (ADR-6).
		//    sha256(IC) authenticates ephPub + nonce + ct_and_tag; bindingDigest
		//    authenticates all envelope metadata. Together: AEAD success + Ed25519
		//    success proves every transcript field is authentic.
		const icHash = sha256(ic);
		const signedBytes = new Uint8Array(bindingDigest.length + icHash.length);
		signedBytes.set(bindingDigest, 0);
		signedBytes.set(icHash, bindingDigest.length);
		const senderSig = ed25519.sign(signedBytes, args.senderEd25519PrivKey);

		// 9. Assemble envelope
		const env: MessageEnvelopeV2 = {
			flags: args.flags ?? 0,
			msgId: args.msgId,
			recipientAddr,
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
	recipientX25519Pub: Uint8Array; // 32 bytes — for HKDF salt + recipientAddr cross-check
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
	// 1. Decode envelope (rejects v1 — hard break, ADR-8)
	const env = decodeMessageEnvelope(args.envelopeBytes);

	// 2. recipientAddr cross-check (ADR-11) — fail-fast BEFORE sig verification.
	//    Ensures the message was sealed for THIS recipient. Replaces v1's direct
	//    recipientX25519Pub in signedBytes (now inside bindingDigest). Uses
	//    timingSafeEqual (XOR-reduce-OR); early return on length mismatch is safe
	//    (length is non-secret).
	//    TIMING: placement before sig verify creates a timing oracle (attacker
	//    can distinguish recipientAddr match vs mismatch by response time).
	//    This is accepted: recipientAddr is NOT secret (it's on the wire), and
	//    fail-fast avoids wasting an expensive sig verify on messages not for
	//    this recipient. Same low-severity trade-off as ReplayWindow.has() below.
	const expectedRecipientAddr = derivePeerIdTarget(args.recipientX25519Pub);
	if (!timingSafeEqual(expectedRecipientAddr, env.recipientAddr)) {
		throw new Error('crypto-primitives/pairwise: recipient address mismatch');
	}

	// 3. Parse IC fields
	if (env.innerCiphertext.byteLength < 32 + 12 + 16) {
		throw new Error('crypto-primitives/pairwise: inner ciphertext too short');
	}
	const ephPub = env.innerCiphertext.subarray(0, 32);
	const nonce = env.innerCiphertext.subarray(32, 44);
	const ctAndTag = env.innerCiphertext.subarray(44);

	// 4. Recompute binding digest from wire claims + caller-provided sender key.
	//    If the caller passed the wrong key, or any wire field was tampered,
	//    bindingDigest mismatch → sig verification fails. This IS the trust
	//    check (ADR-5): caller authenticates crypto first (sig+AEAD), then
	//    applies trust policy (contact-cache lookup) post-open.
	const bindingDigest = computeBindingDigest(
		0x02,
		env.flags,
		env.msgId,
		env.recipientAddr,
		args.expectedSenderEd25519Pub,
	);

	// 5. Verify sender signature — covers bindingDigest ‖ sha256(IC) (ADR-6).
	//    zip215:false aligns with server dalek::verify_strict (RFC 8032 strict).
	const icHash = sha256(env.innerCiphertext);
	const signedBytes = new Uint8Array(bindingDigest.length + icHash.length);
	signedBytes.set(bindingDigest, 0);
	signedBytes.set(icHash, bindingDigest.length);
	if (
		!ed25519.verify(env.senderSig, signedBytes, args.expectedSenderEd25519Pub, {
			zip215: false,
		})
	) {
		throw new Error('crypto-primitives/pairwise: sender signature invalid');
	}

	// 6. Replay check — AFTER sig verify, BEFORE AEAD.
	//    Checked after sig to avoid timing oracle on replay state (an attacker
	//    could distinguish "replayed" from "not replayed" by response time if
	//    the check preceded the expensive sig verify).
	if (args.replayWindow && args.replayWindow.has(env.msgId)) {
		throw new Error('crypto-primitives/pairwise: replayed message (msgId already seen)');
	}

	// 7. DH + HKDF
	const ss = deriveSharedSecret(args.recipientX25519Priv, ephPub);
	const salt = new Uint8Array(64);
	salt.set(args.recipientX25519Pub, 0);
	salt.set(ephPub, 32);
	const kdfKey = deriveKey(ss, salt, HKDF_INFO, 32);

	try {
		// 8. AAD = AAD_PREFIX[9] ‖ senderEd25519PubKey[32] ‖ bindingDigest[32]
		const aad = new Uint8Array(AAD_PREFIX.length + 32 + bindingDigest.length);
		aad.set(AAD_PREFIX, 0);
		aad.set(args.expectedSenderEd25519Pub, AAD_PREFIX.length);
		aad.set(bindingDigest, AAD_PREFIX.length + 32);

		// 9. AEAD open
		let plaintext: Uint8Array;
		try {
			plaintext = await aesGcmOpen(kdfKey, nonce, aad, ctAndTag);
		} catch {
			throw new Error('crypto-primitives/pairwise: AEAD authentication failed');
		}

		// 10. Record msgId in replay window — ONLY after successful AEAD open
		//     (e2ee-invariants §5: advance window only after successful unseal).
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
