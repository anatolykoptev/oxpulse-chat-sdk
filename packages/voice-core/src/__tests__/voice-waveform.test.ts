// Pure-helper tests for voice-waveform — Canvas2D and
// OfflineAudioContext paths are deliberately not exercised here
// (browser-only; no jsdom audio). Coverage targets the math:
// downsamplePeaks, envelopeStep, xToProgress, sampleLiveBars.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PEAK_BARS,
  downsamplePeaks,
  envelopeStep,
  sampleLiveBars,
  xToProgress,
} from "../waveform-math.ts";

describe("downsamplePeaks", () => {
  it("returns empty for empty input or zero bars", () => {
    expect(downsamplePeaks([], 32)).toEqual([]);
    expect(downsamplePeaks([1, 2, 3], 0)).toEqual([]);
  });

  it("normalizes the global peak to 1", () => {
    const out = downsamplePeaks([0.1, 0.2, 0.5, 0.3], 4);
    expect(out.length).toBe(4);
    expect(Math.max(...out)).toBeCloseTo(1, 5);
  });

  it("uses chunk-max-abs (sign-insensitive)", () => {
    const out = downsamplePeaks([-1, 0, 0.1, 0.2], 2);
    expect(out.length).toBe(2);
    // Both chunks normalized — the first chunk peaks at 1 (|-1|).
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(0.2, 5);
  });

  it("clamps to one-bar-per-sample when bars > samples", () => {
    const out = downsamplePeaks([0.5, 0.25], 10);
    expect(out.length).toBe(2);
  });

  it("respects DEFAULT_PEAK_BARS", () => {
    const samples = new Float32Array(2048).map((_, i) => Math.sin(i / 16));
    const out = downsamplePeaks(samples, DEFAULT_PEAK_BARS);
    expect(out.length).toBe(DEFAULT_PEAK_BARS);
    expect(Math.max(...out)).toBeCloseTo(1, 2);
  });

  it("returns all-zero peaks for an all-zero input", () => {
    const out = downsamplePeaks([0, 0, 0, 0], 4);
    expect(out).toEqual([0, 0, 0, 0]);
  });
});

describe("envelopeStep", () => {
  it("snaps up to a louder target instantly", () => {
    expect(envelopeStep(0.1, 0.8, 0.7)).toBe(0.8);
  });

  it("decays toward a quieter target", () => {
    const next = envelopeStep(1.0, 0.0, 0.7);
    expect(next).toBeLessThan(1.0);
    expect(next).toBeGreaterThan(0.0);
    expect(next).toBeCloseTo(0.7, 5);
  });

  it("converges to target after many iterations", () => {
    let v = 1;
    for (let i = 0; i < 200; i++) v = envelopeStep(v, 0, 0.8);
    expect(v).toBeLessThan(1e-6);
  });
});

describe("xToProgress", () => {
  it("clamps below zero and above width", () => {
    expect(xToProgress(-5, 100)).toBe(0);
    expect(xToProgress(150, 100)).toBe(1);
  });

  it("midpoint maps to 0.5", () => {
    expect(xToProgress(50, 100)).toBe(0.5);
  });

  it("zero-width is safe", () => {
    expect(xToProgress(50, 0)).toBe(0);
  });
});

describe("sampleLiveBars", () => {
  it("shifts left and writes a new envelope value at the tail", () => {
    const bars = new Float32Array([0.5, 0.4, 0.3, 0.2]);
    // Synthetic AnalyserNode — only the methods sampleLiveBars touches.
    const scratch = new Uint8Array(32);
    // All-128 → silence (RMS = 0). Tail decays toward 0.
    scratch.fill(128);
    const fakeAnalyser = {
      fftSize: 32,
      getByteTimeDomainData(buf: Uint8Array) { buf.set(scratch); },
    } as unknown as AnalyserNode;
    sampleLiveBars(fakeAnalyser, bars, scratch, 0.7);
    // Shift: positions 0..2 receive old positions 1..3.
    expect(bars[0]).toBeCloseTo(0.4, 5);
    expect(bars[1]).toBeCloseTo(0.3, 5);
    expect(bars[2]).toBeCloseTo(0.2, 5);
    // Tail snaps up only on a louder signal; silence decays.
    expect(bars[3]).toBeLessThan(0.2);
  });

  it("snaps tail to a loud RMS spike", () => {
    const bars = new Float32Array([0, 0, 0, 0]);
    const scratch = new Uint8Array(64);
    // Square wave at full deflection ≈ RMS 1.0.
    for (let i = 0; i < scratch.length; i++) {
      scratch[i] = i % 2 === 0 ? 0 : 255;
    }
    const fakeAnalyser = {
      fftSize: 64,
      getByteTimeDomainData(buf: Uint8Array) { buf.set(scratch); },
    } as unknown as AnalyserNode;
    sampleLiveBars(fakeAnalyser, bars, scratch, 0.7);
    // RMS ≈ ~127/128 → tail clamped to 1.
    expect(bars[3]).toBeCloseTo(1, 2);
  });

  it("computes RMS over the actual filled length, not stale scratch tail", () => {
    const bars = new Float32Array([0, 0, 0, 0]);
    // Non-power-of-two, larger than the current analyser fftSize.
    // Setting fftSize to this value throws, so only 32 bytes are filled.
    const scratch = new Uint8Array(100);
    scratch.fill(128); // stale silent bytes
    const signal = new Uint8Array(32);
    // 64/192 → ±0.5 deflection, RMS = 0.5, boosted target = 0.9.
    for (let i = 0; i < signal.length; i++) {
      signal[i] = i % 2 === 0 ? 64 : 192;
    }
    const fakeAnalyser = {
      _fftSize: 32,
      get fftSize() {
        return this._fftSize;
      },
      set fftSize(v: number) {
        if (!Number.isInteger(v) || v < 32 || v > 32768 || (v & (v - 1)) !== 0) {
          throw new Error("Invalid fftSize");
        }
        this._fftSize = v;
      },
      getByteTimeDomainData(buf: Uint8Array) {
        buf.set(signal);
      },
    } as unknown as AnalyserNode;
    sampleLiveBars(fakeAnalyser, bars, scratch, 0.7);
    expect(bars[3]).toBeCloseTo(0.9, 2);
  });
});
