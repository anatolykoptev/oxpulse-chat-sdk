---
"@oxpulse/chat-widget": patch
---

fix(chat-widget): render failed-decrypt messages with a distinct state (unsealError)

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
