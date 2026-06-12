/**
 * Phase B mesh-bundle-v1 wire format (magic byte 0xC9).
 *
 * Header layout (61 B fixed header + N body + 64 B sig):
 *   offset 0   1   MAGIC = 0xC9
 *   offset 1   1   version = 0x01
 *   offset 2   32  sender_pubkey (Ed25519 raw)
 *   offset 34  16  msg_id (UUID v4 raw)
 *   offset 50  4   ts_s_offset (u32 BE; seconds since ROOM_EPOCH)
 *   offset 54  1   ttl_hops (u8)
 *   offset 55  4   channel_id_hash (first 4 B of BLAKE3(geohash || day_utc))
 *   offset 59  2   body_len (u16 BE; <= 1500)
 *   offset 61  N   body (zstd-compressed CBOR; internal magic at body[0])
 *   offset 61+N 64  signature (Ed25519 over bytes[0..61+N])
 *
 * Frame fixed overhead = 125 B (header 61 + sig 64).
 * Total: 125 + body_len bytes (max ~1625 B).
 *
 * ts_s_offset is u32 seconds since ROOM_EPOCH (2026-01-01 UTC).
 * u32::MAX seconds = ~136 years headroom. No overflow concern through ~2162.
 *
 * See spec: docs/superpowers/specs/2026-05-16-mesh-phase-b-public-broadcast-design.md
 * See ADR: docs/architecture/mesh-bundle-ts-overflow-adr.md
 */

import { WireCodecError } from './errors.ts';

export const MESH_BUNDLE_MAGIC_V1 = 0xc9;
export const MESH_BUNDLE_VERSION = 0x01;
export const MESH_BUNDLE_HEADER_FIXED_LEN = 61; // bytes before body
export const MESH_BUNDLE_SIG_LEN = 64;
export const MESH_BUNDLE_MAX_BODY = 1500;

export interface MeshBundleEncodeArgs {
  senderPubkey: Uint8Array; // 32 B
  msgId: Uint8Array; // 16 B
  tsSecOffset: number; // u32; seconds since ROOM_EPOCH
  ttlHops: number; // u8
  channelIdHash: Uint8Array; // 4 B
  body: Uint8Array; // <= 1500 B
  signature: Uint8Array; // 64 B
}

export interface MeshBundleDecoded {
  senderPubkey: Uint8Array;
  msgId: Uint8Array;
  tsSecOffset: number;
  ttlHops: number;
  channelIdHash: Uint8Array;
  body: Uint8Array;
  signature: Uint8Array;
}

export function encodeMeshBundle(args: MeshBundleEncodeArgs): Uint8Array {
  // Fixed-array field validation -- wrong lengths are data/key errors, not sig errors
  if (args.senderPubkey.length !== 32) {
    throw new WireCodecError('MESH_BUNDLE_FIELD_INVALID', 'senderPubkey must be 32 bytes', {
      field: 'senderPubkey', length: args.senderPubkey.length, expected: 32,
    });
  }
  if (args.msgId.length !== 16) {
    throw new WireCodecError('MESH_BUNDLE_FIELD_INVALID', 'msgId must be 16 bytes', {
      field: 'msgId', length: args.msgId.length, expected: 16,
    });
  }
  if (args.channelIdHash.length !== 4) {
    throw new WireCodecError('MESH_BUNDLE_FIELD_INVALID', 'channelIdHash must be 4 bytes', {
      field: 'channelIdHash', length: args.channelIdHash.length, expected: 4,
    });
  }
  // Signature wrong length is a sig error (caller passed a bad signature)
  if (args.signature.length !== MESH_BUNDLE_SIG_LEN) {
    throw new WireCodecError('MESH_BUNDLE_SIG_INVALID', 'signature must be 64 bytes', {
      length: args.signature.length,
    });
  }
  // Numeric field validation -- must be integers in their wire ranges
  if (!Number.isInteger(args.tsSecOffset) || args.tsSecOffset < 0 || args.tsSecOffset > 0xffffffff) {
    throw new WireCodecError(
      'MESH_BUNDLE_FIELD_INVALID',
      'tsSecOffset must be an integer in [0, 0xFFFFFFFF]',
      { field: 'tsSecOffset', value: args.tsSecOffset },
    );
  }
  if (!Number.isInteger(args.ttlHops) || args.ttlHops < 0 || args.ttlHops > 255) {
    throw new WireCodecError(
      'MESH_BUNDLE_FIELD_INVALID',
      'ttlHops must be an integer in [0, 255]',
      { field: 'ttlHops', value: args.ttlHops },
    );
  }
  if (args.body.length > MESH_BUNDLE_MAX_BODY) {
    throw new WireCodecError(
      'MESH_BUNDLE_TOO_LARGE',
      ` body exceeds ` + MESH_BUNDLE_MAX_BODY + ` B cap`,
      { size: args.body.length, cap: MESH_BUNDLE_MAX_BODY },
    );
  }

  const total = MESH_BUNDLE_HEADER_FIXED_LEN + args.body.length + MESH_BUNDLE_SIG_LEN;
  const out = new Uint8Array(total);
  out[0] = MESH_BUNDLE_MAGIC_V1;
  out[1] = MESH_BUNDLE_VERSION;
  out.set(args.senderPubkey, 2);
  out.set(args.msgId, 34);
  // ts_s_offset u32 BE
  out[50] = (args.tsSecOffset >>> 24) & 0xff;
  out[51] = (args.tsSecOffset >>> 16) & 0xff;
  out[52] = (args.tsSecOffset >>> 8) & 0xff;
  out[53] = args.tsSecOffset & 0xff;
  out[54] = args.ttlHops & 0xff;
  out.set(args.channelIdHash, 55);
  // body_len u16 BE
  out[59] = (args.body.length >>> 8) & 0xff;
  out[60] = args.body.length & 0xff;
  out.set(args.body, MESH_BUNDLE_HEADER_FIXED_LEN);
  out.set(args.signature, MESH_BUNDLE_HEADER_FIXED_LEN + args.body.length);
  return out;
}

export function decodeMeshBundle(wire: Uint8Array): MeshBundleDecoded {
  // Must be at least 125 B: 61 B header + 0 B body + 64 B sig
  if (wire.length < MESH_BUNDLE_HEADER_FIXED_LEN + MESH_BUNDLE_SIG_LEN) {
    throw new WireCodecError('MESH_BUNDLE_TRUNCATED', 'bundle below minimum size', {
      size: wire.length,
      min: MESH_BUNDLE_HEADER_FIXED_LEN + MESH_BUNDLE_SIG_LEN,
    });
  }
  if (wire[0] !== MESH_BUNDLE_MAGIC_V1) {
    throw new WireCodecError('UNKNOWN_MAGIC', 'mesh-bundle magic byte mismatch', {
      magic: wire[0]!,
    });
  }
  if (wire[1] !== MESH_BUNDLE_VERSION) {
    throw new WireCodecError('MESH_BUNDLE_VERSION_UNSUPPORTED', 'mesh-bundle version not supported', {
      version: wire[1]!,
      supported: MESH_BUNDLE_VERSION,
    });
  }
  const bodyLen = (wire[59]! << 8) | wire[60]!;
  if (bodyLen > MESH_BUNDLE_MAX_BODY) {
    // Cap violation -- body_len in header exceeds protocol maximum
    throw new WireCodecError('MESH_BUNDLE_TOO_LARGE', 'body_len exceeds cap', {
      bodyLen,
      cap: MESH_BUNDLE_MAX_BODY,
    });
  }
  const expectedTotal = MESH_BUNDLE_HEADER_FIXED_LEN + bodyLen + MESH_BUNDLE_SIG_LEN;
  if (wire.length !== expectedTotal) {
    // Wire length mismatches declared body_len -- bundle is truncated or malformed
    throw new WireCodecError('MESH_BUNDLE_TRUNCATED', 'bundle size mismatches header body_len', {
      actual: wire.length,
      expected: expectedTotal,
    });
  }
  const tsSecOffset =
    (((wire[50]! << 24) | (wire[51]! << 16) | (wire[52]! << 8) | wire[53]!) >>> 0);
  return {
    senderPubkey: wire.slice(2, 34),
    msgId: wire.slice(34, 50),
    tsSecOffset,
    ttlHops: wire[54]!,
    channelIdHash: wire.slice(55, 59),
    body: wire.slice(MESH_BUNDLE_HEADER_FIXED_LEN, MESH_BUNDLE_HEADER_FIXED_LEN + bodyLen),
    signature: wire.slice(
      MESH_BUNDLE_HEADER_FIXED_LEN + bodyLen,
      MESH_BUNDLE_HEADER_FIXED_LEN + bodyLen + MESH_BUNDLE_SIG_LEN,
    ),
  };
}

/**
 * Returns the byte range that must be covered by the Ed25519 signature:
 * bytes[0 .. 61+bodyLen) -- everything from MAGIC up to and including the body.
 * Caller signs this range and verifies with sender_pubkey + signature field.
 *
 * Throws MESH_BUNDLE_TRUNCATED if the wire buffer is too short to safely slice.
 */
export function meshBundleSignedRange(wire: Uint8Array): Uint8Array {
  if (wire.length < MESH_BUNDLE_HEADER_FIXED_LEN + MESH_BUNDLE_SIG_LEN) {
    throw new WireCodecError('MESH_BUNDLE_TRUNCATED', 'wire too short to read body_len', {
      size: wire.length,
      min: MESH_BUNDLE_HEADER_FIXED_LEN + MESH_BUNDLE_SIG_LEN,
    });
  }
  const bodyLen = (wire[59]! << 8) | wire[60]!;
  if (bodyLen + MESH_BUNDLE_HEADER_FIXED_LEN > wire.length) {
    throw new WireCodecError('MESH_BUNDLE_TRUNCATED', 'wire too short for declared body_len', {
      bodyLen,
      required: bodyLen + MESH_BUNDLE_HEADER_FIXED_LEN,
      actual: wire.length,
    });
  }
  return wire.slice(0, MESH_BUNDLE_HEADER_FIXED_LEN + bodyLen);
}
