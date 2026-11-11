import { describe, it, expect } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { sealMessage, openMessage, verifyEnvelopeSender } from '../pairwise-seal.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeMessageEnvelope } from '../envelope.ts';
import * as barrel from '../index.ts';

// Wire offsets (envelope.ts): magic[0..4) version[4] flags[5] msgId[6..22)
// recipientAddr[22..30) sig[30..94) len[94..98) IC[98..)
const OFF = { version: 4, flags: 5, msgId: 6, addr: 22, sig: 30, len: 94, ic: 98 };

async function sealFor(
	signer: ReturnType<typeof ed25519.keygen>,
	recipientPub: Uint8Array,
	flags = 0,
) {
	return sealMessage({
		plaintext: new TextEncoder().encode('verify-only'),
		recipientX25519Pub: recipientPub,
		senderEd25519PrivKey: signer.secretKey,
		senderEd25519PubKey: signer.publicKey,
		msgId: crypto.getRandomValues(new Uint8Array(16)),
		flags,
	});
}

function flip(env: Uint8Array, at: number): Uint8Array {
	const c = env.slice();
	c[at] = c[at]! ^ 0x01;
	return c;
}

describe('verifyEnvelopeSender', () => {
	const peer = ed25519.keygen();
	const otherDevice = x25519.keygen(); // verifier never sees this secret

	it('is exported from the barrel', () => {
		expect(barrel.verifyEnvelopeSender).toBe(verifyEnvelopeSender);
	});

	it('true for a real sealMessage output, even addressed to a recipient the verifier never holds', async () => {
		const env = await sealFor(peer, otherDevice.publicKey);
		expect(await verifyEnvelopeSender(env, peer.publicKey)).toBe(true);
		// oracle: openMessage with a DIFFERENT recipient key rejects at the
		// recipient-address check — the gap this API closes.
		const mine = x25519.keygen();
		await expect(
			openMessage({
				envelopeBytes: env,
				recipientX25519Priv: mine.secretKey,
				recipientX25519Pub: mine.publicKey,
				expectedSenderEd25519Pub: peer.publicKey,
			}),
		).rejects.toThrow(/recipient address mismatch/);
	});

	it('true for non-default flags (flags are bound, not assumed 0)', async () => {
		const env = await sealFor(peer, otherDevice.publicKey, 0x03);
		expect(await verifyEnvelopeSender(env, peer.publicKey)).toBe(true);
	});

	it('false for a different (forged) expected sender pub', async () => {
		const env = await sealFor(peer, otherDevice.publicKey);
		const attacker = ed25519.keygen();
		expect(await verifyEnvelopeSender(env, attacker.publicKey)).toBe(false);
	});

	it('false for an envelope signed by a different key but claiming nothing of the peer', async () => {
		const attacker = ed25519.keygen();
		const env = await sealFor(attacker, otherDevice.publicKey);
		expect(await verifyEnvelopeSender(env, peer.publicKey)).toBe(false);
		expect(await verifyEnvelopeSender(env, attacker.publicKey)).toBe(true);
	});

	it.each([
		['version', OFF.version],
		['flags', OFF.flags],
		['msgId', OFF.msgId + 3],
		['recipientAddr', OFF.addr + 3],
		['senderSig', OFF.sig + 10],
		['senderSig last byte', OFF.sig + 63],
		['IC eph_pub', OFF.ic + 5],
		['IC nonce', OFF.ic + 35],
		['IC ct tail', -1],
	])('false when a byte of %s is flipped', async (_name, at) => {
		const env = await sealFor(peer, otherDevice.publicKey);
		const idx = at < 0 ? env.length + at : at;
		expect(await verifyEnvelopeSender(flip(env, idx), peer.publicKey)).toBe(false);
	});

	it('false (no throw) for malformed envelopes', async () => {
		const env = await sealFor(peer, otherDevice.publicKey);
		expect(await verifyEnvelopeSender(new Uint8Array(0), peer.publicKey)).toBe(false);
		expect(await verifyEnvelopeSender(env.slice(0, 50), peer.publicKey)).toBe(false);
		expect(await verifyEnvelopeSender(env.slice(0, env.length - 1), peer.publicKey)).toBe(false);
		const trailing = new Uint8Array(env.length + 1);
		trailing.set(env);
		expect(await verifyEnvelopeSender(trailing, peer.publicKey)).toBe(false);
		expect(await verifyEnvelopeSender(flip(env, 0), peer.publicKey)).toBe(false); // magic
	});

	it('false for an all-zero signature and for an identity-point pub with identity sig', async () => {
		const env = await sealFor(peer, otherDevice.publicKey);
		const zeroSig = env.slice();
		zeroSig.fill(0, OFF.sig, OFF.sig + 64);
		expect(await verifyEnvelopeSender(zeroSig, peer.publicKey)).toBe(false);
		// small-order identity key (y=1) + identity signature: accepted by ZIP-215
		// for any message, must be rejected by strict mode.
		const identity = new Uint8Array(32);
		identity[0] = 1;
		const idSig = env.slice();
		idSig.fill(0, OFF.sig, OFF.sig + 64);
		idSig[OFF.sig] = 1;
		expect(await verifyEnvelopeSender(idSig, identity)).toBe(false);
	});

	it('throws TypeError (programmer error) when expected pub is not 32 bytes', async () => {
		const env = await sealFor(peer, otherDevice.publicKey);
		await expect(verifyEnvelopeSender(env, new Uint8Array(31))).rejects.toThrow(TypeError);
		await expect(verifyEnvelopeSender(env, new Uint8Array(33))).rejects.toThrow(TypeError);
	});

	it('false for a correctly SIGNED envelope whose IC is below the openMessage minimum', async () => {
		// Independent transcript: SHA-256("oxp/pw/v1" ‖ 02 ‖ flags ‖ msgId ‖ addr ‖ pub).
		const msgId = crypto.getRandomValues(new Uint8Array(16));
		const addr = sha256(otherDevice.publicKey).slice(0, 8);
		const build = (icLen: number) => {
			const ic = crypto.getRandomValues(new Uint8Array(icLen));
			const t = new Uint8Array(67);
			t.set(new TextEncoder().encode('oxp/pw/v1'), 0);
			t[9] = 0x02;
			t[10] = 0;
			t.set(msgId, 11);
			t.set(addr, 27);
			t.set(peer.publicKey, 35);
			const signed = new Uint8Array(64);
			signed.set(sha256(t), 0);
			signed.set(sha256(ic), 32);
			return encodeMessageEnvelope({
				flags: 0,
				msgId,
				recipientAddr: addr,
				senderSig: ed25519.sign(signed, peer.secretKey),
				innerCiphertext: ic,
			});
		};
		expect(await verifyEnvelopeSender(build(60), peer.publicKey)).toBe(true); // boundary
		expect(await verifyEnvelopeSender(build(59), peer.publicKey)).toBe(false);
		expect(await verifyEnvelopeSender(build(0), peer.publicKey)).toBe(false);
	});
});
