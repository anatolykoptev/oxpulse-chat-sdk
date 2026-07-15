// @oxpulse/voice-core — public surface.
// All voice primitives are re-exported from the feature modules.

export {
  MAX_VOICE_MS,
  MAX_VOICE_BYTES,
  validateVoiceBlob,
  pickMime,
  createVoiceRecorder,
} from './recorder.ts';
export type {
  VoiceRecorderResult,
  VoiceRecorder,
  ValidateVoiceResult,
} from './recorder.ts';

export { attachAnalyserTap } from './attach-analyser-tap.ts';
export type { AnalyserTap } from './attach-analyser-tap.ts';

export {
  DEFAULT_PEAK_BARS,
  FLAT_FALLBACK_PEAKS,
  MAX_VOICE_PEAKS,
  downsamplePeaks,
  envelopeStep,
  xToProgress,
  sampleLiveBars,
  quantizePeaks,
  dequantizePeaks,
  sanitizePeaks,
} from './waveform-math.ts';

export {
  extractPeaksFromBlob,
  renderStaticWaveform,
  defaultWaveformTheme,
} from './waveform-render.ts';
export type { WaveformTheme } from './waveform-render.ts';

export {
  VOICE_SPEEDS,
  loadStoredSpeed,
  persistSpeed,
  nextSpeed,
  applyRate,
  createVoicePlayer,
} from './player.ts';
export type {
  VoiceSpeed,
  VoiceSource,
  VoicePlayerOptions,
  VoicePlayerState,
  VoicePlayer,
} from './player.ts';
