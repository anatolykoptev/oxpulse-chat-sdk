---
"@oxpulse/chat-widget": minor
---

Staged attachment tray + multi-image collage; fixes duplicate paperclip button and immediate-send-on-attach.

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
