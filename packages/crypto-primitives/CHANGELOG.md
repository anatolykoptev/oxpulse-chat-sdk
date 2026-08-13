# @oxpulse/crypto-primitives

## 0.5.0

### Minor Changes

- 29c2a3d: MessageEnvelope v2: authenticated binding transcript (closes #288)

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

### Patch Changes

- 0f88de9: Handle CSPRNG failure in nonce generation (closes #290)

  Wrap `crypto.getRandomValues` in try/catch with a descriptive error
  message. Defense-in-depth — 12 bytes is well under the QuotaExceededError
  threshold, but the WebCrypto spec allows implementations to throw on
  entropy source exhaustion in constrained environments.

- 7121f01: Document replay protection boundary (closes #289)

  Add explicit "Replay protection (caller's responsibility)" section to
  README.md and JSDoc on `openMessage` stating that the library is stateless
  and does NOT reject replayed envelopes without a `replayWindow`. Production
  callers MUST pass a `replayWindow`.

## 0.3.0

### Minor Changes

- 2d2c0de: feat(crypto): harden crypto-primitives to 2026 industry standard

  PQXDH hybrid key agreement (X25519 + ML-KEM-768), XChaCha20-Poly1305 with
  key commitment, key zeroization, replay window in openMessage, KAT test
  vectors (RFC 7748/5869/8032, NIST GCM), HKDF extract/expand split API,
  dedup b64uDecodeBytes, noble deps upgrade.

  8 issues closed (#280-#287). 151 tests, 85.5% mutation score, deep crypto
  audit passed. Signal PQXDH spec compliance with F prefix + transcript salt.

## 0.2.0

### Minor Changes

- 263e5bc: Promote @oxpulse/crypto-primitives to SDK repo as publishable package. Add public timingSafeEqual + timingSafePubkeyEqualB64u exports.
- baccdb4: Harden intro-protocol crypto + consolidate base64url helpers (closes #216, #217, #218).

  ## @oxpulse/intro-protocol (0.1.0 → 0.2.0 — MINOR, API additions + signature changes)

  ### Security hardening (#216, harden-before-prod)

  - Add `wipe(u: Uint8Array)` helper — best-effort zeroization of secret key material.
  - `deriveMasterKey` now wipes the raw DH shared secret (`ikm`) after HKDF extraction.
  - Add `wipeMacKeys(keys)` — zeroize both alice/bob MAC keys after handshake completes/aborts.
  - Document caller contract: callers MUST wipe ephemeral private keys after `deriveMasterKey`
    and wipe `masterKey` once all derived keys + AEAD operations complete.

  ### API fix (#217, harden-before-prod — BREAKING for direct callers)

  - `deriveSessionId` now canonical-orders alicePub/bobPub internally via `isAliceRole`
    (lex-smaller first), matching `buildAuthTranscript`. Previously the caller had to
    pass role-ordered pubkeys — a footgun where a wrong order caused a spurious
    forgery alarm + protocol abort (DoS). Both argument orderings now yield the same
    sessionId.

  ### AUTH MAC/SIG explicit sessionId binding (#218 nit #7 — BREAKING for direct callers)

  - `computeAuthMac` / `verifyAuthMac` / `computeAuthSig` / `verifyAuthSig` now take
    an explicit `sessionId: Uint8Array` argument, mixed into the HMAC input alongside
    the transcript. Previously sessionId was only transitively bound (its inputs are
    transcript fields). Explicit binding survives future transcript-shape changes.

  ### Other improvements (#218 nits #1, #3, #8)

  - `buildAuthTranscript` throws on equal long-term pubkeys (degenerate case guard).
  - `AeadLabel` type now exported from package index.
  - Add `envelopeToWireB64u(env)` + `wireB64uToEnvelope(s)` bridge helpers — eliminates
    caller glue bugs (wrong concat order, wrong split offset) between AeadEnvelope
    and the wire-format `b64u(nonce ‖ ciphertext)` string.

  ## @oxpulse/crypto-primitives (0.1.0 → 0.2.0 — MINOR, additive)

  ### Public base64url API (#218 nit #11)

  - New `base64url.ts` module exporting `b64uEncodeBytes` + `b64uDecodeBytes` — the
    single canonical home for base64url serialization across the SDK. Replaces
    ad-hoc copies in `intro-crypto.ts` and `chat-sdk/push.ts`.

  ### timingSafePubkeyEqualB64u total contract (#218 nit #9)

  - `timingSafePubkeyEqualB64u` now returns `false` (instead of throwing) on malformed
    base64url input. The function is total for all string inputs — safer for the
    documented "attacker-influenced" use case; callers need no try/catch.

  ### Internal cleanup (#218 nit #10)

  - `b64uDecodeBytes` in `timing-safe.ts` is now module-private (no longer exported)
    — the public base64url API lives in `./base64url.ts`.
