import { describe, it, expect } from 'vitest';
import {
  encodeMeshBundle,
  decodeMeshBundle,
  meshBundleSignedRange,
  MESH_BUNDLE_MAGIC_V1,
  MESH_BUNDLE_VERSION,
  MESH_BUNDLE_HEADER_FIXED_LEN,
  MESH_BUNDLE_SIG_LEN,
} from '../mesh-bundle.ts';
import { WireCodecError } from '../errors.ts';

const PUBKEY = new Uint8Array(32).fill(0xaa);
const MSG_ID = new Uint8Array(16).fill(0xbb);
const SIG = new Uint8Array(64).fill(0xcc);
const CHANNEL_HASH = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
const TS_OFFSET = 1_234_567; // seconds since ROOM_EPOCH

// ---------------------------------------------------------------------------
// encodeMeshBundle — happy path
// ---------------------------------------------------------------------------
describe('encodeMeshBundle', () => {
  it('produces a bundle with correct magic + version + header layout', () => {
    const body = new Uint8Array([0xc6, 0x00, 0x01, 0x02]);
    const bundle = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: TS_OFFSET,
      ttlHops: 7,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    // Frame fixed overhead = 125 B (header 61 + sig 64)
    expect(bundle[0]).toBe(MESH_BUNDLE_MAGIC_V1);
    expect(bundle[1]).toBe(MESH_BUNDLE_VERSION);
    expect(bundle.length).toBe(MESH_BUNDLE_HEADER_FIXED_LEN + body.length + MESH_BUNDLE_SIG_LEN);
    // sender_pubkey starts at offset 2
    expect(Array.from(bundle.slice(2, 34))).toEqual(Array.from(PUBKEY));
    // msg_id at offset 34
    expect(Array.from(bundle.slice(34, 50))).toEqual(Array.from(MSG_ID));
    // signature at the tail
    expect(Array.from(bundle.slice(bundle.length - 64))).toEqual(Array.from(SIG));
  });

  it('round-trips boundary tsSecOffset=0 and ttlHops=0', () => {
    const body = new Uint8Array([0x01]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: 0,
      ttlHops: 0,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    const decoded = decodeMeshBundle(wire);
    expect(decoded.tsSecOffset).toBe(0);
    expect(decoded.ttlHops).toBe(0);
  });

  it('round-trips boundary tsSecOffset=1 (first second)', () => {
    const body = new Uint8Array([0x01]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: 1,
      ttlHops: 1,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    const decoded = decodeMeshBundle(wire);
    expect(decoded.tsSecOffset).toBe(1);
  });

  it('round-trips boundary tsSecOffset=3_153_600_000 (100 years)', () => {
    // 100 years * 365.25 days/yr * 86400 s/day = 3_155_760_000 s
    // Use 3_153_600_000 (100 years * 365 days * 86400 s) to stay within u32::MAX
    const hundredYearsInSeconds = 3_153_600_000;
    const body = new Uint8Array([0x01]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: hundredYearsInSeconds,
      ttlHops: 7,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    const decoded = decodeMeshBundle(wire);
    expect(decoded.tsSecOffset).toBe(hundredYearsInSeconds);
  });

  it('round-trips boundary tsSecOffset=0xFFFFFFFF (u32::MAX seconds = ~136 years) and ttlHops=255', () => {
    const body = new Uint8Array([0x01]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: 0xffffffff,
      ttlHops: 255,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    const decoded = decodeMeshBundle(wire);
    expect(decoded.tsSecOffset).toBe(0xffffffff);
    expect(decoded.ttlHops).toBe(255);
  });

  // -------------------------------------------------------------------------
  // BLOCKER #1 — tsSecOffset validation (MESH_BUNDLE_FIELD_INVALID)
  // -------------------------------------------------------------------------
  it('rejects tsSecOffset that is a float (0.5)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: 0.5, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects tsSecOffset that is negative (-1)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: -1, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects tsSecOffset > 0xFFFFFFFF (4294967296)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: 4294967296, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects tsSecOffset NaN', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: NaN, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects tsSecOffset Infinity', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: Infinity, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects ttlHops > 255 (256)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 256,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects ttlHops < 0 (-1)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: -1,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects ttlHops that is a float (1.5)', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 1.5,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  // -------------------------------------------------------------------------
  // MAJOR #5 — non-sig fixed-array fields use MESH_BUNDLE_FIELD_INVALID
  // -------------------------------------------------------------------------
  it('rejects senderPubkey with wrong length using MESH_BUNDLE_FIELD_INVALID', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: new Uint8Array(31), msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects msgId with wrong length using MESH_BUNDLE_FIELD_INVALID', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: new Uint8Array(15), tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('rejects channelIdHash with wrong length using MESH_BUNDLE_FIELD_INVALID', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: new Uint8Array(3), body: new Uint8Array([0x01]), signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_FIELD_INVALID' }));
  });

  it('signature wrong length still uses MESH_BUNDLE_SIG_INVALID', () => {
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body: new Uint8Array([0x01]), signature: new Uint8Array(63),
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_SIG_INVALID' }));
  });

  it('rejects body exceeding 1500 B cap with MESH_BUNDLE_TOO_LARGE', () => {
    const body = new Uint8Array(1501);
    expect(() => encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body, signature: SIG,
    })).toThrow(expect.objectContaining({ code: 'MESH_BUNDLE_TOO_LARGE' }));
  });
});

// ---------------------------------------------------------------------------
// decodeMeshBundle
// ---------------------------------------------------------------------------
describe('decodeMeshBundle', () => {
  it('round-trips a valid bundle', () => {
    const body = new Uint8Array([0xc6, 0x00, 0x01, 0x02]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY,
      msgId: MSG_ID,
      tsSecOffset: TS_OFFSET,
      ttlHops: 7,
      channelIdHash: CHANNEL_HASH,
      body,
      signature: SIG,
    });
    const decoded = decodeMeshBundle(wire);
    expect(decoded.senderPubkey).toEqual(PUBKEY);
    expect(decoded.msgId).toEqual(MSG_ID);
    expect(decoded.tsSecOffset).toBe(TS_OFFSET);
    expect(decoded.ttlHops).toBe(7);
    expect(decoded.body).toEqual(body);
    expect(decoded.signature).toEqual(SIG);
  });

  // -------------------------------------------------------------------------
  // MINOR #7 — min is 125 B (61 header + 0 body + 64 sig), not 189 B
  // -------------------------------------------------------------------------
  it('rejects bundle smaller than 125 B minimum (61 header + 0 body + 64 sig)', () => {
    const tooShort = new Uint8Array(100);
    tooShort[0] = MESH_BUNDLE_MAGIC_V1;
    expect(() => decodeMeshBundle(tooShort)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_TRUNCATED' }),
    );
  });

  it('rejects wrong magic byte', () => {
    const wrongMagic = new Uint8Array(200);
    wrongMagic[0] = 0xcc; // not 0xC9
    expect(() => decodeMeshBundle(wrongMagic)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_MAGIC' }),
    );
  });

  // -------------------------------------------------------------------------
  // MINOR #8 — version mismatch → MESH_BUNDLE_VERSION_UNSUPPORTED not UNKNOWN_MAGIC
  // -------------------------------------------------------------------------
  it('rejects wrong version byte with MESH_BUNDLE_VERSION_UNSUPPORTED', () => {
    // Build a bundle with correct magic but wrong version
    const body = new Uint8Array([0x01]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body, signature: SIG,
    });
    wire[1] = 0x02; // tamper version
    expect(() => decodeMeshBundle(wire)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_VERSION_UNSUPPORTED' }),
    );
  });

  // -------------------------------------------------------------------------
  // MAJOR #2 — body_len > MAX_BODY cap path (separate test for cap violation)
  // -------------------------------------------------------------------------
  it('rejects body_len that exceeds cap (9999 > 1500) with MESH_BUNDLE_TOO_LARGE', () => {
    const bundle = new Uint8Array(200);
    bundle[0] = MESH_BUNDLE_MAGIC_V1;
    bundle[1] = MESH_BUNDLE_VERSION;
    // body_len = 9999 at offsets 59-60 big-endian
    bundle[59] = 0x27;
    bundle[60] = 0x0f;
    expect(() => decodeMeshBundle(bundle)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_TOO_LARGE' }),
    );
  });

  // -------------------------------------------------------------------------
  // MAJOR #2 — body_len ≤ MAX_BODY but declared length mismatches wire length
  // body_len=200 encoded, but wire is only 189 B (< 325 B that 200-byte body requires)
  // -------------------------------------------------------------------------
  it('rejects bundle where body_len ≤ cap but total wire length mismatches with MESH_BUNDLE_TRUNCATED', () => {
    // body_len=200: expectedTotal = 61+200+64 = 325 B, but wire is only 189 B
    const bundle = new Uint8Array(189);
    bundle[0] = MESH_BUNDLE_MAGIC_V1;
    bundle[1] = MESH_BUNDLE_VERSION;
    // body_len = 200 = 0x00C8
    bundle[59] = 0x00;
    bundle[60] = 0xc8;
    expect(() => decodeMeshBundle(bundle)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_TRUNCATED' }),
    );
  });

  // -------------------------------------------------------------------------
  // MAJOR #4 — meshBundleSignedRange without bounds check is unsafe; but
  // decodeMeshBundle validates first, so test signedRange on a valid bundle
  // and separately on a truncated wire that bypasses decode.
  // -------------------------------------------------------------------------
  it('meshBundleSignedRange throws MESH_BUNDLE_TRUNCATED on too-short wire', () => {
    const tooShort = new Uint8Array(60); // shorter than HEADER_FIXED_LEN+SIG_LEN
    expect(() => meshBundleSignedRange(tooShort)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_TRUNCATED' }),
    );
  });

  it('meshBundleSignedRange throws MESH_BUNDLE_TRUNCATED when bodyLen+61 > wire.length', () => {
    // wire passes min-length check (≥125) but body_len declared is 100,
    // so bodyLen+61 = 161 > wire.length = 130
    const wire = new Uint8Array(130);
    wire[0] = MESH_BUNDLE_MAGIC_V1;
    wire[1] = MESH_BUNDLE_VERSION;
    wire[59] = 0x00;
    wire[60] = 100; // body_len=100 → need 61+100=161 bytes for signed range
    expect(() => meshBundleSignedRange(wire)).toThrow(
      expect.objectContaining({ code: 'MESH_BUNDLE_TRUNCATED' }),
    );
  });

  it('meshBundleSignedRange returns correct slice on valid wire', () => {
    const body = new Uint8Array([0xc6, 0x00]);
    const wire = encodeMeshBundle({
      senderPubkey: PUBKEY, msgId: MSG_ID, tsSecOffset: TS_OFFSET, ttlHops: 7,
      channelIdHash: CHANNEL_HASH, body, signature: SIG,
    });
    const signed = meshBundleSignedRange(wire);
    expect(signed.length).toBe(MESH_BUNDLE_HEADER_FIXED_LEN + body.length);
    expect(signed[0]).toBe(MESH_BUNDLE_MAGIC_V1);
  });
});
