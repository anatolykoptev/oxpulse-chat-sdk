# ADR-010: Introduction protocol as one bounded context

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** architect

## Context

The L2 introduction protocol (Briar-style contact introduction) has three
tightly-coupled concerns:

1. **intro-crypto** — X25519+HKDF+AEAD, MAC/sig, session ID derivation,
   constant-time role assignment.
2. **intro-wire** — JSON+Zod wire codec for the 6 intro message types
   (`intro_request_v1`, `intro_accept_v1`, `intro_decline_v1`,
   `intro_auth_v1`, `intro_activate_v1`, `intro_abort_v1`).
3. **intro-safety-number** — Signal-style 60-digit safety number (SAS)
   derivation.

These three modules share domain types (pubkeys, session IDs, master key),
share security invariants (constant-time comparison, canonical CBOR
ordering), and are never consumed independently — a consumer of the intro
protocol needs all three together. Splitting them across
`@oxpulse/crypto-primitives` (which is a general-purpose transport-crypto
library) and a hypothetical `@oxpulse/wire-codec` (which uses CBOR+zstd,
a different wire format) would:

- Force consumers to depend on two unrelated packages to get one protocol.
- Duplicate the domain types across package boundaries.
- Make the constant-time invariants harder to audit (the
  `verifySessionIdRedundancy` CWE-208 fix spans the crypto/wire boundary).

## Decision

Create **one** package — `@oxpulse/intro-protocol` — containing all three
modules (`intro-crypto.ts`, `intro-wire.ts`, `intro-safety-number.ts`) as a
single bounded context. The package:

- Depends on `@oxpulse/crypto-primitives` for the **public** constant-time
  comparison helpers (`timingSafeEqual`, `timingSafePubkeyEqualB64u`) —
  the single source of truth (ADR-008). It does NOT duplicate them.
- Uses **JSON + Zod** for its wire format (ADR-002), NOT the CBOR+zstd
  wire-codec format. The intro protocol's outer envelope is JSON to match
  the sdk-inbox-bridge dispatch pattern; CBOR is used only internally for
  canonical transcript/safety-number encoding.
- Keeps `concatBytes` + `utf8` as local internal helpers (ADR-008: only
  `timingSafeEqual` + `timingSafePubkeyEqualB64u` are the public
  crypto-primitives exports; `concatBytes`/`utf8` are general-purpose and
  stay internal to each consumer).

## Consequences

- One package to depend on, one place to audit the constant-time
  invariants, one changeset to release.
- The package has NO dependency on `@oxpulse/wire-codec` — the two wire
  formats are deliberately separate.
- `@oxpulse/crypto-primitives` remains a general-purpose transport-crypto
  library; intro-protocol is a higher-level protocol package built on top
  of it.
