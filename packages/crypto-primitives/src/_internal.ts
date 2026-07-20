// LOAD-BEARING: deliberate copy per Phase 1 plan operator-decision #7.
// Forbids the dep arrow primitives → identity.
// See identity-extraction-adr.md §2.2 for the sole-consumer audit rationale.
//
// Copied from packages/identity/src/crypto-utils.ts which was itself
// copied from web/src/lib/crypto-utils.ts.

/**
 * Return an exclusive ArrayBuffer holding a copy of the Uint8Array's bytes.
 *
 * Solves two problems:
 *  1. Parent-buffer aliasing — u8.buffer can be larger than u8 when the view
 *     is a subarray/slice (byteOffset > 0). Passing u8.buffer directly to
 *     WebCrypto feeds the full parent buffer — wrong IKM / salt / digest input.
 *  2. SharedArrayBuffer leakage — WebCrypto rejects shared buffers.
 *
 * See web/src/lib/crypto-utils.ts for full rationale.
 */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(u8.byteLength);
	new Uint8Array(out).set(u8);
	return out;
}
