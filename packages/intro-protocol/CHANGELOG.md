# @oxpulse/intro-protocol

## 0.2.3

### Patch Changes

- Updated dependencies [6a643d1]
  - @oxpulse/crypto-primitives@0.5.1

## 0.2.2

### Patch Changes

- Updated dependencies [0f88de9]
- Updated dependencies [29c2a3d]
- Updated dependencies [7121f01]
  - @oxpulse/crypto-primitives@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [2d2c0de]
  - @oxpulse/crypto-primitives@0.3.0

## 0.2.0

### Minor Changes

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

- a619918: New @oxpulse/intro-protocol package — L2 introduction protocol (intro-crypto + intro-wire + intro-safety-number) as one bounded context. Fixes CWE-208 timing oracle in verifySessionIdRedundancy. EXPERIMENTAL (0.1.0).

### Patch Changes

- Updated dependencies [263e5bc]
- Updated dependencies [baccdb4]
  - @oxpulse/crypto-primitives@0.2.0
