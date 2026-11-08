---
"@oxpulse/crypto-primitives": minor
---

Add `verifyEnvelopeSender(envelopeBytes, expectedSenderEd25519Pub)`: a
signature-only check that a pairwise-sealed envelope was signed by the pinned
peer. It needs no recipient key and never decrypts, so it can authenticate an
envelope addressed to another device of the same user. It shares the envelope
codec, binding digest and strict Ed25519 verification with `openMessage`, and
returns `false` for malformed or forged input.
