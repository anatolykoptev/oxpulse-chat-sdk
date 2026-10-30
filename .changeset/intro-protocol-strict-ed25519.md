---
"@oxpulse/intro-protocol": patch
---

Verify the intro AUTH signature with strict Ed25519 (`{ zip215: false }`).
`verifyAuthSig` used noble's default ZIP-215 rule, which accepts a small-order
or non-canonical peer key with an identity-point signature over any message.
Honest signers (`computeAuthSig`, noble `ed25519.sign`) always produce
canonical signatures, so legitimate peers are unaffected. Versions up to and
including 0.2.4 are affected.
