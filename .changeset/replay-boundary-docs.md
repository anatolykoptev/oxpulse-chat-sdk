---
"@oxpulse/crypto-primitives": patch
---

Document replay protection boundary (closes #289)

Add explicit "Replay protection (caller's responsibility)" section to
README.md and JSDoc on `openMessage` stating that the library is stateless
and does NOT reject replayed envelopes without a `replayWindow`. Production
callers MUST pass a `replayWindow`.
