---
"@oxpulse/crypto-primitives": minor
---

MessageEnvelope v2: authenticated binding transcript (closes #288)

Fold ALL envelope metadata (version, flags, msgId, recipientAddr,
senderEd25519PubKey) into a SHA-256 binding transcript digest, bound into
BOTH AEAD AAD and Ed25519 signed bytes. Closes #288 — flags were not
authenticated, allowing a relay to flip store_and_forward / system_msg
undetected.

**Breaking:** v2 wire format is identical to v1 except version=0x02 (zero
wire overhead). v1 decoders are rejected (hard break, ADR-8).
MessageEnvelopeV1 → MessageEnvelopeV2. MESSAGE_ENVELOPE_VERSION 0x01 → 0x02.

Key changes:
- `computeBindingDigest` replaces `buildSignedBytes` (expanded scope, 5
  binding fields). AAD = AAD_PREFIX || senderPub || bindingDigest.
  signedBytes = bindingDigest || sha256(IC).
- `recipientAddr` cross-check added (ADR-11, timingSafeEqual, fail-fast
  before sig verify).
- zeroize + ReplayWindow + zip215:false all preserved from 0.3.0.

160 tests, 88.89% mutation score on pairwise-seal.ts, flags-removal mutant
killed.
