/**
 * base64url encode/decode helpers (RFC 4648 §5, URL-safe alphabet, no padding).
 *
 * Single canonical home for base64url serialization across the SDK (#218 nit #11).
 * Replaces ad-hoc copies in `intro-crypto.ts`, `chat-sdk/push.ts`, and the
 * private `b64uDecodeBytes` in `timing-safe.ts`.
 *
 * Cross-platform: uses `atob`/`btoa` (available in browsers, Node 16+, Deno,
 * Bun). No `Buffer.from(..., 'base64url')` — not browser-safe.
 */

/** Encode raw bytes to a base64url string (no padding). */
export function b64uEncodeBytes(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string (no padding) to raw bytes.
 *
 * Throws `DOMException` (via `atob`) on invalid base64 — callers handling
 * attacker-influenced input should either pre-validate the charset or wrap
 * in try/catch. For constant-time comparison of attacker-supplied b64u
 * pubkeys, use `timingSafePubkeyEqualB64u` from `./timing-safe.ts`, which
 * swallows the throw and returns `false`. */
export function b64uDecodeBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
