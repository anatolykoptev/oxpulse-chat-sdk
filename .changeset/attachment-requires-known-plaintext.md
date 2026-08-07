---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": patch
---

Require a positive plaintext mode before the attachment upload path presigns.

The widget's direct-upload path (presignAttachment + PUT, bypassing sendFile)
called `assertRoomNotPoisoned` before presign — but that gate only asserts
"this room was not PROVEN wrong." It cannot tell a room whose `crypto_mode` is
genuinely known from one whose `list()`/`subscribe()` response has not yet
arrived. Between mount and that first response the room is neither poisoned nor
known, and not-poisoned alone was treated as sufficient — so a plaintext
attachment envelope could upload and send into a room the server considers
E2EE, silently, with no error on either side.

`@oxpulse/chat-sdk` gains a public `getRoomCryptoMode(roomId)` accessor — the
smallest seam matching how `assertRoomNotPoisoned` is exposed — so the widget
can read the same authoritative `#activeCryptoModeByRoom` the internal gates
read. No existing public accessor for the discovered mode existed; a new seam
was necessary because `#activeCryptoModeByRoom` is private and the widget must
require a POSITIVE plaintext mode, not merely the absence of poison.

`@oxpulse/chat-widget` now requires `getRoomCryptoMode(roomId) === 'plaintext'`
(positively discovered) before presign, alongside the existing poison check.
The error is `crypto_mode_undiscovered` (distinguishable from
`crypto_mode_poisoned`: the latter is never retriable, the former is retriable
the moment discovery lands) and fires before any outbox entry is created, so
`PERMANENT_OUTBOX_FAILURE_CODES` is untouched. The attachment-picker catch path
surfaces it as a per-card error with a retry button — the softer composer
state — appropriate for a window that closes on its own within ~1s of mount.

Closes #259.
