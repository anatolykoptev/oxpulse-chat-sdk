---
"@oxpulse/crypto-primitives": patch
---

Handle CSPRNG failure in nonce generation (closes #290)

Wrap `crypto.getRandomValues` in try/catch with a descriptive error
message. Defense-in-depth — 12 bytes is well under the QuotaExceededError
threshold, but the WebCrypto spec allows implementations to throw on
entropy source exhaustion in constrained environments.
