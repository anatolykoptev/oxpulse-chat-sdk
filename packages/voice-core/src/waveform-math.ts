// Voice-waveform helpers — pure, no DOM.

/** Maximum number of waveform peaks stored on the wire. */
export const MAX_VOICE_PEAKS = 64;

/** Default bar count — 48 fits inside a 220px voice bubble at 3px/bar. */
export const DEFAULT_PEAK_BARS = 48;

/** Downsample an AudioBuffer-style channel array to `bars` bars by
 *  taking the max absolute amplitude inside each chunk and normalizing
 *  the whole array to [0,1] by the global peak. Returns at most `bars`
 *  bars; if `samples.length < bars` returns one bar per sample (also
 *  normalized). Pure — no DOM. */
export function downsamplePeaks(
  samples: ArrayLike<number>,
  bars: number,
): ReadonlyArray<number> {
  if (bars <= 0 || samples.length === 0) return [];
  const n = Math.min(bars, samples.length);
  const chunk = samples.length / n;
  const out: number[] = new Array<number>(n);
  let globalMax = 0;
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * chunk);
    const end = Math.min(samples.length, Math.floor((i + 1) * chunk));
    let max = 0;
    for (let j = start; j < end; j++) {
      const raw = samples[j];
      if (raw === undefined) continue;
      const v = Math.abs(raw);
      if (v > max) max = v;
    }
    out[i] = max;
    if (max > globalMax) globalMax = max;
  }
  if (globalMax > 0) {
    for (let i = 0; i < n; i++) out[i] = out[i]! / globalMax;
  }
  return out;
}

/** Envelope follower step — exponential decay toward a target value.
 *  `decay` ∈ [0,1]; closer to 1 = slower decay. Used by the live
 *  waveform so a sudden quiet section doesn't snap to zero. Pure. */
export function envelopeStep(prev: number, target: number, decay: number): number {
  if (target >= prev) return target;
  return prev * decay + target * (1 - decay);
}

/** Convert an X coordinate inside a waveform canvas to a 0..1
 *  progress fraction. Clamped. Pure. */
export function xToProgress(x: number, width: number): number {
  if (width <= 0) return 0;
  if (x <= 0) return 0;
  if (x >= width) return 1;
  return x / width;
}

/** Sample a live AnalyserNode into a fixed-size bar ring with
 *  exponential envelope decay. Mutates the `bars` array in place so
 *  RAF callers don't allocate per frame. */
export function sampleLiveBars(
  analyser: AnalyserNode,
  bars: Float32Array,
  scratch: Uint8Array,
  decay: number = 0.7,
): void {
  if (analyser.fftSize !== scratch.length) {
    try { analyser.fftSize = scratch.length; } catch { /* fftSize must be POT */ }
  }
  // Cast: lib.dom typings narrow to Uint8Array<ArrayBuffer> in newer
  // TS releases; the runtime accepts any Uint8Array view.
  analyser.getByteTimeDomainData(scratch as unknown as Uint8Array<ArrayBuffer>);
  // RMS over the actually filled portion of the buffer → single envelope
  // sample per frame. If fftSize could not be set to scratch.length, only
  // min(fftSize, scratch.length) bytes are written.
  const n = Math.min(analyser.fftSize, scratch.length);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const raw = scratch[i] ?? 0;
    const v = (raw - 128) / 128;
    sumSq += v * v;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  // Boost a touch — speech RMS sits low.
  const target = Math.min(1, rms * 1.8);
  // Shift left: bars[N-1] is "now".
  const last = bars.length - 1;
  for (let i = 0; i < last; i++) bars[i] = bars[i + 1] ?? 0;
  bars[last] = envelopeStep(bars[last] ?? 0, target, decay);
}

/** Quantize normalized float peaks in [0,1] to uint8 numbers in [0,255].
 *  Caps at MAX_VOICE_PEAKS. The result is a compact byte-budget representation. */
export function quantizePeaks(peaks: ArrayLike<number>): number[] {
  const out: number[] = [];
  const n = Math.min(peaks.length, MAX_VOICE_PEAKS);
  for (let i = 0; i < n; i++) {
    let v = peaks[i] ?? 0;
    if (!Number.isFinite(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    out.push(Math.round(v * 255));
  }
  return out;
}

/** Dequantize uint8 numbers in [0,255] back to normalized float peaks in [0,1].
 *  Caps at MAX_VOICE_PEAKS. */
export function dequantizePeaks(peaks: ArrayLike<number>): ReadonlyArray<number> {
  const out: number[] = [];
  const n = Math.min(peaks.length, MAX_VOICE_PEAKS);
  for (let i = 0; i < n; i++) {
    let v = peaks[i] ?? 0;
    if (!Number.isFinite(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    out.push(v / 255);
  }
  return out;
}

/** Sanitize untrusted peaks from the wire. Returns a valid float[0,1]
 *  array capped at MAX_VOICE_PEAKS, or undefined when the field is unusable.
 *  Invalid individual values are dropped; the field is dropped only when
 *  no valid values remain. */
export function sanitizePeaks(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: number[] = [];
  for (const v of raw) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
      valid.push(v);
    }
  }
  if (valid.length === 0) return undefined;
  return valid.slice(0, MAX_VOICE_PEAKS);
}
