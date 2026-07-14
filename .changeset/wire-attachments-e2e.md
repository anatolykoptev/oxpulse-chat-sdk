---
"@oxpulse/chat-widget": minor
---

attachments wired end-to-end: paperclip/paste/drag now live; client-side WebP compression + dimension capture (closes #67)

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
