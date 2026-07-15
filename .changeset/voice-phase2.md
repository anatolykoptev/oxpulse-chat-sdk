---
"@oxpulse/chat-widget": minor
---

Voice Phase 2: adopt @oxpulse/voice-core — VoiceBubble playback, waveform peaks on the wire, #102 flake guard.

- **Consume voice-core**: chat-widget now imports `createVoiceRecorder`,
  `validateVoiceBlob`, `MAX_VOICE_MS`, `extractPeaksFromBlob`, `sanitizePeaks`
  from `@oxpulse/voice-core`. The duplicate `utils/voice.ts` is deleted;
  `__tests__/voice.test.ts` (a copy of voice-core's recorder test) is removed.
- **VoiceBubble shell** (`ui/voice-bubble.ts`): replaces the bare
  `<audio controls>` for audio attachments in `message-list.ts` and the
  native `<audio>` preview in `composer.ts`. The shell wraps
  `createVoicePlayer` + `renderStaticWaveform` from voice-core, owns the
  hidden `<audio>` element, and wires the player's `source` to the widget's
  authenticated blob loader (`hydrateMediaSrc` / `fetchAttachmentBlob`) —
  never a raw attachment URL on the authed path. The widget supplies its own
  `WaveformTheme` (active from `--oxp-accent`, inactive a low-alpha neutral),
  not voice-core's app-neutral default. Blob-URL lifecycle is tracked for
  eviction/destroy (same backstop as image attachments).
- **peaks[] on the wire**: `EnvelopeAttachment` and `AttachmentMeta` gain an
  optional `peaks?: number[]` (float[0,1], ≤ `MAX_VOICE_PEAKS=64`). On send,
  the composer computes peaks via `extractPeaksFromBlob(blob)`. On receive,
  `sanitizePeaks` clamps/validates peaks during decode — hostile/legacy
  envelopes degrade to a flat fallback waveform.
- **#102 flake guard**: `MessageList.#dispatchError` now checks
  `#signal.aborted` before dispatching, so a post-teardown rejection (an
  in-flight `#fetchAndRender` whose `list()` rejected AFTER `destroy()`
  aborted the signal) does not fire `oxpulse-chat:error` on the torn-down
  container. The `theme.test.ts` case that mounted without a mock client
  now injects one so mount's fetch resolves instead of racing teardown.
- Bundle: 73.7 KB gzip (budget 250 KB).
