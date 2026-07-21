# @oxpulse/voice-core

[![npm](https://img.shields.io/npm/v/@oxpulse/voice-core)](https://www.npmjs.com/package/@oxpulse/voice-core)
[![license](https://img.shields.io/npm/l/@oxpulse/voice-core)](./LICENSE)

Framework-agnostic Web Audio primitives for voice messages in OxPulse chat: recorder, live analyser tap, waveform math/render, and a headless player.

This package is pure TypeScript with zero runtime dependencies. It uses browser Web APIs (`MediaRecorder`, `getUserMedia`, `AudioContext`, `OfflineAudioContext`, and `<audio>`), so it is meant for browser or DOM environments.

## Install

```sh
npm install @oxpulse/voice-core@0
# or
pnpm add @oxpulse/voice-core@0
# or
yarn add @oxpulse/voice-core@0
```

## Usage

```ts
import {
  createVoiceRecorder,
  attachAnalyserTap,
  extractPeaksFromBlob,
  renderStaticWaveform,
  createVoicePlayer,
} from '@oxpulse/voice-core';

const recorder = await createVoiceRecorder(extractPeaksFromBlob);
const tap = attachAnalyserTap(recorder.stream); // null when AudioContext is unavailable

// Record, stop, and render the waveform
const result = await recorder.stop();

const canvas = document.getElementById('waveform') as HTMLCanvasElement;
renderStaticWaveform(canvas, result.peaks, 0, {
  active: '#0f0',
  inactive: '#888',
});

const player = createVoicePlayer({ source: result.blob });
const unsub = player.subscribe((state) => console.log(state.phase, state.progress01));
await player.play();
```

Call `tap?.stop()` before `recorder.stop()` if you use the live analyser tap.

## API surface

### Recorder

| Export | Description |
|---|---|
| `createVoiceRecorder(extractPeaks?, opts?)` | Acquire a mic stream and start recording; returns `VoiceRecorder` |
| `VoiceRecorder` | `{ stop(): Promise<VoiceRecorderResult>; cancel(): void; durationMs(): number; readonly stream: MediaStream }` |
| `VoiceRecorderResult` | `{ blob, dataUrl, durationMs, mime, peaks }` |
| `validateVoiceBlob(blob)` | Check size/duration against `MAX_VOICE_BYTES` / `MAX_VOICE_MS` |
| `pickMime()` | Choose the best supported `MediaRecorder` MIME type |
| `readBlobAsDataUrl(blob)` | Read a `Blob` into a `data:` URL |
| `MAX_VOICE_MS` | 60,000 |
| `MAX_VOICE_BYTES` | 4,000,000 |

### Analyser tap

| Export | Description |
|---|---|
| `attachAnalyserTap(stream, opts?)` | Attach an `AnalyserNode` to the recorder's `MediaStream`; returns `AnalyserTap \| null` |
| `AnalyserTap` | `{ sampleLiveBars(bars, scratch, decay?): void; stop(): void; readonly analyser: AnalyserNode \| null }` |

### Waveform math

| Export | Description |
|---|---|
| `DEFAULT_PEAK_BARS` / `MAX_VOICE_PEAKS` / `FLAT_FALLBACK_PEAKS` | Constants |
| `downsamplePeaks(samples, bars)` | Downsample a sample array to `bars` normalized peaks |
| `envelopeStep(prev, target, decay)` | Exponential decay envelope step |
| `xToProgress(x, width)` | Map an X coordinate to a 0..1 progress fraction |
| `sampleLiveBars(analyser, bars, scratch, decay?)` | Sample an `AnalyserNode` into a bar ring |
| `quantizePeaks(peaks)` / `dequantizePeaks(peaks)` | Convert peaks to/from compact `uint8` |
| `sanitizePeaks(raw)` | Validate untrusted peaks from the wire |

### Waveform render

| Export | Description |
|---|---|
| `extractPeaksFromBlob(blob, bars?)` | Decode a `Blob` with `OfflineAudioContext` and return peaks |
| `renderStaticWaveform(canvas, peaks, progress, theme)` | Paint peaks onto a `<canvas>` |
| `defaultWaveformTheme()` | Returns `{ active: 'currentColor', inactive: 'rgba(0,0,0,0.55)' }` |
| `WaveformTheme` | `{ active: string; inactive: string; background?: string }` |

### Player

| Export | Description |
|---|---|
| `createVoicePlayer(options)` | Headless player around an `<audio>` element |
| `VoicePlayer` | `{ play(); pause(); toggle(); seek(progress01); setSpeed(rate); destroy(); subscribe(listener) }` |
| `VoicePlayerOptions` | `{ source: VoiceSource; audio?: HTMLAudioElement; durationMs?: number; speed?: VoiceSpeed }` |
| `VoicePlayerState` | `{ phase, progress01, currentMs, durationMs, speed }` |
| `VoiceSource` | `string \| Blob \| { load: () => Promise<string> }` |
| `VoiceSpeed` | `1 \| 1.5 \| 2` |
| `VOICE_SPEEDS` | `[1, 1.5, 2]` |
| `loadStoredSpeed()` / `persistSpeed(s)` / `nextSpeed(curr)` / `applyRate(el, rate)` | Speed helpers |

## Links

- Repository: <https://github.com/anatolykoptev/oxpulse-chat-sdk/tree/main/packages/voice-core>
- License: [AGPL-3.0-or-later](./LICENSE)
