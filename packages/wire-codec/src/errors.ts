/**
 * Typed discriminated-union error for the wire-codec package.
 *
 * All throws in codec.ts and dicts.ts use this class instead of plain Error,
 * so callers can switch on `code` rather than matching message strings.
 *
 * Code registry (stable — used on catch sites and in tests):
 *
 *   EMPTY_INPUT              — decode/decodeHttpBody received a zero-length buffer.
 *   UNKNOWN_MAGIC            — first byte is not a recognized codec marker.
 *   PEER_ENVELOPE_FORMAT     — 0xC8 (peer envelope-v2) passed to decodeHttpBody;
 *                              caller should use decode() instead.
 *   INVALID_DICT_ID_HEADER   — 0xC7 frame is too short to contain the dict-id
 *                              header bytes (need ≥ 3 bytes for server protocol
 *                              or ≥ 2 bytes for peer protocol).
 *   UNKNOWN_DICT_ID          — dict-id byte/word has no registered entry.
 *   DICT_NOT_LOADED          — dict is registered but has not been fetched yet.
 *   ZSTD_NOT_INITIALIZED     — a zstd operation was attempted before
 *                              ensureWireCodecReady() resolved.
 *   ZSTD_DECODE_FAILED       — zstd frame is malformed (bad magic, truncated,
 *                              missing FCS, FCS exceeds cap, or wasm error).
 *   COMPRESSED_TOO_LARGE     — compressed input exceeds the hard cap before
 *                              decompression (distinct from DECOMPRESSED_TOO_LARGE).
 *   DECOMPRESSED_TOO_LARGE   — decompressed output exceeds the hard cap.
 *   LOADER_SWAPPED_MID_FETCH — setDictLoader() was called while a loadDict()
 *                              fetch was in flight; the stale result is discarded.
 *   ENCODE_ZSTD_REQUIRES_CBOR — encode() called with zstd:true but cbor:false.
 *   DICT_FETCH_FAILED        — fetch() for a named dict returned a non-2xx status.
 *                              Distinct from DICT_NOT_LOADED (never fetched) and
 *                              LOADER_SWAPPED_MID_FETCH (discarded stale result).
 *   MESH_BUNDLE_FIELD_INVALID — encode-side field failed validation: tsSecOffset must be
 *                              a safe integer in [0, 0xFFFFFFFF]; ttlHops in [0, 255];
 *                              fixed-array fields (pubkey/msgId/channelIdHash) have
 *                              wrong byte length. details.field names the bad field.
 *   MESH_BUNDLE_TRUNCATED    — decoded bundle is shorter than its declared body_len
 *                              implies (distinct from cap violation).
 *   MESH_BUNDLE_VERSION_UNSUPPORTED — version byte is not 0x01.
 */
export type WireCodecErrorCode =
  | "EMPTY_INPUT"
  | "UNKNOWN_MAGIC"
  | "UNKNOWN_DICT_ID"
  | "DICT_NOT_LOADED"
  | "ZSTD_DECODE_FAILED"
  | "DECOMPRESSED_TOO_LARGE"
  | "INVALID_DICT_ID_HEADER"
  | "LOADER_SWAPPED_MID_FETCH"
  | "PEER_ENVELOPE_FORMAT"
  | "ZSTD_NOT_INITIALIZED"
  | "COMPRESSED_TOO_LARGE"
  | "ENCODE_ZSTD_REQUIRES_CBOR"
  | "DICT_FETCH_FAILED"
  | "MESH_BUNDLE_SIG_INVALID"
  | "MESH_BUNDLE_STALE"
  | "MESH_BUNDLE_TOO_LARGE"
  | "MESH_BUNDLE_TRUNCATED"
  | "MESH_BUNDLE_FIELD_INVALID"
  | "MESH_BUNDLE_VERSION_UNSUPPORTED";

/**
 * Allowed value types in WireCodecError details.
 * Restricted to primitives — no binary buffers (Uint8Array, ArrayBuffer, etc.)
 * may appear in error details, as details may be logged or serialized.
 */
export type WireCodecErrorDetail = string | number | boolean;

export interface WireCodecErrorDetails {
  readonly [key: string]: WireCodecErrorDetail;
}

export class WireCodecError extends Error {
  readonly code: WireCodecErrorCode;
  readonly details?: Readonly<WireCodecErrorDetails>;

  constructor(
    code: WireCodecErrorCode,
    message: string,
    details?: WireCodecErrorDetails,
  ) {
    super(message);
    this.name = "WireCodecError";
    this.code = code;
    this.details = details !== undefined ? Object.freeze({ ...details }) : undefined;
  }
}
