---
"@oxpulse/voice-core": patch
---

Voice-core review fixes: WCAG 1.4.11 inactive bar contrast, player error-phase unhandled-rejection loop, recorder test coverage.

- **WCAG 1.4.11**: `defaultWaveformTheme().inactive` raised from `rgba(128,128,128,0.28)` (1.38:1 FAIL) to `rgba(0,0,0,0.55)` (3.15:1 PASS on white, 4.58:1 on #dcf8c6). Models the chat-widget `--oxp-spinner-track` alpha pattern.
- **Player error-phase fix**: `await loadPromise` moved INSIDE `play()`'s try/catch + a `loadFailed` guard so a rejected authed load sets `phase='error'` once and repeated toggles don't re-reject (no unhandled-rejection loop) and don't revert the error phase by calling `audio.play()` on a blank src.
- **FLAT_FALLBACK_PEAKS** exported from `waveform-math.ts` so shells import it instead of re-declaring the literal.
- **Test coverage**: `validateVoiceBlob` reject/accept branches (zero-size, >4MB, zero/negative duration, >60s, boundaries, normal); `createVoiceRecorder` behavior tests (60s auto-cap via fake timers, cancel-stops-tracks-without-resolving, stop-stops-every-track, start→dataavailable→stop yields a blob); player rejected-load → toggle twice → no unhandled rejection, phase=error.
