# @oxpulse/voice-core

## 0.3.0

### Minor Changes

- 236e387: `readBlobAsDataUrl` is now exported from `@oxpulse/voice-core`'s public
  surface; `@oxpulse/chat-widget` consumes it from there instead of carrying
  a byte-identical private copy (drift-vector dedup). No behavior change.

## 0.2.0

### Minor Changes

- 26fc181: Voice recording: live waveform + Telegram/WhatsApp hold-to-record gesture (burner-parity).

  **@oxpulse/voice-core**

  - `VoiceRecorder` now exposes the live `stream: MediaStream`, so a caller can
    compose `attachAnalyserTap(recorder.stream)` onto the SAME stream the recorder
    ships — driving a live composer waveform without a second `getUserMedia` grant.

  **@oxpulse/chat-widget**

  - The recording chip now paints a **live waveform** as you speak — an analyser
    tap off the recorder's stream feeds `sampleLiveBars` → `renderStaticWaveform`
    at RAF. The chip is redesigned to match the app: pulsing dot, tabular timer,
    live canvas, slide-hint, and a will-cancel red state.
  - New **hold-to-record gesture** (`voice-gesture.ts`): hold the mic to record,
    slide left to lock, slide up to cancel; a quick tap (or mouse click) latches
    locked recording with on-screen Stop/Cancel (WhatsApp tap-to-lock). Keyboard
    Enter/Space starts a locked recording (a11y — pointer gestures aren't
    keyboard-operable).
  - Teardown ordering is enforced: the analyser tap's AudioContext is closed
    before the recorder stops its MediaStream tracks; destroy mid-recording
    releases the mic.
  - i18n: `voiceSlideHint` / `voiceReleaseToCancelHint` (en + ru).

## 0.0.0

Package scaffold and Phase 1 + 1a implementation (private, not yet published).

- Recorder capture-core (`recorder.ts`) with optional injected `extractPeaks`.
- Separate `attachAnalyserTap` composable for live waveform bars.
- Pure `waveform-math.ts` (`downsamplePeaks`, `envelopeStep`, `xToProgress`, `sampleLiveBars`, `quantizePeaks`, `dequantizePeaks`, `sanitizePeaks`).
- Browser `waveform-render.ts` (`extractPeaksFromBlob`, `renderStaticWaveform`).
- Headless `player.ts` (`createVoicePlayer`) with play/pause/seek/speed/subscribe.
- Ported `voice-mime.test.ts` and `voice-waveform.test.ts` plus new `player.test.ts`.
