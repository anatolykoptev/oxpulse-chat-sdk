/**
 * Best-effort secret zeroization for `Uint8Array`.
 *
 * Delegates to `@noble/hashes` `clean()` (already a dependency) to avoid
 * reinventing the standard zeroization primitive. Adds a try/catch for
 * detached ArrayBuffers (transferred to a Worker) — `clean` would throw
 * on those, and there is nothing to zeroize in that case.
 *
 * In JS there is no guarantee the old bytes are not still resident on the
 * heap (GC is non-deterministic, and the engine may have copied the data
 * internally). This helper minimizes the window by clearing the buffer
 * in-place as soon as the secret is no longer needed.
 *
 * For truly sensitive long-lived keys, prefer short-lived scopes and let GC
 * collect the `Uint8Array` promptly after zeroization. Rust's `zeroize` crate
 * (used by libsignal) provides stronger guarantees via `ZeroizeOnDrop`; JS
 * cannot match that without WASM.
 *
 * @param arr The buffer to zeroize. No-op on zero-length or detached buffers.
 */
import { clean } from '@noble/hashes/utils.js';

export function zeroize(arr: Uint8Array): void {
	if (arr.byteLength === 0) return;
	try {
		clean(arr);
	} catch {
		// Detached ArrayBuffer (transferred to a Worker) — nothing to zeroize.
	}
}
