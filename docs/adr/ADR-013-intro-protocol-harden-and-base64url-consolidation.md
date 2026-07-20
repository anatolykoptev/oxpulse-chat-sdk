# ADR-013: intro-protocol crypto hardening + base64url consolidation

Date: 2026-07-19
Status: Accepted
Related: #216, #217, #218, ADR-008, ADR-010, ADR-011

## Context

pr-review-council on PRs #213/#214 surfaced two MEDIUM-severity crypto findings
and a bundle of LOW nits. The MEDIUM findings gate `@oxpulse/intro-protocol`'s
promotion out of EXPERIMENTAL (`harden-before-prod`):

1. **#216 — No zeroization.** `deriveMasterKey` and `deriveMacKeys` returned
   secret key material (raw DH shared secret, master key, MAC keys) with no
   best-effort clearing. The SECURITY.md threat model lists these as secret
   and never transmitted, but the code did not clear them after use. A process
   memory dump / heap snapshot / swap exposure after the handshake retained
   the raw DH shared secret indefinitely.

2. **#217 — deriveSessionId caller footgun.** `deriveSessionId` hashed
   `introducerPub || alicePub || bobPub` in the EXACT order passed — it did
   NOT role-order alice/bob, unlike `buildAuthTranscript` which auto-orders
   via `isAliceRole`. A receiver re-deriving the sessionId for
   `verifySessionIdRedundancy` who passed `(ownEphPub, peerEphPub)` in the
   wrong order got a different sessionId than the introducer placed on the
   wire, causing a spurious forgery alarm + protocol abort (DoS).

The LOW nits (#218) included: missing equal-pubkey guard in
`buildAuthTranscript`, missing `AeadLabel` type export, missing
`profile_key_b64u` validation, missing AeadEnvelope ↔ wire-format bridge,
stale JSDoc references, transitive-only sessionId binding in AUTH MAC/sig,
`transportProps` CBOR determinism risk, `timingSafePubkeyEqualB64u` throwing
on invalid input, and three copies of base64url logic across the SDK.

## Decision

### #216 — Best-effort zeroization
Add a `wipe(u: Uint8Array)` helper (`u.fill(0)`). Call it on `ikm` in
`deriveMasterKey` after HKDF extraction. Export `wipeMacKeys(keys)` for
zeroizing both MAC keys. Document the caller contract: callers MUST wipe
ephemeral private keys after `deriveMasterKey` and wipe `masterKey` once all
derived keys + AEAD operations complete.

JS zeroization is best-effort — V8 may copy Uint8Array contents during GC
compaction, so this is NOT a guarantee that no copy survives. But it is the
recognized hardening baseline and the threat model already promises these
values are secret.

### #217 — Canonical ordering in deriveSessionId
Make `deriveSessionId` canonical-order `alicePub`/`bobPub` internally via
`isAliceRole` (lex-smaller first), matching `buildAuthTranscript`. Both
argument orderings now yield the same sessionId. This removes the footgun
entirely — callers no longer need to know which ephemeral pubkey is "alice".

### #218 nits — applied
- `buildAuthTranscript` throws on equal long-term pubkeys (degenerate guard).
- `computeAuthMac` / `verifyAuthMac` / `computeAuthSig` / `verifyAuthSig` take
  explicit `sessionId` argument, mixed into the HMAC input for explicit binding
  that survives future transcript-shape changes.
- `AeadLabel` type exported from package index.
- `profile_key_b64u` constrained to `B64uString` regex.
- `transportProps` constrained to deterministically CBOR-encodable scalars
  (string | number | bigint | boolean | null | arrays thereof).
- `deriveSafetyNumber` comment corrected (2^240 ≈ 1.77×10^72, not < 10^72).
- `deriveSessionId` JSDoc references `b64uDecodeBytes` from crypto-primitives.
- `envelopeToWireB64u` + `wireB64uToEnvelope` bridge helpers added.
- `timingSafePubkeyEqualB64u` returns `false` (not throws) on invalid base64url.
- New `@oxpulse/crypto-primitives` `base64url.ts` module — single canonical home
  for `b64uEncodeBytes` + `b64uDecodeBytes`. Replaces ad-hoc copies in
  `intro-crypto.ts` and `chat-sdk/push.ts`.
- `b64uDecodeBytes` in `timing-safe.ts` is now module-private.

## Consequences

### Positive
- `@oxpulse/intro-protocol` meets the `harden-before-prod` gate for promotion
  out of EXPERIMENTAL.
- The deriveSessionId footgun is removed — callers cannot accidentally produce
  divergent sessionIds.
- AUTH MAC/sig binding to sessionId is explicit and refactor-resilient.
- Single canonical base64url API across the SDK — no more 3-copy drift risk.
- `timingSafePubkeyEqualB64u` is total — callers need no try/catch.

### Negative
- **BREAKING**: `computeAuthMac` / `verifyAuthMac` / `computeAuthSig` /
  `verifyAuthSig` signatures changed (added `sessionId` argument). Direct
  callers must update. Since `@oxpulse/intro-protocol` is 0.x EXPERIMENTAL
  and not yet consumed by the app repo, this is acceptable.
- JS zeroization is best-effort, not a guarantee. Documented in `wipe` JSDoc.
- `transportProps` schema is stricter — callers passing Map/Set/floats will
  now fail at the Zod boundary. This is the intended fail-fast behaviour.

### Versioning
- `@oxpulse/intro-protocol` 0.1.0 → 0.2.0 (minor — additive + breaking
  signature changes within 0.x).
- `@oxpulse/crypto-primitives` 0.1.0 → 0.2.0 (minor — additive: new
  `base64url.ts` module + total-contract fix for `timingSafePubkeyEqualB64u`).
