# @oxpulse/voice-core

Shared framework-agnostic voice primitives for OxPulse chat clients.

This package is a shared extraction of the voice recorder, waveform math/render,
AudioContext analyser tap, and headless audio player used by the chat widget and
web app. It is pure TypeScript + Web APIs and has zero runtime dependencies.

> **Private package.** Trusted-publisher OIDC for this package is not configured
> yet, so it is marked `private: true` and kept out of `scripts/release-npm-packages.mjs`.
> It will be published later, once the OIDC bootstrap is complete.

## Public surface

- `recorder.ts` — `createVoiceRecorder`, `pickMime`, `validateVoiceBlob`, `MAX_VOICE_MS`, `MAX_VOICE_BYTES`
- `analyser-tap.ts` — `attachAnalyserTap` for live waveform bars
- `waveform-math.ts` — pure `downsamplePeaks`, `envelopeStep`, `xToProgress`, `sampleLiveBars`, `quantizePeaks`, `dequantizePeaks`, `sanitizePeaks`
- `waveform-render.ts` — browser `extractPeaksFromBlob`, `renderStaticWaveform`
- `player.ts` — headless `createVoicePlayer` with play/pause/seek/speed/subscribe

All public symbols are re-exported from `src/index.ts`.
