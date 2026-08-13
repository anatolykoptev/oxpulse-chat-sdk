/**
 * PQXDH hybrid key agreement: X25519 + ML-KEM-768.
 *
 * Implements the hybrid key encapsulation following Signal's PQXDH design
 * (https://signal.org/docs/specifications/pqxdh/):
 *
 *   1. X25519 ephemeral DH → classical shared secret (32 bytes)
 *   2. ML-KEM-768 encapsulation → post-quantum shared secret (32 bytes)
 *   3. Both shared secrets + F prefix → HKDF-SHA256 → 32-byte key
 *
 * The classical component provides forward secrecy (ephemeral X25519).
 * The post-quantum component provides resistance to harvest-now-decrypt-later
 * attacks from quantum adversaries. Both are required — compromising only
 * one does not break the hybrid key (FIPS 203 + RFC 7748).
 *
 * KDF construction (Signal PQXDH §3.3 with one deliberate deviation):
 *   IKM  = F(32×0xFF) ‖ x25519_ss ‖ ml_kem_ss  (96 bytes)
 *   salt = recipient_x25519_pub ‖ eph_pub ‖ ml_kem_ct  (transcript, 1152 bytes)
 *   info = "oxp/pqxdh/v1"
 *
 * F prefix: 32 bytes of 0xFF prepended to IKM per Signal spec — ensures the
 * first bits of HKDF input are never a valid X25519 scalar/point encoding.
 *
 * DELIBERATE DEVIATION from Signal spec: salt is the full transcript (public
 * keys + ML-KEM ciphertext) instead of Signal's zero-filled salt. This provides
 * stronger transcript binding — an attacker cannot substitute key shares
 * (UKS defense) because the salt binds all public material. Signal relies on
 * the info parameter for this; we bind in salt for defense-in-depth. The IKM
 * F-prefix and shared-secret ordering match the spec exactly.
 *
 * Identity binding: this KEM is a PRIMITIVE — it does not bind sender/recipient
 * identity keys. Identity binding is provided by the higher-level protocol
 * (pairwise-seal.ts: AAD = "oxp/pw/v1" ‖ sender_ed25519_pub ‖ msg_id, plus
 * Ed25519 signature verification). Callers MUST NOT use hybridKemEncaps/
 * Decaps in isolation without an identity-binding layer.
 *
 * ML-KEM-768 key sizes (FIPS 203):
 *   - publicKey: 1184 bytes
 *   - secretKey: 2400 bytes
 *   - ciphertext: 1088 bytes
 *   - sharedSecret: 32 bytes
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { generateEphemeralKeypair, deriveSharedSecret } from './x25519.ts';
import { hkdfExtract, hkdfExpand } from './hkdf.ts';
import { zeroize } from './zeroize.ts';

const PQXDH_INFO = new TextEncoder().encode('oxp/pqxdh/v1');
const F_PREFIX = new Uint8Array(32).fill(0xff); // Signal PQXDH §3.3: F = 32×0xFF for X25519

/**
 * ML-KEM-768 keypair (post-quantum prekey).
 */
export interface MlKemKeyPair {
	publicKey: Uint8Array; // 1184 bytes
	secretKey: Uint8Array; // 2400 bytes
}

/**
 * Generate an ML-KEM-768 keypair for post-quantum key encapsulation.
 */
export function mlKemKeygen(): MlKemKeyPair {
	const kp = ml_kem768.keygen();
	return {
		publicKey: kp.publicKey,
		secretKey: kp.secretKey,
	};
}

/**
 * PQXDH hybrid keypair — X25519 identity + ML-KEM-768 prekey.
 * The recipient publishes both public keys; the sender uses both to
 * derive a hybrid shared secret.
 */
export interface HybridKemKeyPair {
	x25519PublicKey: Uint8Array; // 32 bytes
	x25519SecretKey: Uint8Array; // 32 bytes
	mlKemPublicKey: Uint8Array; // 1184 bytes
	mlKemSecretKey: Uint8Array; // 2400 bytes
}

/**
 * Generate a hybrid X25519 + ML-KEM-768 keypair.
 */
export function hybridKemKeygen(): HybridKemKeyPair {
	const x25519 = generateEphemeralKeypair();
	const mlKem = mlKemKeygen();
	return {
		x25519PublicKey: x25519.publicKey,
		x25519SecretKey: x25519.privateKey,
		mlKemPublicKey: mlKem.publicKey,
		mlKemSecretKey: mlKem.secretKey,
	};
}

/**
 * PQXDH encapsulation result — what the sender transmits to the recipient.
 */
export interface HybridKemEncapsulation {
	/** X25519 ephemeral public key (32 bytes) — sent to recipient. */
	ephemeralX25519Pub: Uint8Array;
	/** ML-KEM-768 ciphertext (1088 bytes) — sent to recipient. */
	mlKemCiphertext: Uint8Array;
	/** Derived hybrid shared secret (32 bytes) — used as AEAD key material. */
	sharedSecret: Uint8Array;
}

/**
 * PQXDH hybrid encapsulation: sender derives a shared secret from
 * X25519 DH + ML-KEM-768 encapsulation against the recipient's hybrid prekey.
 *
 * @param recipientX25519Pub  Recipient's X25519 public key (32 bytes)
 * @param recipientMlKemPub   Recipient's ML-KEM-768 public key (1184 bytes)
 * @returns                   Encapsulation (eph_pub + ml_kem_ct + shared_secret)
 */
export function hybridKemEncaps(
	recipientX25519Pub: Uint8Array,
	recipientMlKemPub: Uint8Array,
): HybridKemEncapsulation {
	// 1. X25519 ephemeral DH
	const { privateKey: ephPriv, publicKey: ephPub } = generateEphemeralKeypair();
	let x25519Secret: Uint8Array | undefined;
	let mlKemSecret: Uint8Array | undefined;
	let mlKemCiphertext: Uint8Array | undefined;
	let ikm: Uint8Array | undefined;
	let prk: Uint8Array | undefined;

	try {
		x25519Secret = deriveSharedSecret(ephPriv, recipientX25519Pub);

		// 2. ML-KEM-768 encapsulation
		const mlKemResult = ml_kem768.encapsulate(recipientMlKemPub);
		mlKemSecret = mlKemResult.sharedSecret;
		mlKemCiphertext = mlKemResult.cipherText;

		// 3. Hybrid KDF: F prefix + both secrets → HKDF
		//    IKM = F(32×0xFF) ‖ x25519_secret ‖ ml_kem_secret (96 bytes)
		//    salt = recipient_x25519_pub ‖ eph_pub ‖ ml_kem_ct (transcript, 1152 bytes)
		ikm = concatBytes(F_PREFIX, x25519Secret, mlKemSecret);
		const salt = concatBytes(recipientX25519Pub, ephPub, mlKemCiphertext);

		prk = hkdfExtract(ikm, salt);
		const sharedSecret = hkdfExpand(prk, PQXDH_INFO, 32);

		return {
			ephemeralX25519Pub: ephPub,
			mlKemCiphertext,
			sharedSecret,
		};
	} finally {
		// Zeroize intermediate secrets on ALL paths (success + error).
		zeroize(ephPriv);
		if (x25519Secret) zeroize(x25519Secret);
		if (mlKemSecret) zeroize(mlKemSecret);
		if (ikm) zeroize(ikm);
		if (prk) zeroize(prk);
	}
}

/**
 * PQXDH hybrid decapsulation: recipient recovers the shared secret from
 * the sender's ephemeral X25519 public key + ML-KEM-768 ciphertext.
 *
 * @param ephX25519Pub       Sender's ephemeral X25519 public key (32 bytes)
 * @param mlKemCiphertext    Sender's ML-KEM-768 ciphertext (1088 bytes)
 * @param recipientX25519Priv Recipient's X25519 private key (32 bytes)
 * @param recipientX25519Pub  Recipient's X25519 public key (32 bytes, for salt)
 * @param recipientMlKemPriv  Recipient's ML-KEM-768 secret key (2400 bytes)
 * @returns                   Derived hybrid shared secret (32 bytes)
 */
export function hybridKemDecaps(
	ephX25519Pub: Uint8Array,
	mlKemCiphertext: Uint8Array,
	recipientX25519Priv: Uint8Array,
	recipientX25519Pub: Uint8Array,
	recipientMlKemPriv: Uint8Array,
): Uint8Array {
	let x25519Secret: Uint8Array | undefined;
	let mlKemSecret: Uint8Array | undefined;
	let ikm: Uint8Array | undefined;
	let prk: Uint8Array | undefined;

	try {
		// 1. X25519 DH
		x25519Secret = deriveSharedSecret(recipientX25519Priv, ephX25519Pub);

		// 2. ML-KEM-768 decapsulation
		mlKemSecret = ml_kem768.decapsulate(mlKemCiphertext, recipientMlKemPriv);

		// 3. Hybrid KDF — must match encapsulate exactly
		//    IKM = F(32×0xFF) ‖ x25519_secret ‖ ml_kem_secret (96 bytes)
		ikm = concatBytes(F_PREFIX, x25519Secret, mlKemSecret);
		const salt = concatBytes(recipientX25519Pub, ephX25519Pub, mlKemCiphertext);

		prk = hkdfExtract(ikm, salt);
		const sharedSecret = hkdfExpand(prk, PQXDH_INFO, 32);

		return sharedSecret;
	} finally {
		// Zeroize intermediate secrets on ALL paths (success + error).
		if (x25519Secret) zeroize(x25519Secret);
		if (mlKemSecret) zeroize(mlKemSecret);
		if (ikm) zeroize(ikm);
		if (prk) zeroize(prk);
	}
}
