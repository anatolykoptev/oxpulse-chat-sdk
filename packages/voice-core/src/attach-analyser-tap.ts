import { sampleLiveBars as sampleLiveBarsMath } from './waveform-math.ts';

export interface AnalyserTap {
  /** Sample the live analyser into the `bars` ring.
   *  Mutates `bars` in place. */
  sampleLiveBars(bars: Float32Array, scratch: Uint8Array, decay?: number): void;
  /** Close the AudioContext. Call BEFORE stopping the MediaStream tracks
   *  to respect the MediaStreamAudioSourceNode teardown ordering. */
  stop(): void;
  /** The underlying AnalyserNode; null when AudioContext is unavailable. */
  readonly analyser: AnalyserNode | null;
}

/** Attach an AnalyserNode tap to the same MediaStream the recorder uses,
 *  so the live composer waveform reflects the audio that will actually ship.
 *  The tap is a separate composable: import it only when live bars are needed.
 *  Returns null when AudioContext is unavailable. */
export function attachAnalyserTap(
  stream: MediaStream,
  opts?: {
    fftSize?: number;
    smoothingTimeConstant?: number;
  },
): AnalyserTap | null {
  const Ctor =
    (typeof window !== 'undefined' && window.AudioContext) ||
    (typeof window !== 'undefined'
      ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined);

  if (!Ctor) {
    return null;
  }

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;

  try {
    audioCtx = new Ctor();
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = opts?.fftSize ?? 1024;
    analyser.smoothingTimeConstant = opts?.smoothingTimeConstant ?? 0.5;
    source.connect(analyser);
    // iOS Safari: ctx may start suspended. Resume; ignore failures.
    void audioCtx.resume?.().catch(() => undefined);
  } catch {
    try { audioCtx?.close(); } catch { /* ignore */ }
    return null;
  }

  function stop(): void {
    // AudioContext MUST be closed before the MediaStream tracks are stopped
    // — the MediaStreamAudioSourceNode must be released first.
    try { audioCtx?.close(); } catch { /* already closed */ }
    audioCtx = null;
    analyser = null;
    source = null;
  }

  function sampleLiveBars(bars: Float32Array, scratch: Uint8Array, decay?: number): void {
    if (!analyser) return;
    sampleLiveBarsMath(analyser, bars, scratch, decay);
  }

  return {
    sampleLiveBars,
    stop,
    get analyser() {
      return analyser;
    },
  };
}
