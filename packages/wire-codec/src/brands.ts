// brands.ts — phantom branded types for the wire-codec byte pipeline.
//
// WireBytes  = compressed (cbor+zstd), not yet sealed. Produced by encode(),
//              encodeHttpBody(), toV2()+compress(). Consumed by decode(),
//              decodeHttpBody(), fromV2()+decompress().
//
// SealedBytes = post-AEAD-seal, on the network. Callers outside wire-codec
//               are responsible for the seal/unseal boundary; these types
//               make the ordering explicit at compile time.
//
// Both brands are phantom (the runtime value is a plain Uint8Array).
// Zero JS emit change — tsc strips the type annotation entirely.

declare const brand: unique symbol;
// The unique symbol provides nominal typing; the string literals
// "wire" vs "sealed" are what distinguish the two brand types.

/** Compressed, pre-seal wire bytes. Output of encode() / encodeHttpBody(). */
export type WireBytes   = Uint8Array & { readonly [brand]: "wire" };

/** Post-seal, on-the-wire bytes. Output of an E2EE seal step. */
export type SealedBytes = Uint8Array & { readonly [brand]: "sealed" };

/**
 * NOTE: `decodeHttpBody` and similar functions retain a `string` overload for
 * callers parsing already-stringified bodies (e.g. browser fetch `.text()`).
 * The `string` path is unbranded — by design — since strings cannot carry a
 * compile-time wire/sealed distinction. The brand provides defense-in-depth
 * for the Uint8Array path only.
 */

/** Lift a raw Uint8Array into the wire (compressed, not yet sealed) domain. */
export function asWireBytes(u: Uint8Array): WireBytes {
  return u as WireBytes;
}

/** Lift a raw Uint8Array into the sealed (on-the-wire post-encrypt) domain. */
export function asSealedBytes(u: Uint8Array): SealedBytes {
  return u as SealedBytes;
}

declare const meshBrand: unique symbol;
/** Bytes that conform to the 0xC9 mesh-bundle-v1 wire format. */
export type MeshBundleBytes = Uint8Array & { readonly [meshBrand]: 'mesh-bundle' };

/** Lift raw bytes into MeshBundleBytes (callers verify shape externally). */
export function asMeshBundleBytes(u: Uint8Array): MeshBundleBytes {
  return u as MeshBundleBytes;
}
