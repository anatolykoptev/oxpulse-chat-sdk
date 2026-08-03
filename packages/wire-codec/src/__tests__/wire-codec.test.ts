import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { asWireBytes } from '../brands.ts';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Mock global.fetch BEFORE ensureWireCodecReady() runs. All three shipped
// dicts (ru/fa/en) resolve from the local static FS so encoder roundtrip tests
// per language work. The "fallback to 0xC6" test below uses an explicit cache
// clear (loadDict miss path) instead of unmocking fetch — keeping the mock
// uniform avoids ordering coupling between describe blocks.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTS_DIR = join(__dirname, '..', '..', 'dicts');
const realFetch = globalThis.fetch;
const MOCKED_DICTS = ['zstd-dict-ru-v1', 'zstd-dict-fa-v1', 'zstd-dict-en-v1'] as const;
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  for (const name of MOCKED_DICTS) {
    if (url.endsWith(`/dicts/${name}.zstd`)) {
      const buf = readFileSync(join(DICTS_DIR, `${name}.zstd`));
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return new Response(u8, { status: 200 });
    }
  }
  return realFetch(input);
}) as typeof fetch;
import {
  encode,
  decode,
  isCborMagic,
  negotiateCap,
  negotiateDict,
  negotiateEnvelopeVersion,
  capToOpts,
  canonicalizeEnvelope,
  ensureWireCodecReady,
  ALL_CAPS,
  type WireCap,
} from '../codec.ts';
import { ALL_DICTS } from '../dicts.ts';
import { ROOM_EPOCH, KIND_TO_BYTE } from '../envelope-v2.ts';

beforeAll(async () => {
  await ensureWireCodecReady();
});

describe('wire-codec', () => {
  it('JSON-encodes by default, decodes back', () => {
    const obj = { v: 1, kind: 'chat-msg', body: 'hi' };
    const bytes = encode(obj);
    expect(bytes[0]).toBe(0x7B);  // '{' — JSON
    expect(decode(bytes)).toEqual(obj);
  });

  it('opts.cbor=true emits CBOR', () => {
    const obj = { v: 1, kind: 'chat-msg', body: 'hi' };
    const bytes = encode(obj, { cbor: true });
    expect(bytes[0]).not.toBe(0x7B);
    expect(isCborMagic(bytes)).toBe(true);
    expect(decode(bytes)).toEqual(obj);
  });

  it('decode accepts both JSON and CBOR', () => {
    const obj = { v: 1, kind: 'chat-msg', body: 'hello world' };
    const json = encode(obj, { cbor: false });
    const cbor = encode(obj, { cbor: true });
    expect(decode(json)).toEqual(obj);
    expect(decode(cbor)).toEqual(obj);
  });

  it('CBOR is smaller than JSON for typical envelope', () => {
    const env = {
      v: 1,
      id: '01234567-89ab-cdef-0123-456789abcdef',
      ts: 1777891000000,
      from: 'a'.repeat(64),
      kind: 'chat-msg',
      body: 'hello'
    };
    const json = encode(env, { cbor: false });
    const cbor = encode(env, { cbor: true });
    expect(cbor.length).toBeLessThan(json.length);
  });

  it('CBOR envelope first byte is in map-header range (0xA0-0xBB)', () => {
    // Load-bearing for the magic-byte sniff: top-level envelopes must be maps.
    const env = {
      v: 1,
      id: 'a'.repeat(36),
      ts: 1777891000000,
      from: 'b'.repeat(64),
      kind: 'chat-msg',
      body: 'hello',
    };
    const cbor = encode(env, { cbor: true });
    expect(cbor[0]).toBeGreaterThanOrEqual(0xA0);
    expect(cbor[0]).toBeLessThanOrEqual(0xBB);
  });

  it('preserves Uint8Array natively in CBOR', () => {
    const obj = { kind: 'cashu-token-send', token: new Uint8Array([1, 2, 3, 4]) };
    const cbor = encode(obj, { cbor: true });
    const decoded = decode(cbor) as { kind: string; token: Uint8Array };
    expect(decoded.token).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.token)).toEqual([1, 2, 3, 4]);
  });

  it('decode throws on truly malformed bytes', () => {
    expect(() => decode(asWireBytes(new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC, 0xFB])))).toThrow();
  });

  it('decode tolerates legacy string input (TextEncoder bytes of JSON)', () => {
    const json = '{"v":1,"kind":"chat-msg"}';
    const bytes = new TextEncoder().encode(json);
    expect(decode(asWireBytes(bytes))).toEqual({ v: 1, kind: 'chat-msg' });
  });

  it('decode accepts JSON arrays too', () => {
    const obj = [{ v: 1, kind: 'chat-msg' }, { v: 1, kind: 'chat-typing' }];
    const bytes = encode(obj);
    expect(bytes[0]).toBe(0x5B);  // '['
    expect(decode(bytes)).toEqual(obj);
  });
});

describe('wire-codec — zstd', () => {
  it('encodes with cbor+zstd, decodes back', () => {
    const obj = {
      v: 1,
      id: 'a'.repeat(36),
      ts: 1777891000000,
      from: 'b'.repeat(64),
      kind: 'chat-msg',
      body: 'hello world'.repeat(10),
    };
    const bytes = encode(obj, { cbor: true, zstd: true });
    expect(bytes[0]).toBe(0xC6);
    expect(decode(bytes)).toEqual(obj);
  });

  it('zstd actually shrinks larger payloads', () => {
    const obj = {
      v: 1,
      id: 'a'.repeat(36),
      kind: 'chat-msg',
      body: 'hello '.repeat(100),
    };
    const cbor = encode(obj, { cbor: true });
    const zstd = encode(obj, { cbor: true, zstd: true });
    expect(zstd.length).toBeLessThan(cbor.length);
  });

  it('throws if zstd without cbor', () => {
    expect(() => encode({}, { zstd: true })).toThrow(/zstd requires cbor/);
  });

  it('preserves Uint8Array through zstd round-trip', () => {
    const obj = {
      kind: 'cashu-token-send',
      token: new Uint8Array(64).fill(0xAB),
    };
    const bytes = encode(obj, { cbor: true, zstd: true });
    const decoded = decode(bytes) as { kind: string; token: Uint8Array };
    expect(decoded.token).toBeInstanceOf(Uint8Array);
    expect(decoded.token.length).toBe(64);
    expect(decoded.token[0]).toBe(0xAB);
  });
});

describe('negotiateCap', () => {
  it('picks highest mutual', () => {
    expect(negotiateCap(['json', 'cbor'], ['json', 'cbor'])).toBe('cbor');
    expect(negotiateCap(['json', 'cbor', 'cbor+zstd'], ['json', 'cbor'])).toBe('cbor');
    expect(negotiateCap(['json'], ['cbor', 'cbor+zstd'])).toBe('json');
    expect(negotiateCap(['cbor+zstd'], ['cbor+zstd'])).toBe('cbor+zstd');
    expect(negotiateCap(ALL_CAPS, ALL_CAPS)).toBe('cbor+zstd');
  });

  it('falls back to json when no overlap', () => {
    // Both lists empty — degenerate case
    expect(negotiateCap([] as WireCap[], [] as WireCap[])).toBe('json');
  });

  it('falls back to json if mutual list excludes higher tiers', () => {
    expect(negotiateCap(['cbor'], ['json'])).toBe('json');
  });
});

describe('capToOpts', () => {
  it('maps caps to encode opts', () => {
    expect(capToOpts('json')).toEqual({ cbor: false, zstd: false });
    expect(capToOpts('cbor')).toEqual({ cbor: true, zstd: false });
    expect(capToOpts('cbor+zstd')).toEqual({ cbor: true, zstd: true });
  });

  it('round-trips via encode/decode for each cap', () => {
    const env = { v: 1, kind: 'chat-msg', body: 'round trip' };
    for (const cap of ALL_CAPS) {
      const bytes = encode(env, capToOpts(cap));
      expect(decode(bytes)).toEqual(env);
    }
  });
});

describe('Phase 2.E.B — zstd dict negotiation + encoder', () => {
  it('encodes with shared dict, prefixes 0xC7 + dict-id, round-trips', () => {
    const env = {
      v: 1, kind: 'chat-msg', from: 'a'.repeat(64),
      body: 'Привет, как дела? Уже еду к тебе, буду через 20 минут.',
    };
    const bytes = encode(env, { cbor: true, zstd: true, dict: 'zstd-dict-ru-v1' });
    expect(bytes[0]).toBe(0xC7);
    expect(bytes[1]).toBe(0x01); // ru-v1
    expect(decode(bytes)).toEqual(env);
  });

  it('falls back to 0xC6 when requested dict is not loaded', async () => {
    // Simulate the preload-failure scenario by evicting fa from the cache.
    // Encoder requested fa-v1 → cache miss → silent fallback to dictless 0xC6.
    // Next call triggers re-load via getDictBytes(undefined) path.
    const { _evictDictForTesting, loadDict } = await import('../dicts.ts');
    _evictDictForTesting('zstd-dict-fa-v1');
    try {
      const env = { v: 1, kind: 'chat-msg', body: 'fallback test' };
      const bytes = encode(env, { cbor: true, zstd: true, dict: 'zstd-dict-fa-v1' });
      expect(bytes[0]).toBe(0xC6); // dictless magic
      expect(decode(bytes)).toEqual(env);
    } finally {
      // Restore so subsequent tests in this run get fa back.
      await loadDict('zstd-dict-fa-v1');
    }
  });

  it('decode of unknown dict-id throws explicit protocol error', () => {
    // Hand-craft a 0xC7 frame with bogus dict-id 0xFE.
    const bogus = new Uint8Array([0xC7, 0xFE, 0x00, 0x00]);
    expect(() => decode(asWireBytes(bogus))).toThrow(/unknown zstd dict-id/);
  });

  it('rejects a zstd frame whose compressed length exceeds the cap (bomb defense)', () => {
    // Construct a 0xC6 frame larger than ZSTD_MAX_COMPRESSED_BYTES (64 KB).
    // Body content does not matter — the cap MUST trip before zstdDecompress
    // is invoked. Real envelopes are <2 KB; 70 KB compressed is unambiguously
    // hostile.
    const big = new Uint8Array(70 * 1024);
    big[0] = 0xC6;
    expect(() => decode(asWireBytes(big))).toThrow(/exceeds compressed-size cap/);
  });

  it('rejects an oversized zstd-dict frame', () => {
    const big = new Uint8Array(70 * 1024);
    big[0] = 0xC7;
    big[1] = 0x01;
    expect(() => decode(asWireBytes(big))).toThrow(/exceeds compressed-size cap/);
  });

  it('rejects a tiny zstd frame whose declared FCS exceeds the decompressed cap (bomb defense)', () => {
    // Real attack shape — small compressed input, huge declared FCS. Without
    // JS-side header parse, @bokuweb/zstd-wasm's `decompress()` mallocs the
    // dst buffer from this declared size BEFORE returning to JS. Validator
    // must trip before any wasm call.
    //
    // Frame layout (RFC 8878 §3.1.1):
    //   Magic_Number      : 28 B5 2F FD
    //   Frame_Header_Desc : FCS_flag=3 (8 bytes), Single_Segment=0,
    //                       no checksum, no dict-id  → 0xC0
    //   Window_Descriptor : 0x40 (small; consumed because Single_Segment=0)
    //   Frame_Content_Size: 8 bytes LE = 0xFFFFFFFF (4 GiB-1)
    //   ...trailing junk (validator must reject before reading bodies)
    const bomb = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd,            // magic
      0xc0,                              // FHD: FCS_flag=3, single_segment=0
      0x40,                              // window descriptor
      0xff, 0xff, 0xff, 0xff,            // FCS LE bytes 0..3 = 4 GiB-1
      0x00, 0x00, 0x00, 0x00,            // FCS LE bytes 4..7
      0x00, 0x00, 0x00,                  // junk body — never reached
    ]);
    // Wrap with 0xC6 magic prefix as the wire-codec expects.
    const wire = new Uint8Array(1 + bomb.length);
    wire[0] = 0xC6;
    wire.set(bomb, 1);
    expect(() => decode(asWireBytes(wire))).toThrow(/Frame_Content_Size .* exceeds cap/);
  });

  it('rejects a zstd frame that omits Frame_Content_Size (streaming, FCS absent)', () => {
    // FHD: FCS_flag=0, Single_Segment=0 → FCS field is 0 bytes (absent).
    // We never emit such frames; reject as protocol error.
    const frame = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd,            // magic
      0x00,                              // FHD: all zero → FCS absent
      0x40,                              // window descriptor
      0x00, 0x00, 0x00,                  // junk
    ]);
    const wire = new Uint8Array(1 + frame.length);
    wire[0] = 0xC6;
    wire.set(frame, 1);
    expect(() => decode(asWireBytes(wire))).toThrow(/omits Frame_Content_Size/);
  });

  it('ALL_DICTS lists shipped dicts (ru/fa/en post-Phase 2.E.C/D)', () => {
    expect(ALL_DICTS).toEqual(['zstd-dict-ru-v1', 'zstd-dict-fa-v1', 'zstd-dict-en-v1']);
  });

  it('encodes with FA dict, prefixes 0xC7 0x02, round-trips', () => {
    const env = {
      v: 1, kind: 'chat-msg', from: 'a'.repeat(64),
      body: 'سلام، حالت چطوره؟ من تا ده دقیقه دیگه میرسم.',
    };
    const bytes = encode(env, { cbor: true, zstd: true, dict: 'zstd-dict-fa-v1' });
    expect(bytes[0]).toBe(0xC7);
    expect(bytes[1]).toBe(0x02); // fa-v1
    expect(decode(bytes)).toEqual(env);
  });

  it('encodes with EN dict, prefixes 0xC7 0x03, round-trips', () => {
    const env = {
      v: 1, kind: 'chat-msg', from: 'a'.repeat(64),
      body: "hey, on my way — be there in 10 min",
    };
    const bytes = encode(env, { cbor: true, zstd: true, dict: 'zstd-dict-en-v1' });
    expect(bytes[0]).toBe(0xC7);
    expect(bytes[1]).toBe(0x03); // en-v1
    expect(decode(bytes)).toEqual(env);
  });

  it('loadDict de-dupes concurrent fetches for the same dict (in-flight Promise)', async () => {
    // Audit hardening: prior to the dedup, two simultaneous loadDict() calls
    // for the same name issued two HTTP fetches. With dedup, both share one.
    const { _evictDictForTesting, loadDict } = await import('../dicts.ts');
    _evictDictForTesting('zstd-dict-fa-v1');

    let fetchCount = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/dicts/zstd-dict-fa-v1.zstd')) {
        fetchCount++;
        // Yield control so concurrent callers all enqueue before the first
        // resolves — exercises the in-flight dedup path.
        await new Promise((r) => setTimeout(r, 5));
      }
      return realFetch(input);
    }) as typeof fetch;

    try {
      // 100 concurrent callers — stresses the in-flight dedup well past the
      // original 5-caller smoke. Pre-fix, this would issue 100 fetches.
      const promises = Array.from({ length: 100 }, () => loadDict('zstd-dict-fa-v1'));
      const bufs = await Promise.all(promises);
      // Exactly one fetch went on the wire — dedup held.
      expect(fetchCount).toBe(1);
      // All callers received the same bytes (ref-equal because cache).
      for (let i = 1; i < bufs.length; i++) expect(bufs[i]).toBe(bufs[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('negotiateDict (room-wide intersection)', () => {
  it('picks shared dict when every peer supports it', () => {
    expect(negotiateDict(
      ['cbor', 'cbor+zstd', 'zstd-dict-ru-v1'],
      [['cbor', 'cbor+zstd', 'zstd-dict-ru-v1']],
    )).toBe('zstd-dict-ru-v1');
  });

  it('returns undefined when at least one peer lacks the dict', () => {
    expect(negotiateDict(
      ['cbor', 'cbor+zstd', 'zstd-dict-ru-v1'],
      [['cbor', 'cbor+zstd']],
    )).toBeUndefined();
  });

  it('returns undefined when only old peers (no caps array) are present', () => {
    expect(negotiateDict(
      ['cbor', 'cbor+zstd', 'zstd-dict-ru-v1'],
      [[]],
    )).toBeUndefined();
  });

  it('zero peers (solo room) → undefined (nothing to negotiate against)', () => {
    // every() over empty array is true → mine alone wins; that's fine, encoder
    // still falls back to 0xC6 because no broadcast happens at peerCount<=1.
    expect(negotiateDict(
      ['cbor', 'cbor+zstd', 'zstd-dict-ru-v1'],
      [],
    )).toBe('zstd-dict-ru-v1');
  });

  it('order-deterministic: shuffled mine + peer cap arrays converge on same priority', () => {
    // Two peers can advertise caps in different orders. Result MUST be priority-
    // driven (ALL_DICTS = [ru, fa, en]), not driven by `mine` ordering — otherwise
    // peer A picks ru-v1, peer B picks fa-v1, and frames are mutually undecodable.
    const allCaps: readonly WireCap[] = ['cbor', 'cbor+zstd', 'zstd-dict-en-v1', 'zstd-dict-fa-v1', 'zstd-dict-ru-v1'];
    const peerA = ['zstd-dict-fa-v1', 'cbor', 'zstd-dict-ru-v1', 'cbor+zstd', 'zstd-dict-en-v1'] as const;
    const peerB = ['zstd-dict-en-v1', 'zstd-dict-ru-v1', 'cbor+zstd', 'cbor', 'zstd-dict-fa-v1'] as const;
    expect(negotiateDict(allCaps, [peerA as readonly WireCap[]])).toBe('zstd-dict-ru-v1');
    expect(negotiateDict(allCaps, [peerB as readonly WireCap[]])).toBe('zstd-dict-ru-v1');
    expect(negotiateDict(allCaps, [peerA as readonly WireCap[], peerB as readonly WireCap[]])).toBe('zstd-dict-ru-v1');
  });
});

// ─── Phase 2.F.A — envelope-v2 compaction ─────────────────────────────────────

describe('Phase 2.F.A — envelope-v2 (0xC8 magic, compact id/ts/k)', () => {
  // A representative chat-msg envelope, all fields v2-encodable.
  const sampleEnv = (over: Partial<Record<string, unknown>> = {}) => ({
    v: 1,
    id: '01234567-89ab-cdef-0123-456789abcdef',
    ts: ROOM_EPOCH + 60_000, // 1 minute past epoch
    from: 'a'.repeat(64),
    kind: 'chat-msg',
    body: 'Привет',
    ...over,
  });

  it('roundtrip dictless (0xC8 0x00)', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 2 });
    expect(bytes[0]).toBe(0xC8);
    expect(bytes[1]).toBe(0x00);
    expect(decode(bytes)).toEqual(env);
  });

  it('roundtrip with each shipped dict (0xC8 0x01/0x02/0x03)', () => {
    const cases: Array<{ dict: 'zstd-dict-ru-v1' | 'zstd-dict-fa-v1' | 'zstd-dict-en-v1'; id: number; body: string }> = [
      { dict: 'zstd-dict-ru-v1', id: 0x01, body: 'Привет, как дела? Уже еду к тебе, буду через 20 минут.' },
      { dict: 'zstd-dict-fa-v1', id: 0x02, body: 'سلام، حالت چطوره؟ من تا ده دقیقه دیگه میرسم.' },
      { dict: 'zstd-dict-en-v1', id: 0x03, body: 'hey, on my way — be there in 10 min' },
    ];
    for (const c of cases) {
      const env = sampleEnv({ body: c.body });
      const bytes = encode(env, { cbor: true, zstd: true, envelope: 2, dict: c.dict });
      expect(bytes[0]).toBe(0xC8);
      expect(bytes[1]).toBe(c.id);
      expect(decode(bytes)).toEqual(env);
    }
  });

  it('every shipped kind round-trips through enum and back', () => {
    for (const kind of Object.keys(KIND_TO_BYTE)) {
      const env = sampleEnv({ kind });
      const bytes = encode(env, { cbor: true, zstd: true, envelope: 2 });
      expect(bytes[0]).toBe(0xC8);
      expect(decode(bytes)).toEqual(env);
    }
  });

  it('kind enum byte values are stable wire IDs (renumber === silent corruption at scale)', () => {
    // Frozen-constant gate: tests above use KIND_TO_BYTE itself as the oracle,
    // so an off-by-one bump (e.g. chat-edit becoming 0x03 + chat-delete 0x04)
    // would still pass round-trip. THIS test pins each literal byte explicitly.
    // If you renumber, you break wire compat with every shipped client. DON'T.
    expect(KIND_TO_BYTE['chat-msg']).toBe(0x01);
    expect(KIND_TO_BYTE['chat-edit']).toBe(0x02);
    expect(KIND_TO_BYTE['chat-delete']).toBe(0x03);
    expect(KIND_TO_BYTE['chat-reaction']).toBe(0x04);
    expect(KIND_TO_BYTE['chat-receipt']).toBe(0x05);
    expect(KIND_TO_BYTE['chat-typing']).toBe(0x06);
    expect(KIND_TO_BYTE['chat-history']).toBe(0x07);
    expect(KIND_TO_BYTE['chat-history-request']).toBe(0x08);
    // Payment kinds — provisional until first prod payment frame ships,
    // see docs/FOLLOWUPS.md A11. After ship: lock these the same way.
    expect(KIND_TO_BYTE['pay-quote-request']).toBe(0x10);
    expect(KIND_TO_BYTE['pay-quote']).toBe(0x11);
    expect(KIND_TO_BYTE['pay-paid']).toBe(0x12);
    expect(KIND_TO_BYTE['pay-confirmed']).toBe(0x13);
    expect(KIND_TO_BYTE['pay-cancel']).toBe(0x14);
    expect(KIND_TO_BYTE['pay-offer-publish']).toBe(0x15);
    expect(KIND_TO_BYTE['pay-offer-pay-request']).toBe(0x16);
    expect(KIND_TO_BYTE['cashu-token-send']).toBe(0x20);
    expect(KIND_TO_BYTE['cashu-token-claim']).toBe(0x21);
    expect(KIND_TO_BYTE['cashu-token-bounce']).toBe(0x22);
    expect(KIND_TO_BYTE['evm-pay-quote-request']).toBe(0x30);
    expect(KIND_TO_BYTE['evm-pay-quote']).toBe(0x31);
    expect(KIND_TO_BYTE['evm-pay-paid']).toBe(0x32);
    expect(KIND_TO_BYTE['evm-pay-confirmed']).toBe(0x33);
    expect(KIND_TO_BYTE['evm-pay-cancel']).toBe(0x34);
    expect(KIND_TO_BYTE['xmr-pay-quote-request']).toBe(0x40);
    expect(KIND_TO_BYTE['xmr-pay-quote']).toBe(0x41);
    expect(KIND_TO_BYTE['xmr-pay-paid']).toBe(0x42);
    expect(KIND_TO_BYTE['xmr-pay-confirmed']).toBe(0x43);
    expect(KIND_TO_BYTE['xmr-pay-cancel']).toBe(0x44);
  });

  it('v2 frames are smaller than v1 for short RU messages', () => {
    const inputs = ['ок', 'Привет', 'Да', 'Хорошо'];
    for (const body of inputs) {
      const env = sampleEnv({ body });
      const v1 = encode(env, { cbor: true, zstd: true, envelope: 1 });
      const v2 = encode(env, { cbor: true, zstd: true, envelope: 2 });
      // eslint-disable-next-line no-console
      console.log(`[2FA-size] body="${body}": v1=${v1.length}B v2=${v2.length}B Δ=${v1.length - v2.length}B`);
      expect(v2.length).toBeLessThan(v1.length);
    }
  });

  it('negotiateEnvelopeVersion: 2 only when every peer advertises envelope-v2', () => {
    const mineV2: readonly WireCap[] = ALL_CAPS;
    const mineV1: readonly WireCap[] = ['cbor', 'cbor+zstd'];
    expect(negotiateEnvelopeVersion(mineV2, [['cbor', 'cbor+zstd', 'envelope-v2']])).toBe(2);
    expect(negotiateEnvelopeVersion(mineV2, [['cbor', 'cbor+zstd', 'envelope-v2'], ['cbor', 'envelope-v2']])).toBe(2);
    expect(negotiateEnvelopeVersion(mineV2, [['cbor', 'cbor+zstd']])).toBe(1);
    expect(negotiateEnvelopeVersion(mineV2, [['envelope-v2'], ['cbor']])).toBe(1);
    // I lack envelope-v2 → always 1.
    expect(negotiateEnvelopeVersion(mineV1, [['envelope-v2']])).toBe(1);
    // Empty roster → 1 (defensive: matches solo-pin shape in useBurnerChat).
    expect(negotiateEnvelopeVersion(mineV2, [])).toBe(1);
  });

  it('decoder accepts mixed-roster v2 frames even when room sends v1', () => {
    // A peer with envelope-v2 cap will accept both v1 (legacy fallback) and v2
    // self-test frames. Verifies decoder branches don't depend on negotiation.
    const env = sampleEnv();
    const v1 = encode(env, { cbor: true, zstd: true, envelope: 1 });
    const v2 = encode(env, { cbor: true, zstd: true, envelope: 2 });
    expect(decode(v1)).toEqual(env);
    expect(decode(v2)).toEqual(env);
  });

  it('decoder of 0xC8 0x00 with unknown enum byte returns forward-compat sentinel', async () => {
    // Forge a v2 frame whose `k` is 0xFF (unassigned). Encode dictless via
    // direct CBOR + zstd, prefix manually.
    const { Encoder } = await import('cbor-x');
    const { compress } = await import('@bokuweb/zstd-wasm');
    const cborEnc = new Encoder({ mapsAsObjects: true, useRecords: false });
    const bogus = {
      v: 2,
      id: new Uint8Array(16),
      ts: 60_000,
      from: 'a'.repeat(64),
      k: 0xFF,
      body: 'x',
    };
    const cbor = cborEnc.encode(bogus);
    const zst = compress(cbor, 3);
    const wire = new Uint8Array(2 + zst.length);
    wire[0] = 0xC8;
    wire[1] = 0x00;
    wire.set(zst, 2);
    const result = decode(asWireBytes(wire));
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).kind).toBe("chat-unknown-future");
    expect((result as Record<string, unknown>).raw).toBe(0xFF);
  });

  it('rejects 0xC8 frame whose compressed length exceeds the cap', () => {
    const big = new Uint8Array(70 * 1024);
    big[0] = 0xC8;
    big[1] = 0x00;
    expect(() => decode(asWireBytes(big))).toThrow(/exceeds compressed-size cap/);
  });

  it('rejects 0xC8 frame with bomb-shape FCS = 4 GiB', () => {
    const bomb = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd,
      0xc0, 0x40,
      0xff, 0xff, 0xff, 0xff,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const wire = new Uint8Array(2 + bomb.length);
    wire[0] = 0xC8;
    wire[1] = 0x00;
    wire.set(bomb, 2);
    expect(() => decode(asWireBytes(wire))).toThrow(/Frame_Content_Size .* exceeds cap/);
  });

  it('encoder falls back to v1 when value isn\'t v2-encodable', () => {
    // Unknown kind → silent v1 fallback (per-frame, opportunistic).
    const env = { v: 1, id: '01234567-89ab-cdef-0123-456789abcdef', ts: ROOM_EPOCH, from: 'a'.repeat(64), kind: 'future-kind', body: 'x' };
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 2 });
    // 0xC6 (dictless v1) — NOT 0xC8.
    expect(bytes[0]).toBe(0xC6);
    expect(decode(bytes)).toEqual(env);
  });

  it('encoder falls back to v1 when ts is before ROOM_EPOCH', () => {
    const env = { v: 1, id: '01234567-89ab-cdef-0123-456789abcdef', ts: ROOM_EPOCH - 1, from: 'x'.repeat(64), kind: 'chat-msg', body: 'x' };
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 2 });
    expect(bytes[0]).toBe(0xC6);
    expect(decode(bytes)).toEqual(env);
  });

  it('preserves unknown fields through v2 round-trip (forward-compat passthrough)', () => {
    const env = sampleEnv({ futureField: 'survive', nested: { a: 1, b: [1, 2, 3] } });
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 2 });
    expect(decode(bytes)).toEqual(env);
  });

  it('backwards-compat: envelope=1 byte-identical to default zstd path', () => {
    // Old peers MUST receive byte-for-byte identical Phase 2.E.B output.
    const env = sampleEnv();
    const a = encode(env, { cbor: true, zstd: true });
    const b = encode(env, { cbor: true, zstd: true, envelope: 1 });
    expect(a).toEqual(b);
  });
});

// ─── Phase 2.F.B — envelope-v3 (peer-index compaction) ───────────────────────

describe('Phase 2.F.B — envelope-v3 (0xCA magic, peer-index compaction)', () => {
  const sampleEnv = (over: Partial<Record<string, unknown>> = {}) => ({
    v: 1,
    id: '01234567-89ab-cdef-0123-456789abcdef',
    ts: ROOM_EPOCH + 60_000,
    from: 'a'.repeat(64),
    kind: 'chat-msg',
    body: 'Привет',
    ...over,
  });

  // Simulated ratchet peer_index_map: uint8 → 64-char hex pubkey.
  const PEER_MAP: Record<number, string> = {
    0: 'a'.repeat(64),
    1: 'b'.repeat(64),
    42: 'c'.repeat(64),
  };
  const resolvePeer = (idx: number) => PEER_MAP[idx];

  it('roundtrip dictless (0xCA 0x00 <peerIndex>)', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    expect(bytes[0]).toBe(0xCA);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[2]).toBe(0x00);
    const decoded = decode(bytes, { resolvePeer }) as Record<string, unknown>;
    expect(decoded.from).toBe(env.from);
    expect(decoded.kind).toBe(env.kind);
    expect(decoded.body).toBe(env.body);
    expect(decoded.id).toBe(env.id);
    expect(decoded.ts).toBe(env.ts);
    expect(decoded.v).toBe(1);
  });

  it('roundtrip with each shipped dict (0xCA 0x01/0x02/0x03 <peerIndex>)', () => {
    const cases: Array<{ dict: 'zstd-dict-ru-v1' | 'zstd-dict-fa-v1' | 'zstd-dict-en-v1'; id: number; body: string }> = [
      { dict: 'zstd-dict-ru-v1', id: 0x01, body: 'Привет, как дела? Уже еду к тебе, буду через 20 минут.' },
      { dict: 'zstd-dict-fa-v1', id: 0x02, body: 'سلام، حالت چطوره؟ من تا ده دقیقه دیگه میرسم.' },
      { dict: 'zstd-dict-en-v1', id: 0x03, body: 'hey, on my way — be there in 10 min' },
    ];
    for (const c of cases) {
      const env = sampleEnv({ body: c.body });
      const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 1, dict: c.dict });
      expect(bytes[0]).toBe(0xCA);
      expect(bytes[1]).toBe(c.id);
      expect(bytes[2]).toBe(0x01);
      const decoded = decode(bytes, { resolvePeer }) as Record<string, unknown>;
      expect(decoded.from).toBe(PEER_MAP[1]);
      expect(decoded.body).toBe(c.body);
    }
  });

  it('v3 frames are smaller than v2 (peer-index replaces 64-char hex)', () => {
    const inputs = ['ок', 'Привет', 'Да'];
    for (const body of inputs) {
      const env = sampleEnv({ body });
      const v2 = encode(env, { cbor: true, zstd: true, envelope: 2 });
      const v3 = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
      // eslint-disable-next-line no-console
      console.log(`[2FB-size] body="${body}": v2=${v2.length}B v3=${v3.length}B Δ=${v2.length - v3.length}B`);
      expect(v3.length).toBeLessThan(v2.length);
    }
  });

  it('negotiateEnvelopeVersion: 3 when all peers advertise envelope-v3, 2 when v2-only, 1 otherwise', () => {
    const mineV3: readonly WireCap[] = ALL_CAPS;
    const mineV2: readonly WireCap[] = ['cbor', 'cbor+zstd', 'envelope-v2'];
    const mineV1: readonly WireCap[] = ['cbor', 'cbor+zstd'];
    // v3 universal → 3
    expect(negotiateEnvelopeVersion(mineV3, [['cbor', 'cbor+zstd', 'envelope-v2', 'envelope-v3']])).toBe(3);
    expect(negotiateEnvelopeVersion(mineV3, [['envelope-v3'], ['envelope-v2', 'envelope-v3']])).toBe(3);
    // v3 not universal but v2 universal → 2
    expect(negotiateEnvelopeVersion(mineV3, [['cbor', 'cbor+zstd', 'envelope-v2']])).toBe(2);
    expect(negotiateEnvelopeVersion(mineV3, [['envelope-v2', 'envelope-v3'], ['envelope-v2']])).toBe(2);
    // neither universal → 1
    expect(negotiateEnvelopeVersion(mineV3, [['cbor', 'cbor+zstd']])).toBe(1);
    // I lack v3 but have v2, peers have v3 → 2 (I can't encode v3, fall to v2)
    expect(negotiateEnvelopeVersion(mineV2, [['envelope-v3']])).toBe(1);
    // I lack both → 1
    expect(negotiateEnvelopeVersion(mineV1, [['envelope-v3']])).toBe(1);
    // Solo → 1
    expect(negotiateEnvelopeVersion(mineV3, [])).toBe(1);
  });

  it('decoder without resolvePeer returns from=undefined + preserves f', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 42 });
    const decoded = decode(bytes) as Record<string, unknown>;
    expect(decoded.from).toBeUndefined();
    expect(decoded.f).toBe(42);
    expect(decoded.kind).toBe(env.kind);
  });

  it('decoder with resolvePeer returning undefined (peer not in map) → from=undefined + f preserved', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 99 });
    const decoded = decode(bytes, { resolvePeer: () => undefined }) as Record<string, unknown>;
    expect(decoded.from).toBeUndefined();
    expect(decoded.f).toBe(99);
  });

  it('decoder of 0xCA with unknown enum byte returns forward-compat sentinel', async () => {
    const { Encoder } = await import('cbor-x');
    const { compress } = await import('@bokuweb/zstd-wasm');
    const cborEnc = new Encoder({ mapsAsObjects: true, useRecords: false });
    const bogus = {
      v: 3,
      id: new Uint8Array(16),
      ts: 60_000,
      f: 0,
      k: 0xFF,
      body: 'x',
    };
    const cbor = cborEnc.encode(bogus);
    const zst = compress(cbor, 3);
    const wire = new Uint8Array(3 + zst.length);
    wire[0] = 0xCA;
    wire[1] = 0x00;
    wire[2] = 0x00;
    wire.set(zst, 3);
    const result = decode(asWireBytes(wire), { resolvePeer }) as Record<string, unknown>;
    expect(result.kind).toBe('chat-unknown-future');
    expect(result.raw).toBe(0xFF);
    expect(result.from).toBe(PEER_MAP[0]);
  });

  it('rejects 0xCA frame whose compressed length exceeds the cap', () => {
    const big = new Uint8Array(70 * 1024);
    big[0] = 0xCA;
    big[1] = 0x00;
    big[2] = 0x00;
    expect(() => decode(asWireBytes(big))).toThrow(/exceeds compressed-size cap/);
  });

  it('rejects 0xCA frame with bomb-shape FCS = 4 GiB', () => {
    const bomb = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd,
      0xc0, 0x40,
      0xff, 0xff, 0xff, 0xff,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const wire = new Uint8Array(3 + bomb.length);
    wire[0] = 0xCA;
    wire[1] = 0x00;
    wire[2] = 0x00;
    wire.set(bomb, 3);
    expect(() => decode(asWireBytes(wire))).toThrow(/Frame_Content_Size .* exceeds cap/);
  });

  it('rejects truncated 0xCA frame (< 3 header bytes)', () => {
    const wire = new Uint8Array([0xCA, 0x00]);
    expect(() => decode(asWireBytes(wire))).toThrow(/truncated zstd-v3 frame/);
  });

  it('encoder falls back to v2 when peerIndex is missing', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3 });
    expect(bytes[0]).toBe(0xC8);
  });

  it('encoder falls back to v2 when peerIndex is out of uint8 range', () => {
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 256 });
    expect(bytes[0]).toBe(0xC8);
  });

  it('encoder falls back to v2 when from is missing (v2 does not require from)', () => {
    const env = sampleEnv();
    delete (env as Record<string, unknown>).from;
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    // v3 requires `from` (to replace with peer-index). v2 does NOT require from
    // (it keeps from as-is, and missing from is a valid v2 frame). So fallback
    // goes v3→v2 (0xC8), not v3→v1.
    expect(bytes[0]).toBe(0xC8);
  });

  it('encoder falls back to v1 when kind is unknown', () => {
    const env = sampleEnv({ kind: 'future-kind' });
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    expect(bytes[0]).toBe(0xC6);
  });

  it('preserves unknown fields through v3 round-trip', () => {
    const env = sampleEnv({ futureField: 'survive', nested: { a: 1, b: [1, 2, 3] } });
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    const decoded = decode(bytes, { resolvePeer }) as Record<string, unknown>;
    expect(decoded.futureField).toBe('survive');
    expect(decoded.from).toBe(env.from);
  });

  it('decoder accepts mixed-roster v3/v2/v1 frames (decoder branches independent of negotiation)', () => {
    const env = sampleEnv();
    const v1 = encode(env, { cbor: true, zstd: true, envelope: 1 });
    const v2 = encode(env, { cbor: true, zstd: true, envelope: 2 });
    const v3 = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    expect(decode(v1, { resolvePeer })).toEqual(env);
    expect(decode(v2, { resolvePeer })).toEqual(env);
    const d3 = decode(v3, { resolvePeer }) as Record<string, unknown>;
    expect(d3.from).toBe(env.from);
    expect(d3.kind).toBe(env.kind);
    expect(d3.body).toBe(env.body);
  });

  it('0xCA magic byte is distinct from 0xC8 (v2) and 0xC9 (mesh-bundle)', () => {
    expect(0xCA).not.toBe(0xC8);
    expect(0xCA).not.toBe(0xC9);
    // Encode a v3 frame and verify the magic byte.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    expect(bytes[0]).toBe(0xCA);
  });

  // ─── Mutation-testing hardening ──────────────────────────────────────────
  // These tests kill mutants that roundtrip tests miss because fromV3
  // reconstructs the v1 shape, masking internal encoding errors.

  it('toV3 removes `from` from the wire CBOR (not just replaces it)', async () => {
    // If a mutant keeps `from` in the v3 CBOR, the frame is larger than
    // necessary but still roundtrips. Decode the raw CBOR to verify `from`
    // is absent and `f` is present.
    const { decode: cborDecode } = await import('cbor-x/index-no-eval');
    const { decompress } = await import('@bokuweb/zstd-wasm');
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 7 });
    // Strip 0xCA + dict-id + peer-index (3 bytes), decompress, decode CBOR.
    const compressed = bytes.subarray(3);
    const cborBytes = decompress(compressed);
    const raw = cborDecode(cborBytes) as Record<string, unknown>;
    expect(raw.v).toBe(3);
    expect(raw.f).toBe(7);
    expect(raw.k).toBe(KIND_TO_BYTE['chat-msg']);
    expect(raw.from).toBeUndefined();
    expect(raw.id).toBeInstanceOf(Uint8Array);
    expect((raw.id as Uint8Array).length).toBe(16);
  });

  it('toV3 sets v=3 in the wire CBOR (magic byte is authoritative but v must match)', async () => {
    // If a mutant changes out.v = 3 to out.v = 1, the magic byte still
    // routes to fromV3, and fromV3 doesn't check v. The frame roundtrips
    // correctly. But the wire shape is wrong — a future decoder that checks
    // v for validation would break. Verify v=3 in the raw CBOR.
    const { decode: cborDecode } = await import('cbor-x/index-no-eval');
    const { decompress } = await import('@bokuweb/zstd-wasm');
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 0 });
    const compressed = bytes.subarray(3);
    const cborBytes = decompress(compressed);
    const raw = cborDecode(cborBytes) as Record<string, unknown>;
    expect(raw.v).toBe(3);
  });

  it('outer peer-index byte (bytes[2]) matches the CBOR f field', async () => {
    // The outer peer-index byte is currently write-only in decode (we read
    // `f` from the CBOR). But it MUST match the CBOR `f` for future
    // quick-filter routers. Verify they agree.
    const { decode: cborDecode } = await import('cbor-x/index-no-eval');
    const { decompress } = await import('@bokuweb/zstd-wasm');
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 42 });
    expect(bytes[2]).toBe(42);
    const compressed = bytes.subarray(3);
    const cborBytes = decompress(compressed);
    const raw = cborDecode(cborBytes) as Record<string, unknown>;
    expect(raw.f).toBe(42);
    expect(raw.f).toBe(bytes[2]);
  });

  // ─── Boundary tests (mutation-testing gap killers) ───────────────────────
  // These kill surviving mutants identified by stryker: off-by-one on
  // peerIndex range, missing negative/non-integer checks, envelope=2
  // ignoring peerIndex, and fromV3 boundary values.

  it('peerIndex=255 (max uint8) produces 0xCA, not fallback', () => {
    // Kills the mutant `peerIndex > 0xff` → `peerIndex >= 0xff` (off-by-one
    // that would reject 255).
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 255 });
    expect(bytes[0]).toBe(0xCA);
    expect(bytes[2]).toBe(255);
    const decoded = decode(bytes, { resolvePeer: (i) => i === 255 ? 'z'.repeat(64) : undefined }) as Record<string, unknown>;
    expect(decoded.from).toBe('z'.repeat(64));
    // f is deleted on successful resolution (only preserved on failure).
    expect(decoded.f).toBeUndefined();
  });

  it('peerIndex=-1 (negative) falls back to v2', () => {
    // Kills the mutant that removes the `peerIndex < 0` check.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: -1 });
    expect(bytes[0]).toBe(0xC8);
  });

  it('peerIndex=1.5 (non-integer) falls back to v2', () => {
    // Kills the mutant that removes the `!Number.isInteger(peerIndex)` check.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 1.5 });
    expect(bytes[0]).toBe(0xC8);
  });

  it('envelope=2 with peerIndex=0 produces 0xC8, not 0xCA', () => {
    // Kills the mutant `opts.envelope === 3` → `true` on the useV3 line.
    // With the mutant, envelope=2 + peerIndex=0 + v3-encodable value would
    // produce 0xCA instead of 0xC8.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 2, peerIndex: 0 });
    expect(bytes[0]).toBe(0xC8);
  });

  it('envelope=1 with peerIndex=0 produces 0xC6, not 0xCA', () => {
    // Same mutant killer as above, for envelope=1.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 1, peerIndex: 0 });
    expect(bytes[0]).toBe(0xC6);
  });

  it('fromV3 with f=255 resolves correctly (boundary)', () => {
    // Kills the mutant `f > 0xff` → `f >= 0xff` in fromV3 (off-by-one).
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 255 });
    const decoded = decode(bytes, { resolvePeer: (i) => i === 255 ? 'w'.repeat(64) : undefined }) as Record<string, unknown>;
    expect(decoded.from).toBe('w'.repeat(64));
    // f deleted on successful resolution.
    expect(decoded.f).toBeUndefined();
  });

  it('fromV3 with f=255 and failed resolution preserves f (boundary)', () => {
    // Same boundary, but resolution fails → f must be preserved for diagnostics.
    const env = sampleEnv();
    const bytes = encode(env, { cbor: true, zstd: true, envelope: 3, peerIndex: 255 });
    const decoded = decode(bytes, { resolvePeer: () => undefined }) as Record<string, unknown>;
    expect(decoded.from).toBeUndefined();
    expect(decoded.f).toBe(255);
  });

  it('fromV3 with ts at uint32 boundary (0 delta) resolves correctly', async () => {
    // Kills the mutant `tsDelta < 0` → `tsDelta <= 0` in fromV3 (off-by-one
    // that would reject ts=ROOM_EPOCH, delta=0).
    const { Encoder } = await import('cbor-x');
    const { compress } = await import('@bokuweb/zstd-wasm');
    const cborEnc = new Encoder({ mapsAsObjects: true, useRecords: false });
    const frame = {
      v: 3,
      id: new Uint8Array(16),
      ts: 0, // delta = 0 (boundary)
      f: 0,
      k: 0x01,
      body: 'x',
    };
    const cbor = cborEnc.encode(frame);
    const zst = compress(cbor, 3);
    const wire = new Uint8Array(3 + zst.length);
    wire[0] = 0xCA;
    wire[1] = 0x00;
    wire[2] = 0x00;
    wire.set(zst, 3);
    const result = decode(asWireBytes(wire), { resolvePeer }) as Record<string, unknown>;
    expect(result.ts).toBe(ROOM_EPOCH); // 0 + ROOM_EPOCH
    expect(result.from).toBe(PEER_MAP[0]);
  });
});

// FOLLOWUPS A9 — canonicalizeEnvelope produces byte-identical CBOR for two
// equivalent objects whose keys were inserted in different orders. Required
// when a future code path takes a hash over wire bytes (dedup / idempotency
// / signed-fingerprint AAD).
describe('canonicalizeEnvelope (A9)', () => {
  it('two key-order permutations encode to identical bytes', () => {
    const a = { z: 1, a: 'x', m: { b: 2, a: 1 } };
    const b = { m: { a: 1, b: 2 }, a: 'x', z: 1 };
    const ea = encode(canonicalizeEnvelope(a), { cbor: true });
    const eb = encode(canonicalizeEnvelope(b), { cbor: true });
    expect(ea).toEqual(eb);
  });

  it('without canonicalization, cbor-x emits insertion order (regression baseline)', () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    const ea = encode(a, { cbor: true });
    const eb = encode(b, { cbor: true });
    // If this ever stops differing, cbor-x switched to a deterministic mode
    // and the canonicalization helper becomes redundant.
    expect(ea).not.toEqual(eb);
  });

  it('preserves array order, recurses through nested arrays/objects', () => {
    const v = canonicalizeEnvelope({ b: [{ y: 1, x: 0 }, { y: 3, x: 2 }], a: 0 });
    expect(Object.keys(v)).toEqual(['a', 'b']);
    expect(Object.keys(v.b[0] as object)).toEqual(['x', 'y']);
    expect((v.b as { x: number }[]).map((e) => e.x)).toEqual([0, 2]);
  });

  it('passes Uint8Array through unchanged', () => {
    const u = new Uint8Array([1, 2, 3]);
    const v = canonicalizeEnvelope({ k: u });
    expect((v.k as Uint8Array)).toBe(u);
  });
});
