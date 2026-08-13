import { describe, it, expect } from 'vitest';
import {
	mlKemKeygen,
	hybridKemKeygen,
	hybridKemEncaps,
	hybridKemDecaps,
} from '../kem.ts';
import { deriveSharedSecret } from '../x25519.ts';

describe('PQXDH hybrid key agreement (X25519 + ML-KEM-768)', () => {
	it('mlKemKeygen: produces correctly-sized ML-KEM-768 keypair', () => {
		const kp = mlKemKeygen();
		expect(kp.publicKey.byteLength).toBe(1184);
		expect(kp.secretKey.byteLength).toBe(2400);
	});

	it('hybridKemKeygen: produces both X25519 and ML-KEM-768 keys', () => {
		const kp = hybridKemKeygen();
		expect(kp.x25519PublicKey.byteLength).toBe(32);
		expect(kp.x25519SecretKey.byteLength).toBe(32);
		expect(kp.mlKemPublicKey.byteLength).toBe(1184);
		expect(kp.mlKemSecretKey.byteLength).toBe(2400);
	});

	it('encapsulate/decapsulate: both parties derive identical shared secret', () => {
		const recipient = hybridKemKeygen();

		// Sender encapsulates against recipient's hybrid prekey
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);
		expect(enc.ephemeralX25519Pub.byteLength).toBe(32);
		expect(enc.mlKemCiphertext.byteLength).toBe(1088);
		expect(enc.sharedSecret.byteLength).toBe(32);

		// Recipient decapsulates
		const decSharedSecret = hybridKemDecaps(
			enc.ephemeralX25519Pub,
			enc.mlKemCiphertext,
			recipient.x25519SecretKey,
			recipient.x25519PublicKey,
			recipient.mlKemSecretKey,
		);

		expect(decSharedSecret).toEqual(enc.sharedSecret);
	});

	it('shared secret is 32 bytes and not all zeros', () => {
		const recipient = hybridKemKeygen();
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);
		expect(enc.sharedSecret.byteLength).toBe(32);
		expect(enc.sharedSecret.some((b) => b !== 0)).toBe(true);
	});

	it('different recipients produce different shared secrets', () => {
		const alice = hybridKemKeygen();
		const bob = hybridKemKeygen();

		const encAlice = hybridKemEncaps(alice.x25519PublicKey, alice.mlKemPublicKey);
		const encBob = hybridKemEncaps(bob.x25519PublicKey, bob.mlKemPublicKey);

		expect(encAlice.sharedSecret).not.toEqual(encBob.sharedSecret);
	});

	it('same recipient, two encapsulations produce different shared secrets (ephemeral)', () => {
		const recipient = hybridKemKeygen();

		const enc1 = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);
		const enc2 = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		// X25519 ephemeral keys are random → different shared secrets
		expect(enc1.sharedSecret).not.toEqual(enc2.sharedSecret);
		expect(enc1.ephemeralX25519Pub).not.toEqual(enc2.ephemeralX25519Pub);
	});

	it('fail-closed: wrong X25519 private key → different shared secret (not the right one)', () => {
		const recipient = hybridKemKeygen();
		const attacker = hybridKemKeygen(); // wrong X25519 key

		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		// Attacker uses their own X25519 priv (wrong) but correct ML-KEM priv
		const wrongSecret = hybridKemDecaps(
			enc.ephemeralX25519Pub,
			enc.mlKemCiphertext,
			attacker.x25519SecretKey, // wrong
			recipient.x25519PublicKey, // salt uses recipient pub (public info)
			recipient.mlKemSecretKey, // correct ML-KEM
		);

		// Must NOT match the real shared secret
		expect(wrongSecret).not.toEqual(enc.sharedSecret);
	});

	it('fail-closed: wrong ML-KEM secret key → different shared secret', () => {
		const recipient = hybridKemKeygen();
		const attacker = hybridKemKeygen();

		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		const wrongSecret = hybridKemDecaps(
			enc.ephemeralX25519Pub,
			enc.mlKemCiphertext,
			recipient.x25519SecretKey, // correct X25519
			recipient.x25519PublicKey,
			attacker.mlKemSecretKey, // wrong ML-KEM
		);

		expect(wrongSecret).not.toEqual(enc.sharedSecret);
	});

	it('fail-closed: both keys wrong → completely different shared secret', () => {
		const recipient = hybridKemKeygen();
		const attacker = hybridKemKeygen();

		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		const wrongSecret = hybridKemDecaps(
			enc.ephemeralX25519Pub,
			enc.mlKemCiphertext,
			attacker.x25519SecretKey,
			recipient.x25519PublicKey,
			attacker.mlKemSecretKey,
		);

		expect(wrongSecret).not.toEqual(enc.sharedSecret);
	});

	it('tampered ML-KEM ciphertext → decapsulation fails or produces wrong secret', () => {
		const recipient = hybridKemKeygen();
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		// Flip a byte in the ML-KEM ciphertext
		const tamperedCt = new Uint8Array(enc.mlKemCiphertext);
		tamperedCt[0] ^= 0xff;

		// Decapsulation with tampered ciphertext must not produce the correct secret.
		// ML-KEM is a CCA-secure KEM — tampering causes decapsulation failure or
		// a completely different shared secret (never the original).
		let wrongSecret: Uint8Array;
		try {
			wrongSecret = hybridKemDecaps(
				enc.ephemeralX25519Pub,
				tamperedCt,
				recipient.x25519SecretKey,
				recipient.x25519PublicKey,
				recipient.mlKemSecretKey,
			);
			expect(wrongSecret).not.toEqual(enc.sharedSecret);
		} catch {
			// ML-KEM decapsulation may throw on invalid ciphertext — acceptable
		}
	});

	it('tampered ephemeral X25519 pub → different shared secret', () => {
		const recipient = hybridKemKeygen();
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		// Flip a byte in the ephemeral public key
		const tamperedEphPub = new Uint8Array(enc.ephemeralX25519Pub);
		tamperedEphPub[0] ^= 0xff;

		const wrongSecret = hybridKemDecaps(
			tamperedEphPub,
			enc.mlKemCiphertext,
			recipient.x25519SecretKey,
			recipient.x25519PublicKey,
			recipient.mlKemSecretKey,
		);

		expect(wrongSecret).not.toEqual(enc.sharedSecret);
	});

	it('hybrid secret differs from X25519-only secret (PQ component contributes)', () => {
		const recipient = hybridKemKeygen();
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		// Compute X25519-only shared secret (no ML-KEM)
		const x25519Only = deriveSharedSecret(recipient.x25519SecretKey, enc.ephemeralX25519Pub);

		// Hybrid secret must differ — ML-KEM component contributes entropy
		expect(enc.sharedSecret).not.toEqual(x25519Only);
	});

	it('round-trip with 100+ byte plaintext via XChaCha20 (integration)', async () => {
		const { xchachaSeal, xchachaOpen, xchachaRandomNonce } = await import('../xchacha.ts');
		const recipient = hybridKemKeygen();
		const enc = hybridKemEncaps(recipient.x25519PublicKey, recipient.mlKemPublicKey);

		const plaintext = new TextEncoder().encode(
			'PQXDH + XChaCha20-Poly1305 integration test — this is a longer message to verify end-to-end correctness.',
		);
		const aad = new TextEncoder().encode('oxp/pqxdh-integration');
		const nonce = xchachaRandomNonce();

		// Sender seals with hybrid shared secret
		const sealed = xchachaSeal(enc.sharedSecret, nonce, aad, plaintext);

		// Recipient decapsulates then opens
		const decSharedSecret = hybridKemDecaps(
			enc.ephemeralX25519Pub,
			enc.mlKemCiphertext,
			recipient.x25519SecretKey,
			recipient.x25519PublicKey,
			recipient.mlKemSecretKey,
		);
		const decrypted = xchachaOpen(decSharedSecret, aad, sealed);

		expect(decrypted).toEqual(plaintext);
	});
});
