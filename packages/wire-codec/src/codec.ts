// wire-codec.ts — binary wire codec with JSON/CBOR/zstd auto-detection.
//
// Encoder paths (selected via opts):
//   {} (default)              → JSON (legacy default)
//   { cbor: true }            → bare CBOR
//   { cbor: true, zstd: true} → zstd-of-CBOR, prefixed with magic byte 0xC6
//   { cbor:true, zstd:true, dict:'zstd-dict-ru-v1' }
//                             → zstd-of-CBOR with shared dict, prefixed 0xC7 0x01
//                               (Phase 2.E.B; falls back to 0xC6 if dict not loaded)
//
// Decoder routes by first byte:
//   0x7B '{' or 0x5B '['      → JSON (legacy / bare arrays/objects)
//   0xC6                      → zstd-of-CBOR dictless (strip 1B, decompress, decode)
//   0xC7                      → zstd-of-CBOR with dict (strip 2B incl. dict-id)
//   else                      → bare CBOR
//
// Magic byte 0xC6 chosen because:
//   - It is an unassigned CBOR tag (major type 6, additional info 6).
//   - Top-level chat envelopes are maps, whose CBOR header is 0xA0–0xBB
//     (small map) or 0xB8/0xB9 (longer maps). Verified empirically on
//     representative envelopes — first byte falls in 0xA0–0xBB range.
//   - JSON top bytes are 0x7B / 0x5B. No collision.
//
// Async init: zstd-wasm requires `await ensureWireCodecReady()` once at app
// boot before encoding/decoding zstd payloads. Until ready, encode() with
// zstd:true throws; decode() of a zstd-prefixed payload throws.
//
// Shared dictionary registry lives in `wire-dicts.ts` (split out per FOLLOWUPS
// #12.5 once Phase 2.E.C/D added FA + EN dicts). DictName is orthogonal to
// WireCap — dict selection is a sub-option of the cbor+zstd cap, negotiated
// independently in negotiateDict.

// cbor-x/index-no-eval: same API as cbor-x but omits the `new Function('')`
// probe and compiled-decoder paths that trigger CSP script-src violations.
// See: https://github.com/kriszyp/cbor-x#no-eval-build
import { Encoder as CborEncoder, decode as cborDecode } from "cbor-x/index-no-eval";
import {
  init as zstdInit,
  compress as zstdCompress,
  decompress as zstdDecompress,
  createCCtx,
  createDCtx,
  compressUsingDict,
  decompressUsingDict,
} from "@bokuweb/zstd-wasm";
import {
  ALL_DICTS,
  DICT_ID_TO_NAME,
  DICT_NAME_TO_ID,
  getDictBytes,
  loadDict,
  type DictName,
} from "./dicts";
import { canEncodeAsV2, toV2, fromV2 } from "./envelope-v2";
import { WireCodecError } from "./errors.js";
import { asWireBytes, asHttpWireBytes } from "./brands";
import type { WireBytes, HttpWireBytes } from "./brands";

export type { DictName };

export type WireCap =
  | "json"
  | "cbor"
  | "cbor+zstd"
  | "zstd-dict-ru-v1"
  | "zstd-dict-fa-v1"
  | "zstd-dict-en-v1"
  | "envelope-v2";

/** All capabilities this build can encode AND decode.
 *  Note: dict caps are advertised statically (build-time). At encode time, if the
 *  dict isn't actually loaded (offline / fetch reject), the encoder silently emits
 *  0xC6 instead of 0xC7. Decoder side carries all dicts post-preload, so the
 *  worst case is "negotiation succeeds, sender downgrades, receiver decodes 0xC6
 *  fine" — no protocol break. */
export const ALL_CAPS: readonly WireCap[] = [
  "json",
  "cbor",
  "cbor+zstd",
  "zstd-dict-ru-v1",
  "zstd-dict-fa-v1",
  "zstd-dict-en-v1",
  "envelope-v2",
] as const;

export interface EncodeOpts {
  /** Emit CBOR instead of JSON. Default: false. */
  cbor?: boolean;
  /** Wrap CBOR with zstd compression. Requires cbor=true. Default: false. */
  zstd?: boolean;
  /** Use a shared zstd dict. Requires zstd=true. Falls back to 0xC6 if dict not loaded. */
  dict?: DictName;
  /** Phase 2.F.A: envelope wire-shape version. 2 → 0xC8 magic + compact id/ts/k.
   *  Requires zstd=true. Falls back to v1 (0xC6/0xC7) per-frame if value isn't
   *  v2-encodable (unknown kind, non-UUID id, ts outside uint32 window). Default: 1. */
  envelope?: 1 | 2;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sharedCborEncoder = new CborEncoder({
  mapsAsObjects: true,
  useRecords: false,
});

const JSON_OPEN_BRACE = 0x7b; // '{'
const JSON_OPEN_BRACKET = 0x5b; // '['
const ZSTD_MAGIC_PREFIX = 0xc6; // cbor + zstd (dictless), envelope-v1
const ZSTD_DICT_MAGIC_PREFIX = 0xc7; // cbor + zstd + shared-dict, envelope-v1 (Phase 2.E.B)
// Phase 2.F.A: envelope-v2. Magic byte + 1-byte dict-id (0x00 = dictless).
const ZSTD_V2_MAGIC_PREFIX = 0xc8;
// MESH_BUNDLE_MAGIC_V1 / MESH_BUNDLE_VERSION live in `./mesh-bundle.ts` and are
// re-exported from `./index.ts`. The duplicates here were dead.
const ZSTD_LEVEL = 3;

// Decompression-bomb hard caps. Threat model: post-AEAD malicious-but-authorized
// group peer crafts a small zstd frame whose decompressed size dwarfs the input.
//
// `@bokuweb/zstd-wasm` mallocs the destination buffer from the frame's declared
// Frame_Content_Size BEFORE the JS wrapper returns control (verified empirically
// in dist/esm/simple/decompress.js: `malloc(contentSize)` runs prior to any
// post-call length check). A 16-byte hostile frame can therefore declare 4 GB
// and crash the wasm allocator before any JS-side cap fires.
//
// Defenses, in order:
//   1. Reject oversized COMPRESSED input early — prevents the "valid 64 KB
//      frame that legitimately decompresses to 100×" amplification path.
//   2. Parse the zstd frame header per RFC 8878 §3.1.1 in pure JS BEFORE
//      handing bytes to the wasm lib; reject if Frame_Content_Size exceeds
//      ZSTD_MAX_DECOMPRESSED_BYTES OR if FCS is absent (we never produce
//      streaming frames legitimately, so missing FCS is a hostile-payload
//      tell). This closes the malloc-before-check hole.
//   3. Pass `defaultHeapSize: ZSTD_MAX_DECOMPRESSED_BYTES` to lib calls so
//      that even if a frame somehow lacks FCS and slips past (2), the wasm
//      heap is bounded.
//   4. Re-check decompressed length on output — catches the case where a
//      smaller-than-cap input decodes to something obviously bogus before
//      the bytes hit cborDecode.
//
// Real envelopes today: chat-msg / pay / typing <2 KB plain, <1 KB compressed.
// Caps sit ~30× above legitimate, well below any realistic wasm budget.
const ZSTD_MAX_COMPRESSED_BYTES = 64 * 1024;
const ZSTD_MAX_DECOMPRESSED_BYTES = 256 * 1024;
const ZSTD_DECOMPRESS_OPTS = { defaultHeapSize: ZSTD_MAX_DECOMPRESSED_BYTES };

// zstd frame magic, little-endian (RFC 8878 §3.1.1).
// 0x28 0xB5 0x2F 0xFD on the wire = 0xFD2FB528 LE.
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd] as const;

/**
 * Parse a zstd frame header (RFC 8878 §3.1.1) and reject hostile shapes.
 *
 * Validates:
 *   - Magic_Number == 0xFD2FB528.
 *   - Frame_Content_Size present (we never emit streaming frames).
 *   - Frame_Content_Size <= maxDecompressed.
 *
 * Skips Window_Descriptor (when Single_Segment=0) and Dictionary_ID bytes
 * to land on the FCS field. Throws on any layout we don't understand.
 *
 * The lib's `_malloc(declared FCS)` runs BEFORE the JS wrapper returns, so
 * this validator MUST be called before zstdDecompress / decompressUsingDict.
 */
function validateZstdFrame(bytes: Uint8Array, maxDecompressed: number): void {
  if (bytes.length < 6) {
    throw new WireCodecError(
      "ZSTD_DECODE_FAILED",
      "wire-codec.decode: zstd frame truncated (header < 6 bytes)",
    );
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== ZSTD_MAGIC_BYTES[i]) {
      throw new WireCodecError(
        "ZSTD_DECODE_FAILED",
        "wire-codec.decode: zstd magic mismatch",
      );
    }
  }
  const fhd = bytes[4]!;
  const fcsFlag = (fhd >> 6) & 0x03;          // bits 7-6
  const singleSegment = (fhd >> 5) & 0x01;    // bit 5
  // bits 4-3 reserved/unused, bit 2 content-checksum, bits 1-0 dict-id flag.
  const dictIdFlag = fhd & 0x03;

  let cursor = 5;
  // Window_Descriptor: 1 byte iff Single_Segment=0.
  if (singleSegment === 0) cursor += 1;
  // Dictionary_ID: 0/1/2/4 bytes per dictIdFlag.
  const dictIdBytes = dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4;
  cursor += dictIdBytes;

  // Frame_Content_Size: 0/1/2/4/8 bytes.
  // fcsFlag=0 + singleSegment=1 → 1 byte (FCS present).
  // fcsFlag=0 + singleSegment=0 → 0 bytes (FCS ABSENT — reject).
  // fcsFlag=1 → 2 bytes (read u16 LE then add 256 per spec).
  // fcsFlag=2 → 4 bytes.
  // fcsFlag=3 → 8 bytes.
  let fcsFieldSize: number;
  if (fcsFlag === 0) fcsFieldSize = singleSegment === 1 ? 1 : 0;
  else if (fcsFlag === 1) fcsFieldSize = 2;
  else if (fcsFlag === 2) fcsFieldSize = 4;
  else fcsFieldSize = 8;

  if (fcsFieldSize === 0) {
    throw new WireCodecError(
      "ZSTD_DECODE_FAILED",
      "wire-codec.decode: zstd frame omits Frame_Content_Size (streaming) — rejected",
    );
  }
  if (cursor + fcsFieldSize > bytes.length) {
    throw new WireCodecError(
      "ZSTD_DECODE_FAILED",
      "wire-codec.decode: zstd frame truncated before FCS",
    );
  }

  // Read FCS little-endian. Use BigInt for the 8-byte case; everything else
  // fits in a JS number (≤ 2^32-1).
  let fcs: number | bigint;
  if (fcsFieldSize === 1) {
    fcs = bytes[cursor]!;
  } else if (fcsFieldSize === 2) {
    fcs = (bytes[cursor]! | (bytes[cursor + 1]! << 8)) + 256; // RFC 8878: add 256
  } else if (fcsFieldSize === 4) {
    fcs =
      bytes[cursor]! |
      (bytes[cursor + 1]! << 8) |
      (bytes[cursor + 2]! << 16) |
      // shifting into bit-31 produces a negative i32; use unsigned multiply.
      bytes[cursor + 3]! * 0x01000000;
  } else {
    // 8 bytes: assemble LE BigInt.
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[cursor + i]!);
    fcs = v;
  }

  const maxBig = BigInt(maxDecompressed);
  const fcsBig = typeof fcs === "bigint" ? fcs : BigInt(fcs);
  if (fcsBig > maxBig) {
    throw new WireCodecError(
      "ZSTD_DECODE_FAILED",
      `wire-codec.decode: zstd Frame_Content_Size ${fcsBig.toString()} exceeds cap ${maxDecompressed}`,
      { limit: maxDecompressed, fcs: fcsBig.toString() },
    );
  }
}

// Module-singleton zstd contexts. zstd-wasm's compressUsingDict /
// decompressUsingDict / zstdCompress / zstdDecompress are SYNCHRONOUS calls —
// JS event-loop semantics guarantee no concurrent reentry into the same handle.
// If a future refactor introduces a streaming variant or `await` between handle
// creation and use, two interleaved {de,com}pressions WILL corrupt the context.
// Treat these handles as part of the readiness contract: created once in
// ensureWireCodecReady, used synchronously per-call, never freed.
let zstdReadyPromise: Promise<void> | null = null;
let zstdReady = false;
let cctxHandle: number | null = null;
let dctxHandle: number | null = null;

/**
 * Initialize zstd-wasm + eagerly preload all shipped shared dicts (≤16KB each).
 * Idempotent: safe to call multiple times. Must be awaited before encode/decode
 * of zstd payloads. Per-dict preload failures are non-fatal: encoder silently
 * falls back to 0xC6 dictless on cache-miss (see ALL_CAPS comment).
 */
export async function ensureWireCodecReady(): Promise<void> {
  if (zstdReady) return;
  if (!zstdReadyPromise) {
    zstdReadyPromise = zstdInit().then(async () => {
      cctxHandle = createCCtx();
      dctxHandle = createDCtx();
      // Eagerly preload shipped dicts so the first send doesn't pay fetch latency.
      // Failures are non-fatal: dict cap silently degrades to dictless.
      for (const name of ALL_DICTS) {
        try { await loadDict(name); } catch { /* fallback to dictless */ }
      }
      zstdReady = true;
    });
  }
  return zstdReadyPromise;
}

export function encode(value: unknown, opts: EncodeOpts = {}): WireBytes {
  if (opts.zstd && !opts.cbor) {
    throw new WireCodecError(
      "ENCODE_ZSTD_REQUIRES_CBOR",
      "wire-codec.encode: zstd requires cbor=true",
    );
  }
  if (opts.zstd) {
    if (!zstdReady) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.encode: zstd not initialized — await ensureWireCodecReady() first",
      );
    }
    // Phase 2.F.A: per-frame opportunistic v2 envelope. If the value can't fit
    // the v2 shape (unknown kind / bad id / ts out of window) we silently emit
    // v1 — byte-identical to pre-2.F.A output, no protocol break.
    const useV2 = opts.envelope === 2 && canEncodeAsV2(value);
    const cborSrc = useV2 ? toV2(value as Record<string, unknown>) : value;
    const cborBytes = sharedCborEncoder.encode(cborSrc);
    if (useV2) {
      // 0xC8 + dict-id byte (0x00 = dictless). All C1 caps still apply via decode.
      let compressed: Uint8Array;
      let dictId = 0x00;
      if (opts.dict !== undefined) {
        const dictBytes = getDictBytes(opts.dict);
        const id = DICT_NAME_TO_ID[opts.dict];
        if (dictBytes !== undefined && id !== undefined && cctxHandle !== null) {
          compressed = compressUsingDict(cctxHandle, cborBytes, dictBytes, ZSTD_LEVEL);
          dictId = id;
        } else {
          compressed = zstdCompress(cborBytes, ZSTD_LEVEL);
        }
      } else {
        compressed = zstdCompress(cborBytes, ZSTD_LEVEL);
      }
      const out = new Uint8Array(2 + compressed.length);
      out[0] = ZSTD_V2_MAGIC_PREFIX;
      out[1] = dictId;
      out.set(compressed, 2);
      return asWireBytes(out);
    }
    // Dict path (0xC7 + dict-id): used only when dict is in cache. On miss we
    // silently fall back to 0xC6 — keeps the encoder sync and tolerant of
    // preload failures (offline, fetch reject, etc.).
    if (opts.dict !== undefined) {
      const dictBytes = getDictBytes(opts.dict);
      const dictId = DICT_NAME_TO_ID[opts.dict];
      if (dictBytes !== undefined && dictId !== undefined && cctxHandle !== null) {
        const compressed = compressUsingDict(cctxHandle, cborBytes, dictBytes, ZSTD_LEVEL);
        const out = new Uint8Array(2 + compressed.length);
        out[0] = ZSTD_DICT_MAGIC_PREFIX;
        out[1] = dictId;
        out.set(compressed, 2);
        return asWireBytes(out);
      }
      // Fall through to dictless path.
    }
    const compressed = zstdCompress(cborBytes, ZSTD_LEVEL);
    const out = new Uint8Array(1 + compressed.length);
    out[0] = ZSTD_MAGIC_PREFIX;
    out.set(compressed, 1);
    return asWireBytes(out);
  }
  if (opts.cbor) {
    return asWireBytes(sharedCborEncoder.encode(value) as Uint8Array);
  }
  return asWireBytes(enc.encode(JSON.stringify(value)));
}

export function decode(bytes: WireBytes): unknown {
  if (bytes.length === 0) {
    throw new WireCodecError("EMPTY_INPUT", "wire-codec.decode: empty input");
  }
  const first = bytes[0];
  if (first === JSON_OPEN_BRACE || first === JSON_OPEN_BRACKET) {
    return JSON.parse(dec.decode(bytes));
  }
  if (first === ZSTD_MAGIC_PREFIX) {
    if (!zstdReady) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.decode: zstd payload received before ensureWireCodecReady()",
      );
    }
    if (bytes.length - 1 > ZSTD_MAX_COMPRESSED_BYTES) {
      throw new WireCodecError(
        "COMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd payload exceeds compressed-size cap",
        { limit: ZSTD_MAX_COMPRESSED_BYTES, size: bytes.length - 1 },
      );
    }
    const compressed = bytes.subarray(1);
    validateZstdFrame(compressed, ZSTD_MAX_DECOMPRESSED_BYTES);
    const cborBytes = zstdDecompress(compressed, ZSTD_DECOMPRESS_OPTS);
    if (cborBytes.length > ZSTD_MAX_DECOMPRESSED_BYTES) {
      throw new WireCodecError(
        "DECOMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd payload exceeds decompressed-size cap",
        { limit: ZSTD_MAX_DECOMPRESSED_BYTES, size: cborBytes.length },
      );
    }
    return cborDecode(cborBytes);
  }
  if (first === ZSTD_V2_MAGIC_PREFIX) {
    if (!zstdReady) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.decode: zstd-v2 payload received before ensureWireCodecReady()",
      );
    }
    if (bytes.length < 2) {
      throw new WireCodecError(
        "ZSTD_DECODE_FAILED",
        "wire-codec.decode: truncated zstd-v2 frame",
      );
    }
    if (bytes.length - 2 > ZSTD_MAX_COMPRESSED_BYTES) {
      throw new WireCodecError(
        "COMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd-v2 payload exceeds compressed-size cap",
        { limit: ZSTD_MAX_COMPRESSED_BYTES, size: bytes.length - 2 },
      );
    }
    const dictId = bytes[1]!;
    const compressed = bytes.subarray(2);
    validateZstdFrame(compressed, ZSTD_MAX_DECOMPRESSED_BYTES);
    let cborBytes: Uint8Array;
    if (dictId === 0x00) {
      cborBytes = zstdDecompress(compressed, ZSTD_DECOMPRESS_OPTS);
    } else {
      const dictName = DICT_ID_TO_NAME[dictId];
      if (dictName === undefined) {
        throw new WireCodecError(
          "UNKNOWN_DICT_ID",
          `wire-codec.decode: unknown zstd dict-id 0x${dictId.toString(16)}`,
          { dictId },
        );
      }
      const dictBytes = getDictBytes(dictName);
      if (dictBytes === undefined) {
        throw new WireCodecError(
          "DICT_NOT_LOADED",
          `wire-codec.decode: dict ${dictName} not loaded — protocol error (negotiation should have prevented this)`,
        );
      }
      if (dctxHandle === null) {
        throw new WireCodecError(
          "ZSTD_NOT_INITIALIZED",
          "wire-codec.decode: zstd-v2 dict path not initialized",
        );
      }
      cborBytes = decompressUsingDict(dctxHandle, compressed, dictBytes, ZSTD_DECOMPRESS_OPTS);
    }
    if (cborBytes.length > ZSTD_MAX_DECOMPRESSED_BYTES) {
      throw new WireCodecError(
        "DECOMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd-v2 payload exceeds decompressed-size cap",
        { limit: ZSTD_MAX_DECOMPRESSED_BYTES, size: cborBytes.length },
      );
    }
    return fromV2(cborDecode(cborBytes) as Record<string, unknown>);
  }
  if (first === ZSTD_DICT_MAGIC_PREFIX) {
    if (!zstdReady || dctxHandle === null) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.decode: zstd-dict payload received before ensureWireCodecReady()",
      );
    }
    if (bytes.length < 2) {
      throw new WireCodecError(
        "INVALID_DICT_ID_HEADER",
        "wire-codec.decode: truncated zstd-dict frame",
        { frameLen: bytes.length },
      );
    }
    if (bytes.length - 2 > ZSTD_MAX_COMPRESSED_BYTES) {
      throw new WireCodecError(
        "COMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd-dict payload exceeds compressed-size cap",
        { limit: ZSTD_MAX_COMPRESSED_BYTES, size: bytes.length - 2 },
      );
    }
    const dictId = bytes[1]!;
    const dictName = DICT_ID_TO_NAME[dictId];
    if (dictName === undefined) {
      throw new WireCodecError(
        "UNKNOWN_DICT_ID",
        `wire-codec.decode: unknown zstd dict-id 0x${dictId.toString(16)}`,
        { dictId },
      );
    }
    const dictBytes = getDictBytes(dictName);
    if (dictBytes === undefined) {
      throw new WireCodecError(
        "DICT_NOT_LOADED",
        `wire-codec.decode: dict ${dictName} not loaded — protocol error (negotiation should have prevented this)`,
      );
    }
    const compressed = bytes.subarray(2);
    validateZstdFrame(compressed, ZSTD_MAX_DECOMPRESSED_BYTES);
    const cborBytes = decompressUsingDict(dctxHandle, compressed, dictBytes, ZSTD_DECOMPRESS_OPTS);
    if (cborBytes.length > ZSTD_MAX_DECOMPRESSED_BYTES) {
      throw new WireCodecError(
        "DECOMPRESSED_TOO_LARGE",
        "wire-codec.decode: zstd-dict payload exceeds decompressed-size cap",
        { limit: ZSTD_MAX_DECOMPRESSED_BYTES, size: cborBytes.length },
      );
    }
    return cborDecode(cborBytes);
  }
  return cborDecode(bytes);
}

/**
 * FOLLOWUPS A9 — recursively sort object keys so two equivalent envelopes
 * built via different code paths produce byte-identical CBOR.
 *
 * `cbor-x` emits keys in JS insertion order (no RFC 8949 §4.2.1 deterministic
 * mode flag exposed). When a caller needs hash-stable bytes (dedup keys,
 * idempotency tokens, signed-fingerprint AAD), pre-canonicalize the value
 * before `encode(value, opts)`.
 *
 * Arrays preserve order (semantic). Maps not supported — use plain objects.
 * Uint8Array / TypedArray pass through unchanged (CBOR encodes by content).
 */
export function canonicalizeEnvelope<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => canonicalizeEnvelope(x)) as unknown as T;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = canonicalizeEnvelope(src[k]);
  return out as unknown as T;
}

/** Sniff helper: returns true if bytes look like CBOR (not JSON). */
export function isCborMagic(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const first = bytes[0];
  return first !== JSON_OPEN_BRACE && first !== JSON_OPEN_BRACKET;
}

/**
 * Pick the highest mutually-supported codec from two cap lists.
 * Preference order: cbor+zstd > cbor > json. Falls back to 'json'.
 * NOTE: dict caps (zstd-dict-*) and envelope caps (envelope-v2) are
 * sub-options of cbor+zstd, negotiated separately via negotiateDict and
 * negotiateEnvelopeVersion. They do NOT appear in this priority list.
 */
export function negotiateCap(
  mine: readonly WireCap[],
  theirs: readonly WireCap[],
): WireCap {
  const priority: WireCap[] = ["cbor+zstd", "cbor", "json"];
  for (const cap of priority) {
    if (mine.includes(cap) && theirs.includes(cap)) return cap;
  }
  return "json";
}

/**
 * Phase 2.E.B: pick the strongest shared zstd dict supported by all peers.
 * `othersCaps` is one cap-list per peer; the result is the dict that appears
 * in EVERY list (mine + every peer). Returns undefined if no dict is universal.
 *
 * Group-chat semantic: the wire is broadcast (single AEAD frame to all peers),
 * so the dict choice is room-wide intersection — never per-peer split sends.
 * Recompute on every peer-join / leave / identity update.
 *
 * With Phase 2.E.C/D shipping FA + EN dicts to every client, intersection is
 * deterministic — the result depends only on the priority order. Per-message
 * language detection is out of scope (Phase 2.E.E follow-up).
 */
export function negotiateDict(
  mine: readonly WireCap[],
  othersCaps: readonly (readonly WireCap[])[],
  priority: readonly DictName[] = ALL_DICTS,
): DictName | undefined {
  for (const dict of priority) {
    if (!mine.includes(dict)) continue;
    if (othersCaps.every((peer) => peer.includes(dict))) return dict;
  }
  return undefined;
}

/** Convert a negotiated codec-cap to encode opts. Dict + envelope caps are NOT
 *  codec caps — they piggyback on cbor+zstd and are layered in separately. */
export function capToOpts(cap: WireCap): EncodeOpts {
  switch (cap) {
    case "json":
      return { cbor: false, zstd: false };
    case "cbor":
      return { cbor: true, zstd: false };
    case "cbor+zstd":
    case "zstd-dict-ru-v1":
    case "zstd-dict-fa-v1":
    case "zstd-dict-en-v1":
    case "envelope-v2":
      // Dict + envelope caps imply cbor+zstd; selection layered via opts.dict / opts.envelope.
      return { cbor: true, zstd: true };
  }
}

/**
 * Phase 2.F.A: pick envelope version. Returns 2 only if WE support it AND every
 * peer in the room advertises 'envelope-v2'. Solo room → 1 (defensive: same
 * shape as negotiateDict's solo-pin in useBurnerChat). Mirrors negotiateDict
 * shape so the caller wires both with the same triggers.
 */
/**
 * Encode a payload as wire-codec bytes for POST /api/sdk/messages (server protocol).
 *
 * Unlike `encode()` (which produces zstd-of-CBOR for peer-to-peer), this function
 * produces zstd-of-JSON to match the server decoder in crates/sdk/src/wire_decode.rs.
 *
 * Frame formats (server protocol):
 *   dictless:  [0xC6, ...zstd(utf8(json))]
 *   with-dict: [0xC7, dictId >> 8, dictId & 0xFF, ...zstdWithDict(utf8(json), dictBytes)]
 *              where dictId is u16 BE (matches Rust u16::from_be_bytes([bytes[1], bytes[2]]))
 *              Values: 0x0001=ru, 0x0002=fa, 0x0003=en
 *
 * @param jsonBytes  Pre-serialized UTF-8 JSON (use `new TextEncoder().encode(JSON.stringify(v))`).
 * @param dictName   Optional: use shared dict. Falls back to dictless if dict not loaded.
 * @returns Uint8Array with magic-byte prefix, ready to send as application/octet-stream.
 * @throws if zstd not initialized — call `ensureWireCodecReady()` first.
 */
export function encodeHttpBody(jsonBytes: Uint8Array, dictName?: DictName): HttpWireBytes {
  if (!zstdReady) {
    throw new WireCodecError(
      "ZSTD_NOT_INITIALIZED",
      "wire-codec.encodeHttpBody: zstd not initialized — await ensureWireCodecReady() first",
    );
  }
  if (dictName !== undefined) {
    const dictBytes = getDictBytes(dictName);
    const dictId = DICT_NAME_TO_ID[dictName];
    if (dictBytes !== undefined && dictId !== undefined && cctxHandle !== null) {
      const compressed = compressUsingDict(cctxHandle, jsonBytes, dictBytes, ZSTD_LEVEL);
      // Server protocol: 0xC7 + dict_id u16 BE (high=0x00 since IDs are 0x01–0x03) + frame
      const out = new Uint8Array(3 + compressed.length);
      out[0] = ZSTD_DICT_MAGIC_PREFIX;
      out[1] = (dictId >> 8) & 0xff; // high byte (0x00 for current IDs)
      out[2] = dictId & 0xff;         // low byte (0x01–0x03)
      out.set(compressed, 3);
      return asHttpWireBytes(out);
    }
    // Dict not loaded — fall through to dictless.
  }
  const compressed = zstdCompress(jsonBytes, ZSTD_LEVEL);
  const out = new Uint8Array(1 + compressed.length);
  out[0] = ZSTD_MAGIC_PREFIX;
  out.set(compressed, 1);
  return asHttpWireBytes(out);
}


/**
 * Decode server-protocol wire bytes back to a JSON payload (inverse of encodeHttpBody).
 *
 * This mirrors the server decoder (crates/sdk/src/wire_decode.rs decode_wire_body).
 * Useful for testing round-trips and for any future server→client compressed response path.
 *
 * Frame formats (server protocol):
 *   0x7B / 0x5B  → plain JSON (as-is)
 *   0xC6         → zstd dictless; decompress bytes[1..], then JSON.parse
 *   0xC7         → zstd+dict; dict_id = u16 BE from bytes[1..3]; decompress bytes[3..]
 *   string       → JSON.parse directly
 *
 * For 0xC8 peer envelope-v2, use decode() instead.
 *
 * @throws if zstd not initialized or dict not loaded.
 */
export function decodeHttpBody(bytes: HttpWireBytes | string): unknown {
  if (typeof bytes === 'string') {
    return JSON.parse(bytes) as unknown;
  }
  if (bytes.length === 0) {
    throw new WireCodecError("EMPTY_INPUT", "wire-codec.decodeHttpBody: empty input");
  }
  const first = bytes[0]!;  // length > 0 guard above
  if (first === JSON_OPEN_BRACE || first === JSON_OPEN_BRACKET) {
    return JSON.parse(dec.decode(bytes)) as unknown;
  }
  if (first === ZSTD_MAGIC_PREFIX) {
    if (!zstdReady) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.decodeHttpBody: zstd not initialized",
      );
    }
    if (bytes.length - 1 > ZSTD_MAX_COMPRESSED_BYTES) {
      throw new WireCodecError(
        "COMPRESSED_TOO_LARGE",
        "wire-codec.decodeHttpBody: payload exceeds compressed-size cap",
        { limit: ZSTD_MAX_COMPRESSED_BYTES, size: bytes.length - 1 },
      );
    }
    const compressed = bytes.subarray(1);
    validateZstdFrame(compressed, ZSTD_MAX_DECOMPRESSED_BYTES);
    const jsonBytes = zstdDecompress(compressed, ZSTD_DECOMPRESS_OPTS);
    return JSON.parse(dec.decode(jsonBytes)) as unknown;
  }
  if (first === ZSTD_DICT_MAGIC_PREFIX) {
    if (!zstdReady || dctxHandle === null) {
      throw new WireCodecError(
        "ZSTD_NOT_INITIALIZED",
        "wire-codec.decodeHttpBody: zstd not initialized",
      );
    }
    if (bytes.length < 3) {
      throw new WireCodecError(
        "INVALID_DICT_ID_HEADER",
        "wire-codec.decodeHttpBody: truncated dict frame (need 3 header bytes)",
        { frameLen: bytes.length },
      );
    }
    if (bytes.length - 3 > ZSTD_MAX_COMPRESSED_BYTES) {
      throw new WireCodecError(
        "COMPRESSED_TOO_LARGE",
        "wire-codec.decodeHttpBody: payload exceeds compressed-size cap",
        { limit: ZSTD_MAX_COMPRESSED_BYTES, size: bytes.length - 3 },
      );
    }
    // Server protocol: dict_id is u16 BE at bytes[1..3], frame at bytes[3..].
    const dictId = (bytes[1]! << 8) | bytes[2]!;
    const dictName = DICT_ID_TO_NAME[dictId];
    if (dictName === undefined) {
      throw new WireCodecError(
        "UNKNOWN_DICT_ID",
        `wire-codec.decodeHttpBody: unknown dict-id 0x${dictId.toString(16)}`,
        { dictId },
      );
    }
    const dictBytes = getDictBytes(dictName);
    if (dictBytes === undefined) {
      throw new WireCodecError(
        "DICT_NOT_LOADED",
        `wire-codec.decodeHttpBody: dict ${dictName} not loaded`,
      );
    }
    const compressed = bytes.subarray(3);
    validateZstdFrame(compressed, ZSTD_MAX_DECOMPRESSED_BYTES);
    const jsonBytes = decompressUsingDict(dctxHandle, compressed, dictBytes, ZSTD_DECOMPRESS_OPTS);
    return JSON.parse(dec.decode(jsonBytes)) as unknown;
  }
  if (first === ZSTD_V2_MAGIC_PREFIX) {
    throw new WireCodecError(
      "PEER_ENVELOPE_FORMAT",
      "wire-codec.decodeHttpBody: 0xC8 is the peer envelope-v2 format; use decode() instead.",
    );
  }
  throw new WireCodecError(
    "UNKNOWN_MAGIC",
    `wire-codec.decodeHttpBody: unknown magic byte 0x${first.toString(16)}`,
  );
}


export function negotiateEnvelopeVersion(
  mine: readonly WireCap[],
  othersCaps: readonly (readonly WireCap[])[],
): 1 | 2 {
  if (!mine.includes("envelope-v2")) return 1;
  if (othersCaps.length === 0) return 1;
  for (const peer of othersCaps) {
    if (!peer.includes("envelope-v2" as WireCap)) return 1;
  }
  return 2;
}
