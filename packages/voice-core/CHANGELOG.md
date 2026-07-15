# @oxpulse/voice-core

## 0.0.0

Package scaffold and Phase 1 + 1a implementation (private, not yet published).

- Recorder capture-core (`recorder.ts`) with optional injected `extractPeaks`.
- Separate `attachAnalyserTap` composable for live waveform bars.
- Pure `waveform-math.ts` (`downsamplePeaks`, `envelopeStep`, `xToProgress`, `sampleLiveBars`, `quantizePeaks`, `dequantizePeaks`, `sanitizePeaks`).
- Browser `waveform-render.ts` (`extractPeaksFromBlob`, `renderStaticWaveform`).
- Headless `player.ts` (`createVoicePlayer`) with play/pause/seek/speed/subscribe.
- Ported `voice-mime.test.ts` and `voice-waveform.test.ts` plus new `player.test.ts`.
