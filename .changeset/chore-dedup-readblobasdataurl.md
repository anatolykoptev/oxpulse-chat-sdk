---
"@oxpulse/voice-core": minor
"@oxpulse/chat-widget": patch
---

`readBlobAsDataUrl` is now exported from `@oxpulse/voice-core`'s public
surface; `@oxpulse/chat-widget` consumes it from there instead of carrying
a byte-identical private copy (drift-vector dedup). No behavior change.
