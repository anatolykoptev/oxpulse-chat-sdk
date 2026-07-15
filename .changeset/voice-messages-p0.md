---
"@oxpulse/chat-widget": minor
---

Voice messages (P0) — record, upload, and play audio attachments.

- **Recording**: `packages/chat-widget/src/utils/voice.ts` adds `createVoiceRecorder`, `validateVoiceBlob`, and `pickMime`.
  - MIME negotiation prefers `audio/mp4` / AAC, falling back to `audio/webm;codecs=opus` and bare `audio/webm`.
  - 60 s hard cap + 4 MB blob validation (same limits as the sibling web app).
  - MediaRecorder `timeslice` 100 ms; `requestData()` flush before `recorder.stop()` to capture the last chunk on Android/WebKit.
  - Auto-stop at `MAX_VOICE_MS` via a timer.
  - iOS `webkitAudioContext` fallback; `AudioContext.close()` is called before `MediaStreamTrack.stop()`.
  - Live waveform/AnalyserNode tap is intentionally dropped for this phase.
- **Composer integration** (`src/ui/composer.ts`):
  - A mic button appears when the client has `uploadAttachment`/`sendAttachmentMessage` and `navigator.mediaDevices` is available.
  - Recording UI replaces the input row with a timer, red dot, stop, and cancel controls.
  - Stop validates the blob and sends the voice attachment through the existing `uploadAttachment` + `sendAttachmentMessage` pipeline.
  - Cancel/destroy stops the recorder and releases the mic.
- **Duration metadata** (`durationMs`) is now supported by `EnvelopeAttachment`/`AttachmentMeta`:
  - Encoded/decoded by `attachment-envelope.ts`.
  - Mapped by `element.ts` (`decodeRowAttachments`).
  - Rendered as `mm:ss` in `message-list.ts` audio attachments.
- **I18n**: new keys `recordVoiceMessageAria`, `recordingLabel`, `stopRecordingAria`, `cancelRecordingAria`.
- **Styling**: new theme classes `.oxp-composer-mic-btn`, `.oxp-composer-recording`, `.oxp-recording-dot`, `.oxp-recording-timer`, `.oxp-recording-stop-btn`, `.oxp-recording-cancel-btn`, `.oxp-attachment-audio-duration`.
