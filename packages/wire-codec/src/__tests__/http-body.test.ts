/**
 * http-body.test.ts — unit tests for encodeHttpBody / decodeHttpBody.
 *
 * Covers:
 *  - round-trip: dictless 0xC6
 *  - round-trip: dict 0xC7 (ru, fa, en)
 *  - plain JSON pass-through
 *  - 0xC8 produces clear peer-envelope error (not generic "unknown magic byte")
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTS_DIR = join(__dirname, '..', '..', 'dicts');
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
  return new Response('not found', { status: 404 });
}) as typeof fetch;

import {
  encodeHttpBody,
  decodeHttpBody,
  ensureWireCodecReady,
} from '../codec.ts';
import { asHttpWireBytes } from '../brands.ts';

beforeAll(async () => {
  await ensureWireCodecReady();
});

describe('encodeHttpBody / decodeHttpBody', () => {
  it('round-trips plain JSON through string input', () => {
    const payload = { v: 1, msg: 'hello' };
    const jsonStr = JSON.stringify(payload);
    const result = decodeHttpBody(jsonStr);
    expect(result).toEqual(payload);
  });

  it('round-trips plain JSON bytes (0x7B prefix)', () => {
    const payload = { v: 1, msg: 'hello' };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    expect(jsonBytes[0]).toBe(0x7b);
    const result = decodeHttpBody(asHttpWireBytes(jsonBytes));
    expect(result).toEqual(payload);
  });

  it('round-trips 0xC6 dictless: encode → frame[0]=0xC6 → decode → original', () => {
    const payload = { v: 1, kind: 'chat-msg', body: 'test message' };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const frame = encodeHttpBody(jsonBytes);
    expect(frame[0]).toBe(0xc6);
    const result = decodeHttpBody(frame);
    expect(result).toEqual(payload);
  });

  it('round-trips 0xC7 with ru dict: encode → frame[0]=0xC7, frame[2]=0x01 → decode → original', () => {
    const payload = { v: 1, kind: 'chat-msg', body: 'тест сообщение' };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const frame = encodeHttpBody(jsonBytes, 'zstd-dict-ru-v1');
    expect(frame[0]).toBe(0xc7);
    expect(frame[1]).toBe(0x00); // high byte of u16 BE
    expect(frame[2]).toBe(0x01); // ru dict-id
    const result = decodeHttpBody(frame);
    expect(result).toEqual(payload);
  });

  it('0xC8 throws specific peer envelope-v2 error (not generic unknown magic byte)', () => {
    // 0xC8 is the peer envelope-v2 format (encode() with envelope:2).
    // decodeHttpBody must reject it with a clear message, not silently throw
    // "unknown magic byte 0xc8" which is hard to diagnose.
    const peerFrame = new Uint8Array([0xc8, 0x00, 0x01, 0x02, 0x03]);
    expect(() => decodeHttpBody(asHttpWireBytes(peerFrame))).toThrow(
      'decodeHttpBody: 0xC8 is the peer envelope-v2 format; use decode() instead.',
    );
  });
});
