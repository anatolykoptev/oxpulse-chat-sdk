/**
 * Constant-time comparison helpers for attacker-influenced cryptographic
 * identifiers.
 *
 * INVARIANT: Use these for ANY comparison of attacker-influenced
 * cryptographic identifiers (pubkeys, MAC tags, signatures, sessionIds).
 * NEVER use `===` on raw b64u strings — it leaks the first-mismatch byte
 * position via timing (OWASP ASVS V11.3.1, CWE-208).
 */

import { equalBytes } from '@noble/curves/utils.js';

/**
 * Constant-time byte-array equality (XOR-reduce-OR).
 *
 * Delegates to `@noble/curves` `equalBytes` (already a dependency) to avoid
 * reinventing the standard constant-time comparison primitive. Returns
 * `false` immediately on length mismatch — length is non-secret.
 * No short-circuit path based on byte content (W4).
 */
export const timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean = equalBytes;

/** Decode a base64url string (no padding) to raw bytes.
 *
 * Module-internal helper — NOT re-exported from the package index. Callers
 * needing b64u decode from the public API should use the dedicated
 * `b64uDecodeBytes` re-exported via `./base64url.ts` (see #218 nit #11).
 * Kept here as a private helper for `timingSafePubkeyEqualB64u`. */
function b64uDecodeBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Constant-time comparison of two base64url-encoded public keys (or any
 * attacker-influenced cryptographic identifier).
 *
 * Decodes both strings to bytes, then compares with {@link timingSafeEqual}.
 * Returns `false` immediately on length mismatch (length is non-secret).
 *
 * Invalid base64url input (chars outside `[A-Za-z0-9_-]` or wrong padding)
 * returns `false` rather than throwing — the function is total for all
 * string inputs, which is the safer contract for the documented
 * "attacker-influenced" use case (#218 nit #9). Callers comparing a trusted
 * pubkey against an attacker-supplied one do not need to pre-validate or
 * wrap in try/catch.
 *
 * INVARIANT: Use this instead of `===` whenever comparing pubkey_b64u,
 * sessionId, or any cryptographic value that influences security decisions.
 * See OWASP ASVS V11.3.1 and CWE-208.
 */
export function timingSafePubkeyEqualB64u(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let da: Uint8Array, db: Uint8Array;
	try {
		da = b64uDecodeBytes(a);
		db = b64uDecodeBytes(b);
	} catch {
		// atob throws DOMException on invalid base64 — treat as "not equal"
		// rather than propagating. Caller can distinguish only by pre-validating.
		return false;
	}
	return timingSafeEqual(da, db);
}
