import { describe, it, expect } from 'vitest';
import {
  MAX_VOICE_PEAKS,
  quantizePeaks,
  dequantizePeaks,
  sanitizePeaks,
} from '../waveform-math.ts';

describe('quantizePeaks / dequantizePeaks', () => {
  it('round-trips a small float array through uint8 without drift', () => {
    const original = [0, 0.25, 0.5, 0.75, 1];
    const quantized = quantizePeaks(original);
    expect(quantized).toEqual([0, 64, 128, 191, 255]);
    const dequantized = dequantizePeaks(quantized);
    for (let i = 0; i < original.length; i++) {
      const a = dequantized[i];
      const b = original[i];
      if (a === undefined || b === undefined) continue;
      expect(a).toBeCloseTo(b, 1);
    }
  });

  it('caps quantize output to MAX_VOICE_PEAKS', () => {
    const big = new Array(100).fill(0.5);
    const quantized = quantizePeaks(big);
    expect(quantized.length).toBe(MAX_VOICE_PEAKS);
  });

  it('caps dequantize output to MAX_VOICE_PEAKS', () => {
    const big = new Array(100).fill(128);
    const dequantized = dequantizePeaks(big);
    expect(dequantized.length).toBe(MAX_VOICE_PEAKS);
  });

  it('clamps out-of-range values during quantization', () => {
    expect(quantizePeaks([-0.5, 1.5, NaN, Infinity])).toEqual([0, 255, 0, 0]);
  });

  it('clamps out-of-range uint8 values during dequantization', () => {
    expect(dequantizePeaks([-10, 300, NaN])).toEqual([0, 1, 0]);
  });
});

describe('sanitizePeaks', () => {
  it('returns a valid array with out-of-range values dropped', () => {
    const out = sanitizePeaks([0, 0.5, 1, 1.1, -0.1, NaN, Infinity]);
    expect(out).toEqual([0, 0.5, 1]);
  });

  it('caps the returned array to MAX_VOICE_PEAKS', () => {
    const out = sanitizePeaks(new Array(100).fill(0.5));
    expect(out?.length).toBe(MAX_VOICE_PEAKS);
  });

  it('returns undefined for non-arrays or all-invalid values', () => {
    expect(sanitizePeaks('nope')).toBeUndefined();
    expect(sanitizePeaks(null)).toBeUndefined();
    expect(sanitizePeaks([NaN, Infinity, -1])).toBeUndefined();
  });
});
