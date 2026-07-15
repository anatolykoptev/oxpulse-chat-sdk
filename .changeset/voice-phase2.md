---
"@oxpulse/chat-widget": minor
---

Voice Phase 2: adopt @oxpulse/voice-core — VoiceBubble playback, waveform peaks on the wire, #102 flake guard + review-council fixes.

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
  `WaveformTheme` (active from `--oxp-accent`, inactive from a new
  `--oxp-waveform-inactive` token with separate light/dark values audited
  ≥3:1 per WCAG 1.4.11), not voice-core's app-neutral default. Blob-URL
  lifecycle is tracked for eviction/destroy (same backstop as image
  attachments).
- **Review-council fixes (CRITICAL/HIGH/MEDIUM/LOW)**:
  - CSS theme rules for the 5 new voice-bubble classes (row layout, button
    chrome mirroring `.oxp-voice-preview-send/-discard`, responsive canvas,
    `:focus-visible` outlines, 44px coarse-pointer touch targets).
  - Player error-phase: `phase==='error'` disables play + speed, announces
    via an `aria-live` region, shows a ⚠ affordance.
  - Keyboard seek: `canvas.tabIndex=0` + ArrowLeft/Right (±5%),
    PageUp/Down (±10%), Home/End (0/100%) → `player.seek()`, updating
    `aria-valuenow`.
  - i18n: all ARIA strings (play/pause/speed/waveform-seek/error/group)
    routed through `t()` with en + ru keys.
  - Responsive canvas: CSS `width:100%` / `max-width:220px`; backing-store
    set from `clientWidth × DPR` in `renderStaticWaveform`.
  - Re-render leak: `#populateBubble` destroys + untracks the prior
    VoiceBubble for a msgId before the `innerHTML=''` wipe (prevents dead
    player + leaked objectURL + redundant authed fetch on every re-render).
  - Import `FLAT_FALLBACK_PEAKS` from voice-core instead of re-declaring.
  - Delete dead CSS `.oxp-voice-preview-audio` + `.oxp-voice-preview-duration`.
  - `role="group"` wrapper gets an i18n'd `aria-label`.
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
- Bundle: 74.8 KB gzip (budget 250 KB).
