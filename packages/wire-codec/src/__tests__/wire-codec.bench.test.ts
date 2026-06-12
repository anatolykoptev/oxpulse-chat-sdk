import { describe, it, expect, beforeAll } from 'vitest';
import { encode, ensureWireCodecReady } from '../codec.ts';

beforeAll(async () => {
  await ensureWireCodecReady();
});

describe('wire-codec bench (informational)', () => {
  const samples: Array<{ name: string; obj: unknown }> = [
    { name: 'chat-msg short', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-msg', body: 'hi'
    }},
    { name: 'chat-msg medium', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-msg', body: 'a'.repeat(50), nick: 'alice'
    }},
    { name: 'chat-msg long-repeat', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-msg', body: 'hello world '.repeat(40), nick: 'alice'
    }},
    { name: 'chat-typing', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-typing', nick: 'alice'
    }},
    { name: 'chat-receipt', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-receipt', targetIds: ['x'.repeat(36)], status: 'delivered'
    }},
    { name: 'chat-receipt 10 targets', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-receipt',
      targetIds: Array.from({ length: 10 }, (_, i) => `${i}`.padStart(36, 'x')),
      status: 'delivered'
    }},
    { name: 'with binary 32B (ThumbHash-like)', obj: {
      v: 1, id: 'a'.repeat(36), ts: 1777891000000, from: 'b'.repeat(64),
      kind: 'chat-msg', body: '', preview: new Uint8Array(32).fill(0xAB)
    }}
  ];

  for (const { name, obj } of samples) {
    it(`measures ${name}`, () => {
      const json = encode(obj, { cbor: false }).length;
      const cbor = encode(obj, { cbor: true }).length;
      const zstd = encode(obj, { cbor: true, zstd: true }).length;
      const cborSavings = ((1 - cbor / json) * 100).toFixed(1);
      const zstdSavingsVsJson = ((1 - zstd / json) * 100).toFixed(1);
      const zstdSavingsVsCbor = ((1 - zstd / cbor) * 100).toFixed(1);
      console.log(
        `[bench] ${name.padEnd(36)}: ` +
        `JSON=${String(json).padStart(4)}B  ` +
        `CBOR=${String(cbor).padStart(4)}B (-${cborSavings}%)  ` +
        `ZSTD=${String(zstd).padStart(4)}B (-${zstdSavingsVsJson}% vs JSON, -${zstdSavingsVsCbor}% vs CBOR)`
      );
      expect(cbor).toBeLessThan(json);
      expect(cbor).toBeGreaterThan(0);
      expect(zstd).toBeGreaterThan(0);
    });
  }
});
