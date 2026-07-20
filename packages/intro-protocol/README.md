# @oxpulse/intro-protocol

**EXPERIMENTAL — version 0.1.0.** The L2 introduction protocol as one
bounded context: Briar-faithful intro crypto (X25519+HKDF+AEAD, MAC/sig),
a JSON+Zod wire codec for the 6 intro message types, and Signal-style
safety-number (SAS) derivation.

> ⚠️ **EXPERIMENTAL.** This package has not been audited. The crypto
> invariants are documented in [SECURITY.md](./SECURITY.md) but the
> package is pre-1.0 and the API may change.

## Public surface (flat exports — ADR-003)

All exports are flat from the package root
(`@oxpulse/intro-protocol`); there are no sub-path exports.

### intro-crypto

- **Labels / version** — `LABEL_SESSION_ID`, `LABEL_MASTER_KEY`,
  `LABEL_ALICE_MAC_KEY`, `LABEL_BOB_MAC_KEY`, `LABEL_AUTH_MAC`,
  `LABEL_AUTH_NONCE`, `LABEL_AUTH_SIGN`, `LABEL_ACTIVATE_MAC`,
  `PROTOCOL_VERSION`
- **Session ID** — `deriveSessionId`
- **Role assignment** — `isAliceRole` (constant-time lexicographic compare)
- **Key derivation** — `deriveMasterKey`, `deriveMacKeys`
- **Auth transcript** — `buildAuthTranscript`, `TranscriptParty`
- **AUTH MAC** — `computeAuthMac`, `verifyAuthMac`
- **AUTH SIG** — `computeAuthSig`, `verifyAuthSig`
- **ACTIVATE MAC** — `computeActivateMac`, `verifyActivateMac`
- **AEAD (XChaCha20-Poly1305)** — `sealAead`, `openAead`, `AeadEnvelope`

### intro-wire

- **Schemas** — `IntroRequestV1Schema`, `IntroAcceptV1Schema`,
  `IntroDeclineV1Schema`, `IntroAuthV1Schema`, `IntroActivateV1Schema`,
  `IntroAbortV1Schema`, `IntroMessageSchema`
- **Codec** — `encodeIntroMessage`, `decodeIntroMessage`
- **Session ID redundancy** — `verifySessionIdRedundancy` (CWE-208 fixed)
- **Types** — `IntroMessage`, `IntroKind`

### intro-safety-number

- **Safety number** — `deriveSafetyNumber` (60-digit SAS, 12 groups of 5)

## Constant-time comparison (CWE-208 invariant)

`timingSafeEqual` and `timingSafePubkeyEqualB64u` are imported from
`@oxpulse/crypto-primitives` (the single public source of truth, ADR-008).
All attacker-influenced cryptographic comparisons in this package use them.
See [SECURITY.md](./SECURITY.md) for the full threat model and invariants.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
