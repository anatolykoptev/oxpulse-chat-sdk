# @oxpulse/chat-widget — Changelog

## 0.20.6

### Patch Changes

- 6683f0a: Add optimistic echo for sent messages. Messages now appear instantly in
  the chat list when the user hits send, instead of waiting for the server
  SSE round-trip. The optimistic row is inserted with a client-generated
  msgId; when the server SSE event arrives with the same msgId, the row is
  updated in place (seq, createdAt, etc.).

  Also wires sendTextOptimistic for E2EE consumers (wraps the SDK OptimisticHandle
  into the Promise<{msgId}> the Composer expects).

## 0.20.5

### Patch Changes

- d624a78: Fix reaction quick bar appearing higher than the heart button. The bar
  was anchored to the message bubble element (spanning the whole message)
  instead of the heart button, causing a 75px gap between the bar and the
  heart on hover.

## 0.20.4

### Patch Changes

- 91e89ed: Refactor: deduplicate floating-element positioning logic into shared
  computeFloatingPosition utility. EmojiPicker and ReactionQuickBar both
  had identical fixed-vs-absolute + viewport-clamp code; now both use the
  single utility. Fixes quick bar positioning jump when selecting a heart
  reaction — the bar now anchors consistently to the heart button, not
  the bubble.

## 0.20.3

### Patch Changes

- ea03b00: Hide heart button on hover when caller already has a heart reaction.
  Previously both the reaction chip ("heart N") and the heart button SVG
  were visible on hover, showing two heart icons stacked vertically.
  Now the chip serves as the visible indicator + toggle; the heart button
  reappears when the reaction is removed.

## 0.20.2

### Patch Changes

- de0bf24: Fix emoji picker clipped by widget root overflow:hidden — picker now mounts
  to the shadow root host (position:fixed) when a shadowHost is passed, mirroring
  the ReactionQuickBar MAJOR-5 pattern. Grid with emojis is no longer cut off.

  Fix voice preview send button showing localized text (\"Отправить\"/\"Send\")
  instead of the paper-plane SVG icon — now matches the main composer send button.

## 0.20.1

### Patch Changes

- 0a65c41: Fix CSS parsing bug: .oxp-composer-emoji-btn:hover had no closing brace, causing all subsequent CSS to be nested inside it. Add missing --oxp-surface and --oxp-tint tokens.

## 0.20.0

### Minor Changes

- 740f404: Full threads — thread panel with replies (#126)

  Add a full thread view side panel. Users click a "N replies" indicator on any
  message with thread replies to open a panel showing the root message, all
  replies, and an inline composer for sending new replies. Uses existing SDK
  getThread + sendText(threadRootMsgId) methods.

## 0.19.0

### Minor Changes

- bbed339: Emoji picker — searchable, categorized (#127)

  Add full emoji picker to the composer toolbar. ~180 emojis across 8 categories
  with live search by name + keywords. Zero-third-party-dep (no emoji-mart).
  Keyboard navigation, a11y (role=dialog, Tab trap, Escape), i18n en + ru.

## 0.18.0

### Minor Changes

- b79ac48: Read receipts — checkmarks on own messages (#122)

  Add WhatsApp-style read receipt checkmarks on own message bubbles, driven by
  SSE read_receipt events. Delivered (double ✓ gray) → Read (double ✓ accent).
  Auto-marks incoming messages from others as read. i18n support for en + ru.

## 0.17.0

### Minor Changes

- f3fcab5: Presence overlay — avatar online dots + heartbeat (#121)

  Add green presence dot on avatars for online users, driven by SSE presence
  events. Includes 30s heartbeat interval, initial presence snapshot fetch,
  and 120s freshness window (matches server SDK_PRESENCE_FRESHNESS_SECS).
  i18n support for en + ru.

## 0.16.0

### Minor Changes

- 0e452c3: Typing indicator UI + composer throttle (#120)

  Add animated "X is typing…" footer to the chat widget, driven by SSE typing events.
  The SDK layer (sendTyping, onTyping, SSE routing) was already implemented;
  this adds the widget UI: typing-indicator component, 2s keystroke throttle in
  the composer, i18n (en+ru), and CSS with prefers-reduced-motion support.

### Patch Changes

- Updated dependencies [0e452c3]
  - @oxpulse/chat-sdk@3.0.3

## 0.15.0

### Minor Changes

- 73c08db: Product-card followups (#113, #114, #116, #117):

  - **chat-widget**: Composer now renders a dismissible "product card attached" chip
    when a card is staged via `setProductCard`, mirroring the reply-preview bar
    pattern. The chip's × dismiss calls `clearProductCard()`; the chip is hidden on
    clear and after a successful send. i18n: `productCardAttached` + `removeProductCard`
    in en and ru. Theme CSS mirrors the reply-preview classes.
  - **chat-widget**: New end-to-end test mounts `OxpulseChatElement` with a real
    `SDKChatClient` + fetch mock, calls `setProductCard` + sends, and asserts the
    outgoing POST body carries `product_ref` + `product_meta` through the full
    adapter → SDK → wire path.
  - **chat-sdk**: `rowToMessageRow` now normalizes `product_meta` at the receive
    boundary — requires title/price/currency non-empty strings, caps lengths
    (title 200, price 40, currency 16, urls 2048), coerces bad URLs to '', returns
    null for non-object or invalid payloads. `MessageRow.productMeta` is now honest
    for all SDK consumers.
  - **chat-sdk**: `sendProductCard()` doc-comment documents its role as the public
    external-integrator convenience API and explains why the in-house widget routes
    cards through `sendText()` instead. No behavior change.

### Patch Changes

- 73c08db: Harden the W9 product card (marketplace) feature — review follow-ups to #52.

  - **Bare-card send:** a staged product card now enables the send button and
    rides an empty-text send (the "drop the product in, no caption" marketplace
    flow). Previously `setProductCard` left the send button disabled with an
    empty textarea and `#send` early-returned, so a card could not be sent on
    its own. `setProductCard`/`clearProductCard` now refresh the send state.
  - **Server `product_meta` validation:** `product_meta` is unsealed opaque JSON
    any room peer can POST; the widget now validates + caps it before render.
    A partial (missing title/price/currency), non-object, or oversized value
    degrades to "no card" instead of rendering "undefined" or a multi-MB title
    (layout DoS-lite). Core display fields are required; URLs are length-capped.
  - **Image privacy:** the product-card image now carries
    `referrerPolicy="no-referrer"`, so a peer-controlled `imageUrl` can no longer
    leak the viewer's page URL as a referrer on load.

- Updated dependencies [73c08db]
  - @oxpulse/chat-sdk@3.0.2

## 0.14.0

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

### Patch Changes

- Updated dependencies [26fc181]
  - @oxpulse/voice-core@0.2.0

## 0.13.0

### Minor Changes

- d9dc4ae: Voice Phase 2: adopt @oxpulse/voice-core — VoiceBubble playback, waveform peaks on the wire, #102 flake guard + review-council fixes.

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

## 0.12.0

### Minor Changes

- cbbd8d1: voice pre-send preview: record → review/play → send or discard (no more auto-send on stop); mic/paperclip tooltips

## 0.11.0

### Minor Changes

- 7d888c2: Voice messages (P0) — record, upload, and play audio attachments.

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

## 0.10.0

### Minor Changes

- 950e389: Staged attachment tray + multi-image collage; fixes duplicate paperclip button and immediate-send-on-attach.

  - **BUG-1 fix**: `AttachmentPicker` used to render its own visible 📎 button
    above the composer input (in the pickerContainer slot where the reply
    block sits), duplicating `composer.ts`'s own paperclip trigger. The picker
    now renders only a hidden file input + the staging tray;
    `composer.ts`'s `attachBtn` is the sole trigger.
  - **Stage-then-send**: attaching a file (paperclip/paste/drag-drop) no
    longer sends it immediately. Files are staged in a horizontal-scroll tray
    (64-72px thumbnail cards, object-fit: cover; ✕ removes + revokes the
    objectURL; uploading-spinner overlay; non-image = file-icon + name) and
    uploaded eagerly in the background (upload-on-stage). Hitting send batches
    every `done` staged attachment with the composer's caption text into a
    single `sendAttachmentMessage` call. Send is enabled when there is caption
    text OR at least one staged attachment. A failed upload blocks send
    (awaits then rejects) and keeps the tray so the user can retry/remove.
  - `element.ts`'s attachment pipeline is split into `uploadAttachment`
    (presign + PUT only) and `sendAttachmentMessage` (envelope-encode + send),
    so the attachment id is available before the message is sent. The old
    single-shot `sendFile` composerClient field is **replaced**, not kept as a
    compat wrapper — its only caller (`AttachmentPicker`) now calls
    `uploadAttachment` + `sendAttachmentMessage` directly under the
    stage-then-send model, so a `sendFile` adapter would be unreachable dead
    code once this ships. This is internal to the widget's own composerClient
    wiring, not a public export — chat-sdk's own unrelated `sendFile()`
    convenience wrapper is untouched.
  - **Multi-image collage** (`message-list.ts`): a message whose attachments
    are all images and length > 1 renders as a collage grid instead of
    stacked bubbles — N=2 (two 1:1 columns), N=3 (2fr/1fr with a
    row-spanning hero tile), N=4 (2x2, 3:2 tiles), N>=5 (2x2, the fourth tile
    blurred with a `+{N-3}` overlay). Mobile (<=640px) forces every tile to a
    1:1 square. Ratios/behavior verbatim from the fluxer reference
    (`fluxerapp/fluxer@2896b18` `AttachmentLayoutGrid`), scaled down (no full
    N-tile mosaic — the widget iframe is narrow and each tile is an
    authenticated blob fetch via the existing `hydrateMediaSrc`).

  MAX_ATTACHMENTS=10 (existing envelope cap) is enforced at stage time via
  `oxpulse-chat:error`.

## 0.9.0

### Minor Changes

- cbd082d: attachments wired end-to-end: paperclip/paste/drag now live; client-side WebP compression + dimension capture (closes #67)

  - Root cause: the widget's attachment subsystem (paperclip, paste, drag-drop,
    `AttachmentPicker`, `compress()`/`thumbnail()`, dimension-aware rendering)
    was fully built but never wired — `composer.ts`'s gate
    (`typeof this.#client.sendFile === 'function'`) never opened because the
    widget's composerClient never exposed a `sendFile`, and `chat-sdk`'s own
    `sendFile()` convenience wrapper presigns an attachment, uploads the blob,
    then discards the presigned `attachmentId` when it calls `client.send()` —
    so an uploaded attachment was structurally unlinked from any message, on
    both the write and read side.
  - `element.ts`'s composerClient now drives `presignAttachment()` + PUT +
    `send()` directly (bypassing that convenience wrapper), encoding the
    attachment id/mime/filename/dimensions into the plaintext message body via
    a small versioned envelope (`utils/attachment-envelope.ts`) — the same
    "app-level metadata rides the plaintext payload" convention this widget's
    product-card feature already established with `productRef`/`productMeta`.
    Zero `@oxpulse/chat-sdk` changes; only its already-exported
    `presignAttachment` (`@oxpulse/chat-sdk/attachments`) and `send()` are used.
  - Read side: rows are decoded back through the same envelope before reaching
    `MessageList`, so any room member (not just the sender) sees
    `row.attachments` populated and renders the image/audio/file bubble with
    correct `width`/`height` (closes the aspect-reservation gap tracked by
    issue #67). A plain-text message that doesn't match the envelope shape is
    untouched — fully backward compatible with every existing message.
  - The attachment GET route is JWT-authenticated (`Authorization: Bearer`
    only — no signed query-token the way the presigned PUT URL has), so a bare
    `<img src>`/`<audio src>` would 401 for every viewer once wired against a
    real server. `MessageList` now hydrates image/audio attachment `src` via an
    authenticated `fetchAttachmentBlob` + `blob:` object URL (revoked on
    `destroy()`) when the client supports it; falls back to the direct URL
    otherwise (existing behavior, e.g. test doubles).
  - `AttachmentPicker` now runs the existing `compress()` (WebP/JPEG,
    1920px long-edge, decompression-bomb guard) for `image/*` files before
    upload and threads the resulting width/height into the attachment
    descriptor. Non-image files pass through unchanged.

  Closes #67.

### Patch Changes

- eb34381: reaction quick-bar Escape no longer leaks to the host page; heart/quick-bar buttons hit 44px on more coarse-pointer devices

  - `ReactionQuickBar`'s Escape handler called `preventDefault()` but the
    event still propagated to `window` — a host page's own global Escape
    listener (e.g. an embedder that unmounts the whole chat on window keydown
    Escape) fired even though the user only meant to close the bar. The
    document-level keydown listener (live only while the bar is open) now
    also calls `stopPropagation()`. A closed bar still lets Escape through to
    the host normally.
  - `.oxp-reaction-heart-btn` / `.oxp-reaction-quick-bar-button` touch
    targets measured 26x22px live on a touch device despite the existing
    `@media (hover: none)` 44px rule — some touch/hybrid devices report
    `hover: hover` while still being `pointer: coarse`. Widened the same
    media condition to `@media (hover: none), (pointer: coarse)` instead of
    adding a duplicate block.

  Found in live design review of widget 0.8.0 on the starthey demo.

## 0.8.0

### Minor Changes

- 05096fe: reactions: heart-first quick-bar replaces the '+😀' button + two-step popover.

  - Each bubble gets a heart button (outline/filled SVG) — hover-revealed on
    desktop, always visible on touch, focusable for keyboard/SR. A plain
    tap/click/Enter/Space instantly toggles ❤️ (add / remove / replace-to-heart
    via `#selectReaction`, reusing the existing optimistic-mutation +
    rollback-to-snapshot pattern). A ≥400ms press-and-hold (touch/pen) or a
    ≥400ms hover-intent on the button itself (mouse) or ArrowUp opens the full
    6-emoji `ReactionQuickBar` (renamed from `ReactionPicker`), which keeps its
    keyboard nav, per-emoji stagger-in / select-burst animation (reduced-motion
    gated), outside-dismissal, and shadow-host mount.
  - Telegram/WhatsApp-style single-reaction replace, client-enforced against a
    Slack-model idempotent per-(user,emoji) server: selecting a second emoji
    while already owning one removes the old reaction then adds the new one
    (one pre-mutation snapshot, rollback on either leg's failure).
  - Own-emoji marked in the bar (aria-pressed + accent ring); the heart button
    mirrors the same own/❤️ state and gets a one-shot pulse on a successful add.
  - Bar placement (above/below flip, right-edge anchor for the caller's own
    messages) and long-press timing/gating, outside-dismissal (capture-phase
    pointerdown), and focus-restore (deferred to a microtask) are ported from
    oxpulse-chat web's prod, unit-tested primitives:
    `web/src/lib/chat/list/usePopover.svelte.ts`,
    `web/src/lib/chat/reactions/message-actions-helpers.ts::computePopoverPosition`,
    `web/src/lib/chat/reactions/MessageActions.svelte`'s dismissal pattern, and
    `web/src/lib/chat/list/Bubble.svelte`'s heart-pulse keyframe.
  - Gated behind `reactionsEnabled` + `client.sendReaction`, same as before.

### Patch Changes

- 42e4999: write 401 fires token-expired + delays optimistic rollback for host refresh; write-failure telemetry event

  - A write op (`sendReaction`/`removeReaction`/composer `sendText`) failing
    with an auth error (401/403, `unauthorized`/`forbidden` code) now fires
    the SAME `oxpulse-chat:token-expired` signal + `onTokenExpired` callback
    the subscribe path already used — previously a write-401 silently rolled
    back with only a `console.warn`, and the host never learned the JWT had
    expired.
  - Reaction rollback on an auth-expired write is delayed
    (`WRITE_AUTH_ROLLBACK_DELAY_MS`, 3s) instead of immediate: a host that
    refreshes the `jwt` attribute quickly re-bootstraps the widget (tearing
    down the in-flight `MessageList`) before the delay elapses, so the chip
    never flashes away and back. Non-auth failures still roll back
    immediately (unchanged). The timer is cleared on `destroy()`.
  - New failure-counter hook: `WidgetConfig.onWriteError({op, reason})` fires
    on every write failure (not just auth), and the existing
    `oxpulse-chat:write-error` event's `WidgetError` detail now carries
    `op`/`reason` fields — extended, not a new event. Dispatch is no longer
    scoped to the named-write path only; any composer send failure reports.
  - `isAuthError()` now understands the raw `SDKChatError` shape
    (`statusCode`/`code`) directly, removing a hand-rolled normalizer that
    would otherwise have been copied a 2nd and 3rd time into the reaction and
    composer write paths.

  Closes #78.

## 0.7.1

### Patch Changes

- a14ec58: a11y: timestamp + product-price on-bubble contrast token; keep scroll pinned when composer resizes (reply bar toggle).

  - Fix WCAG 1.4.3 contrast failure on `.oxp-bubble-time` (message timestamp, every
    message, both themes — measured live 3.99:1 light / 4.27:1 dark at 11.2px, needs
    4.5:1) and `.oxp-product-price` (same latent `--oxp-muted`-on-tinted-bg issue inside
    the in-bubble product card). Both now use `--oxp-fg-secondary`, this file's own
    designated on-bubble text token (already ≥4.5:1 on all four self/other ×
    light/dark bubble backgrounds).
  - Fix a scroll-desync bug: toggling the reply-preview bar resizes the composer (a
    sibling of the message list in the widgetRoot flex column), shrinking the list's
    own clientHeight without moving `scrollTop` — the newest message clipped by the
    resize delta and only self-healed on the next appended message. `MessageList` now
    observes its own scroll container's resize and re-pins to bottom when the reader
    was pinned before the resize; a reader scrolled up to read history is left alone.

- e9d86d1: a11y: reply-preview contrast token + role=status; product-card contract docs + sendText type parity.

  - Fix WCAG 1.4.3 contrast failure on reply-body preview text: `.oxp-composer-reply-body`
    and `.oxp-bubble-reply-body` now use `--oxp-fg-secondary` instead of `--oxp-muted`
    (light ≈4.2:1, dark ≈2.95:1 — both below the 4.5:1 AA floor). Matches the sibling
    `-label`/`-sender` selectors already on this token.
  - Change the reply-preview bar from `role="region"` to `role="status"` (implicit polite
    live region) so it no longer announces as a persistent landmark that flickers in and
    out with every reply.
  - Document `ProductMeta.price` as host-pre-formatted display text (the widget renders
    `${price} ${currency}` verbatim, no `Intl.NumberFormat`).
  - Document that `setProductCard()` metadata travels unsealed on the wire and is
    server-visible even in E2EE rooms (by design, mirrors `sendProductCard`).
  - Add `productRef`/`productMeta` to `WidgetConfig.client.sendText` for type parity with
    `element.ts`'s `composerClient`.
  - Add an element-level test exercising the public `el.setProductCard()` wrapper end to
    end (previously only the inner `Composer.setProductCard()` was covered).

- Updated dependencies [ba359e1]
  - @oxpulse/chat-sdk@3.0.1

## 0.7.0

### Minor Changes

- a0bc48d: Fix live reaction updates: `MessageList` now re-fetches `getReactions` when the SSE `reaction` event omits a reliable `totalCount`, instead of trusting `totalCount: 0` and hiding chips. Add a `reactions-enabled` attribute / `reactionsEnabled` config to disable the reaction UI (hides the trigger button, reaction clusters, and live `onReaction` subscription). Route `sendReaction`/`removeReaction` through the `effectiveSendClient` so named-write / allow-write paths use the correct JWT.

## 0.6.3

### Patch Changes

- Move the composer send button to the right of the input field and replace the text label with a paper-plane icon. Remove the input focus outline ring, keeping the border-color change as the focus state. The attachment button and character counter remain as row/secondary controls.

## 0.6.2

### Patch Changes

- Fix message list not pinned to bottom on initial load.

  `MessageList` was mounted and scrolled to the bottom before `Composer` was
  added to the widget root, so the scroll container had the full widget height
  instead of the composer-shrunken height. After the composer mounted, the list
  stuck partway up and new messages stopped auto-scrolling. Mounting the
  composer before `MessageList` gives the scroll container its final height when
  `scrollToBottom` runs.

## 0.6.1

### Patch Changes

- 38a3c8f: Fix reply preview bar visibility when hidden.

  The `[hidden]` attribute on `.oxp-composer-reply` was being overridden by the
  class's `display: flex` style, so the empty reply preview was visible even when
  no reply target was set. Added a shadow-DOM `[hidden] { display: none !important; }`
  rule so `hidden` always wins over component display styles.

## 0.6.0

### Minor Changes

- ac9f91e: Add thread reply support to the chat widget. The `MessageList` now renders a reply button on each message and a compact quote preview for messages with `threadRootMsgId`. The `Composer` exposes `setReplyTarget()` to preview the message being replied to and sends with `threadRootMsgId` populated. Includes i18n (`en`/`ru`) and theme styles for touch and desktop.

## 0.5.0

### Minor Changes

- 779bf9f: feat: roster avatar_url + display name end-to-end

  `GET /api/sdk/roster` now returns an additive `avatars` map alongside `roster`.
  `fetchRoster` parses it and returns `Map<epid, RosterEntry>` (`{ displayName,
avatarUrl }`) instead of `Map<epid, string>`. `rosterDisplayName(map, epid)` is
  unchanged; new `rosterAvatar(map, epid): string | null`. The widget renders a
  leading avatar (image with an initials-circle fallback, deterministic color per
  epid) beside other writers' messages; own messages are unchanged.

  BREAKING (@oxpulse/chat-sdk): code reading the raw roster map value as a string
  must switch to `rosterDisplayName(map, epid)` / `rosterAvatar(map, epid)` (or read
  `.displayName` / `.avatarUrl`). The HTTP response is backward-compatible — the
  `roster` name map is unchanged and `avatars` is purely additive, so a widget
  built against the old response keeps working.

- 6c59dcb: feat: roster role badge (moderator/owner)

  `GET /api/sdk/roster` now returns an additive, sparse `roles` map alongside
  `roster`/`avatars` (only privileged members appear; a plain `member` is
  implied by absence). `fetchRoster` parses it into `RosterEntry.role?:
"moderator" | "owner"`; new `rosterRole(map, epid): PrivilegedRole |
undefined`. An unrecognised role string fails closed (no role, no badge).

  The widget renders a small badge ("mod" / "owner" by default) next to a
  privileged member's name for other writers' messages (own messages are
  unchanged, mirroring the avatar convention). New widget config option
  `roleLabels?: Record<string, string>` lets partners rebrand the badge text
  (e.g. `{ moderator: "Seller" }`) — presentation only, never client-side
  authorization.

  Fully additive and backward-compatible: a server response with no `roles`
  key (old engine) parses with `role` `undefined` on every entry, and the
  badge simply does not render.

- 601f154: W9: render product cards in the widget and wire them through the Composer.

  - Add `ProductMeta` type and `OxpulseChatElement.setProductCard(ref, meta)` API.
  - `Composer` forwards `productRef`/`productMeta` to `sendText`/`sendTextOptimistic`.
  - `MessageList` renders a clickable product card preview (image, title, price, link) when a row has `productRef` + `productMeta`.
  - Add i18n key `productViewAria` and theme CSS for `.oxp-bubble-product`.

### Patch Changes

- 98df8ff: Fix unbounded DOM/memory growth in the live message stream: `MessageList` now caps the live-streamed window at `MAX_LIVE_MESSAGES` (300), evicting the oldest messages — from internal bookkeeping and the DOM — once a live append crosses the cap. Previously every live message was appended with no eviction, so a visitor keeping a product-page tab open through a busy period (e.g. a high-traffic central chat room) accumulated unbounded DOM nodes.

  Eviction is two-tiered. While the user is pinned to the bottom, every live append trims to the 300-message soft cap — invisible to them, since they're not looking at the top. While scrolled up reading history, eviction is skipped up to a much higher hard ceiling (600) so an actively-reading visitor never gets content yanked out from under them mid-read; only a session that piles up 600+ messages while permanently scrolled away (the "walk away and never come back to bottom" case) gets trimmed down to that ceiling. Without the hard ceiling, that walk-away session was still genuinely unbounded — caught in review before merge.

  This is a safety cap on the live window only — full scroll-back virtualization (for paging through evicted history) is a separate future feature once "load older" pagination UI exists.

- 2597744: Fix self/other bubble alignment when no `self-uid` attribute is set: the widget now falls back to the JWT `sub` claim, so the visitor's own messages align right (messenger-standard) out of the box. An explicit `self-uid` attribute still wins. Display-side only — the server never trusts this value.
- Updated dependencies [779bf9f]
- Updated dependencies [6c59dcb]
  - @oxpulse/chat-sdk@3.0.0

## 0.4.1

### Patch Changes

- ddbab29: docs: republish so npm-displayed READMEs match shipped reality

  npm serves a package's README from the tarball snapshot taken at publish time, so
  the source-tree doc fixes do not reach npmjs.com until the next published version.
  This patch bump republishes all three packages so their npm pages show current docs:

  - chat-sdk: version badge 1.0.0 → 2.0.0; document the SEC-CR-001 downgrade-defense
    default-on behaviour + cryptoMode option; correct the batchAppend example (was
    documenting the internal snake_case wire DTO, not the exported camelCase
    BatchAppendItem — old example would not type-check); fix the error-code table
    (server_5xx → server_error, add the crypto-mode/unsupported codes); add the
    edited/deleted MessageRow fields; fix a dangling ../../LICENSE link.
  - wire-codec: drop the stale "private: true / no publish pipeline" claims (the
    package is public on npm via the changesets+OIDC pipeline); document the 0xC9
    mesh-bundle-v1 API + magic byte.
  - chat-widget: carry the CDN version/SRI/npm-install README fixes (already in the
    source tree) onto npm.

- Updated dependencies [ddbab29]
  - @oxpulse/chat-sdk@2.0.1

## 0.4.0

### Minor Changes

- def28fc: feat(T18): widget roster consumption — display names for other writers

  - SDK: new `fetchRoster()` helper fetches `GET /api/sdk/roster` with SDK JWT
  - SDK: new `rosterDisplayName(roster, epid)` with 8-char short-form fallback
  - SDK: `SubscribeArgs.onRosterSignal` callback — fires on `type:"roster"` SSE signal
  - SDK: `mintNamedWriteToken` alg-pin guard — rejects tokens with alg≠EdDSA returned by the mint endpoint (defense-in-depth; server enforces EdDSA at exchange, client now enforces at receipt)
  - Widget: MessageList fetches roster on mount and re-fetches on `type:"roster"` SSE invalidation signals (100ms debounce)
  - Widget: element adapter now forwards `onRosterSignal` to `sdkClient.subscribe` (was silently dropped — the re-fetch end-to-end path was broken)
  - Widget: bubbles show roster display names for other writers; own messages show "You"
  - Widget: XSS-safe — roster names use textContent only, never innerHTML (SEC-CR-003 / FF3)
  - CI: FF6 alg-pin — `mintNamedWriteToken` rejects alg:none and alg:HS256 tokens (real production guard, red-on-revert)
  - CI: issuer-disjointness (FF5) — server-enforced invariant; client-side tautology removed; server tests own it

- 8d2d10f: feat(chat-widget): add a real i18n layer — wire the `lang` option through a locale table (en + ru)

  `lang` (constructor option / `lang` attribute, BCP-47) has been accepted since W2.1 but was
  never read for strings — every user-facing string was hardcoded English regardless of `lang`
  (`MessageList` even hardcoded `lang: config.lang ?? 'en'` internally, dropping the option's
  own value). oxpulse's userbase is heavily Russian-speaking (see the ITALIC_RE Cyrillic fix
  in this same package), so RU users saw an all-English widget.

  Adds `src/utils/i18n.ts`: a plain `Record<Locale, Record<LocaleKey, string>>` table (`en`
  source-of-truth + a fully-translated `ru`) + a `t(key, lang, params?)` lookup with `{name}`
  placeholder substitution and a `resolveLocale(lang?)` helper (`lang` → `navigator.language`
  prefix → `'en'`). No new dependency — the widget is zero-dependency by design and the CDN
  bundle is size-budgeted (`esbuild.cdn.mjs` FF-1 gate, 250 KB gzip); this adds ~2 KB gzip
  (52.4 KB → 54.4 KB), nowhere near the ceiling.

  Every hardcoded string across the widget's UI surface is now routed through `t()` /
  `resolveLocale()`, each class storing its own resolved `#lang` at construction (`lang?`
  optional everywhere, defaulting via `resolveLocale()`, so no existing construction call site
  breaks):

  - `MessageList` — tombstone, unseal-error (visible + aria, U2's screen-reader-only variant
    kept glyph-free), the bubble's composed `aria-label`, "You" sender label, "Add reaction" /
    "Reactions" group / reaction-count aria (RU gets correct 1/2-4/5+ grammatical plural forms,
    not just an English-style singular/plural split), attachment aria-labels (Image/Audio/
    File/Attachment-unavailable), and the list-error Retry button.
  - `Composer` — placeholder default (an explicit `placeholder:` option still wins), all
    aria-labels, Send button text, the empty/sending/over-limit hints, the character counter,
    and the error-chip Retry button.
  - `AttachmentPicker` — both aria-labels, the upload-progress `aria-valuetext`, the live-region
    announcements (uploading/uploaded/failed), the queue summary, and the retry/cancel controls.
  - `ReactionPicker` / `reaction-types.ts` — "Choose reaction" and the per-emoji aria-label map.
  - `Reconnector` — every banner state (session-expired, reconnecting w/ attempt count,
    connected, gave-up) and its action button + aria-label.
  - The element's "Chat loading…" placeholder.

  Left deliberately English: dynamic runtime error text (`Composer`'s error chip,
  `MessageList`'s list-error banner, the element's `#renderError`) — these render an
  `Error.message` from a thrown exception (network/SDK/server text), not authored UI copy we
  control; localizing them would mean translating arbitrary upstream error strings. Emoji
  glyphs, byte-size units (`KB`), and `HH:MM` time formatting are also left as-is — not prose.

  Regression: 465 pre-existing tests stay green (every EN string is byte-identical to what
  shipped before); default (no `lang`) behavior is unchanged. 51 new tests added: a RED→GREEN
  proof (`list-helpers.test.ts` fails against pre-wire-in `main` for every `lang:'ru'`
  assertion, passes after), `i18n.test.ts` (lookup/fallback/interpolation unit tests), and RU
  integration coverage across `MessageList`/`Composer`/`Reconnector`/`AttachmentPicker`/
  `reaction-types`.

- f06ed8b: feat(chat-widget): in-place token refresh via origin-pinned postMessage (no remount)

  `element.refreshToken(jwt)` no longer tears the widget down and rebuilds it to apply a
  fresh JWT. In **iframe mode** it now posts the new token to the LIVE iframe over an
  origin-pinned `postMessage` (`{ type: 'refresh-token', jwt }`) and the iframe swaps the
  session token IN PLACE — the SSE stream, scroll position and decrypt state survive, so
  there is no flicker, reconnect or lost scroll on a routine token rotation. When there is
  no live iframe to post to (inline mode, or the iframe is not yet ready) it gracefully
  falls back to the existing re-bootstrap path, so a refresh never silently no-ops. Inline
  mode still re-bootstraps by design: its `SDKChatClient` holds its JWT in a `readonly`
  field and can only be re-authed by reconstruction.

  **Security hardening (behavior change):** `sendRefreshTokenToIframe` no longer falls back
  to the `'*'` wildcard target origin. It now requires an EXPLICIT target origin (the
  resolved widget `baseUrl`, the same concrete origin the init path posts to); if none is
  available the bearer JWT is dropped with a `console.warn` rather than broadcast to any
  origin — mirroring `sendToParent`'s "never send with '\*'" (M1) discipline. The iframe-side
  receiver applies a `refresh-token` only from inside the existing fail-closed
  `onParentMessage` origin gate (M2), so a refresh-token from an unexpected origin is dropped.

  Bumped `minor` (→ `0.4.0`) rather than `patch`: this changes the refresh behavior consumers
  observe (no remount) and the `sendRefreshTokenToIframe` signature (an explicit origin is now
  required, no `'*'` default), so it sits outside the `^0.3.1` caret range and requires an
  explicit consumer opt-in.

### Patch Changes

- 29b5d83: fix(chat-widget): Unicode-aware ITALIC_RE word-boundary (Cyrillic snake_case) + drop dead postMessage helper

  `renderMarkdown`'s italic regex used a doubled-backslash character class `[\\w]` (= the literal set
  `{backslash, 'w'}`) instead of the `\w` word-char escape, disabling the word-boundary guard entirely —
  any snake*case-flanked underscore, e.g. `a_hi_b`, was wrongly wrapped in `<em>`. Fixed to a proper `\w`
  lookaround, then found that `\w` (no `/u` flag) only matches `[A-Za-z0-9*]` — Cyrillic letters aren't
word chars to JS regex, so a plain-`\w`fix is a no-op for Cyrillic snake_case (this SDK's primary
userbase is Russian-speaking):`тестовый*юзер*профиль`still wrongly italicized. Final fix uses`\p{L}\p{N}_`with the`/u`flag — Unicode-aware, verified for both ASCII and Cyrillic snake_case,
still italicizes a normal whitespace-bounded`\_word_`.

  Also deletes the dead `sendInitToIframe` postMessage helper (zero callers repo-wide, not re-exported,
  defaulted `targetOrigin` to `'*'` — contradicted the file's own M1 "never send with `*`" invariant).
  `element.ts` already hand-rolls its own safe inline init postMessage; this helper was stranded.
  `sendRefreshTokenToIframe` is untouched (rebuilt with an explicit origin in the upcoming U1 task).

- 85e5fdc: fix(chat-widget): render failed-decrypt messages with a distinct state (unsealError)

  `@oxpulse/chat-sdk`'s decrypt path already PRESERVES a message row whose `unseal()` call
  fails (`MessageRow.unsealError: 'replay' | 'auth' | 'unknown'`) instead of dropping it —
  but `MessageList` never read that marker, so a failed-decrypt row rendered as an empty
  message bubble, visually indistinguishable from a real one.

  `MessageList` now renders a distinct `.oxp-unseal-error` placeholder (a lock glyph + "This
  message couldn't be decrypted") in place of the empty body whenever `unsealError` is set,
  and the bubble's `aria-label` announces the same text instead of an empty string. A row
  with both `deletedAt` and `unsealError` set renders as the tombstone in both the visible
  body and the `aria-label` (priority matches the existing deleted-message precedent) so a
  screen reader never announces a different state than what's shown.

  Render-side only — does not touch `chat-sdk`'s unseal/decrypt logic.

- Updated dependencies [917c97a]
- Updated dependencies [ce7863f]
- Updated dependencies [78d7327]
- Updated dependencies [f3e9c7f]
- Updated dependencies [e3a31ed]
- Updated dependencies [def28fc]
  - @oxpulse/chat-sdk@2.0.0

## 0.3.1

### Patch Changes

- fix(ui): pin the composer to the bottom of the widget. The flex rule
  targeted `.oxp-message-list` (the inner list element) but the growing
  child is the `.oxp-message-list-wrapper` div (element.ts), which stayed
  at `flex-grow:0` and collapsed to content height — so the composer rode
  up under the last message, leaving dead space below on tall / mobile
  fullscreen hosts (e.g. /biz/demo at 390px). Added `flex:1` + column to
  the wrapper. CDN hotfix published as `widget/0.3.1/`; the pending T18
  roster changeset still lands the next minor (0.4.0).

## 0.3.0

### Minor Changes

- 8663ace: add allow-write (named-write) mode to chat widget (inline mode only)

  Adds `allowWrite` / `allow-write` config to `<oxpulse-chat>` and `mount()`. When
  enabled, the widget mints a named-write JWT from the host page's own backend
  (`writeMintEndpoint`) and renders a compose UI (input + send button) for
  `mode:'inline'` (shadow DOM). Without `allowWrite` the widget stays read-only
  (no behaviour change from previous releases).

  Note: `mode:'iframe'` named-write support is not yet implemented (W5). Setting
  `allowWrite:true` with `mode:'iframe'` logs a console warning and the compose UI
  is not shown.

  New `WidgetConfig` fields:

  - `allowWrite?: boolean` — enable named-write compose UI (default: false)
  - `writeMintEndpoint?: string` — URL of the host's named-write mint endpoint
  - `_mintNamedWriteToken?` — test-only injectable mint override

  New HTML attributes on `<oxpulse-chat>`:

  - `allow-write` (boolean)
  - `write-mint-endpoint` (string)

  New events on `<oxpulse-chat>`:

  - `oxpulse-chat:message-sent` — fires after a successful send `{ roomId, msgId }`
  - `oxpulse-chat:write-error` — fires on non-recoverable write failures

  New `WidgetErrorCode` values:

  - `WRITE_MINT_FAILED` — emitted when the write-token mint request fails
  - `WRITE_SEND_FAILED` — emitted via `oxpulse-chat:write-error` when a named-write send fails

  The write token is kept separate from the read JWT (different capability level).
  `allow-write` can be combined with `allow-anon-read` — the widget creates two SDK
  clients: one for reading (anon or authed JWT), one for writing (named-write JWT).

  Minimal host integration:

  ```html
  <oxpulse-chat
    app-id="YOUR_APP_ID"
    room-id="event-room-slug"
    allow-anon-read
    allow-write
    write-mint-endpoint="/api/oxpulse-write-token"
  >
  </oxpulse-chat>
  ```

  Backend mint endpoint shape:

  ```
  POST /api/oxpulse-write-token
  Body:    { room_id: string }
  Returns: { token: string }   // named-write SDK JWT from OxPulse group-grant-mint
  ```

### Patch Changes

- Updated dependencies [b04592b]
  - @oxpulse/chat-sdk@1.6.0

## 0.2.0

### Minor Changes

- 161abae: client-side anon-read: `mintAnonReadToken` + widget `allow-anon-read` mode

  **@oxpulse/chat-sdk**: adds `mintAnonReadToken(opts)` helper that POSTs to
  `/api/sdk/auth/anon-read-mint` and returns a short-lived read-only JWT.
  Throws `AnonReadMintError` (with `.code` and `.status`) on non-2xx responses.
  Both are exported from the package index.

  **@oxpulse/chat-widget**: adds `allow-anon-read` boolean attribute (presence =
  true) and `base-url` attribute to `<oxpulse-chat>`. When `allow-anon-read` is
  present and no `jwt` attribute is set, the widget automatically mints an anon
  token, mounts in read-only mode (composer hidden), and schedules a re-mint 30 s
  before the 300 s token expiry. When `jwt` is provided, the existing authed path
  is unchanged. Includes injectable `_mintAnonReadToken` DI hook for tests.

### Patch Changes

- Updated dependencies [161abae]
  - @oxpulse/chat-sdk@1.5.0

## [0.1.1] — 2026-05-19 — Security hardening (PR #1142 code review fixes)

### Security fixes (MAJOR)

- **M1** postMessage: `sendToParent()` no longer targets `'*'` — requires explicit parent
  origin via `setParentOrigin()`, set from `?origin=` query param on iframe load.
  Messages are dropped with a warning if origin is not initialised.
- **M2** postMessage: `onParentMessage()` now reads `?origin=` from iframe URL and
  rejects `MessageEvent` whose `event.origin` does not match — prevents adversarial
  init from untrusted frames.
- **M3** Callbacks wired: `onTokenExpired` and `onError` config callbacks now fire.
  `oxpulse-chat:token-expired` dispatched on JWT_EXPIRED; `oxpulse-chat:error` on all
  other errors (ORIGIN_NOT_ALLOWED, JWT_MALFORMED, etc.).
- **M4** Origin-match parity with `crates/sdk/src/origin_match.rs` (W1.1):
  - Case-insensitive matching
  - Subdomain wildcard (`*.example.com` bare or `https://*.example.com`) is https-only,
    single-level only
  - Port wildcard (`http://localhost:*`) requires actual port — no-port does NOT match
  - Malformed allowlist entries warn + deny (deny-loud)
- **M5** `aud_origins` missing → **default DENY** (was silent pass-through).
  Set `allowLegacyToken: true` on `WidgetConfig` to opt-in to pre-W1.1 token compat.
- **M6** iframe mode now creates a real sandboxed `<iframe>` inside the shadow root.
  `sandbox="allow-scripts allow-same-origin"` is enforced. `?origin=` query param
  included in iframe src for M1/M2 handshake.

### Minor improvements

- `decodeJwtPayload()` now checks the `exp` claim and throws `JWT_EXPIRED` if past.
- `refreshToken()` forces re-bootstrap even when JWT value is unchanged.
- `WidgetConfig.allowLegacyToken` (boolean, default false) added for legacy token compat.

---

## [0.1.0] — 2026-05-19 — Skeleton release

Skeleton для `<oxpulse-chat>` Custom Element + iframe embed mode.

### Added

- `<oxpulse-chat>` Custom Element (attributes: app-id, jwt, room-id, mode, theme, lang)
- Programmatic `mount(target, config)` API
- `defineElement()` для explicit registration
- iframe-mode + postMessage protocol (typed)
- Bootstrap origin check via JWT `aud_origins` claim
- `WidgetError` + `OriginNotAllowedError` typed error classes
- Type guards: `isParentMessage()` / `isIframeMessage()` — reject malformed payloads

### Not yet (planned W2.2)

- UI components (message list, composer, reactions)
- Theme system (CSS custom properties)
- Mobile-responsive layout
- a11y / keyboard nav
- Token refresh reconnect logic

### Threat model

- Origin allowlist enforced at bootstrap before any network call
- iframe sandbox attribute mandatory in iframe-mode (implemented in 0.1.1)
- JWT not client-side verified (relies on server enforcement)
- Port wildcard `http://localhost:*` allows all localhost ports in dev mode
