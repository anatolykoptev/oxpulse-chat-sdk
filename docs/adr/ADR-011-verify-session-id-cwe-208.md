# ADR-011: Fix CWE-208 timing oracle in `verifySessionIdRedundancy`

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** architect, crypto

## Context

`verifySessionIdRedundancy` (in `intro-wire.ts`) checks that the
`sessionId` carried on the wire matches the sessionId the receiver
re-derives locally from the introducer's public key + their own key
material. A mismatch indicates an introducer forgery attempt or a
deterministic-derivation drift bug.

The original implementation compared the two base64url session IDs with
plain `===`:

```ts
return msg.sessionId === derivedSessionId;
```

### Vulnerability (CWE-208)

A plain `===` on a string short-circuits on the first mismatched
character. The time taken to return `false` therefore leaks the position
of the first byte that differs between the wire sessionId and the
locally-derived sessionId.

The wire `sessionId` is **attacker-influenced** — a malicious introducer
(or a man-in-the-channel) controls the value placed on the wire. The
locally-derived sessionId is the secret the attacker is trying to learn
(it is derived from the introducer pubkey + the receiver's key material).
By measuring the response time across many requests, an attacker can
iteratively guess the locally-derived sessionId one byte at a time:
submit a candidate, observe whether the comparison ran longer (meaning
more leading bytes matched), adjust, repeat.

This is a **timing oracle** — OWASP ASVS V11.3.1 requires that
cryptographic verification operations not leak information via timing,
and CWE-208 (Observable Timing Discrepancy) classifies exactly this
pattern.

## Decision

Replace the plain `===` with `timingSafePubkeyEqualB64u` from
`@oxpulse/crypto-primitives`:

```ts
return timingSafePubkeyEqualB64u(msg.sessionId, derivedSessionId);
```

`timingSafePubkeyEqualB64u` decodes both base64url strings to bytes and
compares with `timingSafeEqual` (XOR-reduce over all bytes, returns
`false` immediately on length mismatch — length is non-secret). No
short-circuit path based on byte content remains.

## Consequences

- The comparison runs in time independent of the byte values (constant
  time modulo length, which is non-secret).
- The timing oracle is closed: an attacker can no longer learn the
  locally-derived sessionId byte-by-byte.
- A regression test in `intro-wire.test.ts` asserts the fix: two
  sessionIds differing only in the last byte return `false` without
  throwing, guarding against a future regression to a prefix-comparison.
- The function now imports `timingSafePubkeyEqualB64u` from
  `@oxpulse/crypto-primitives` (ADR-008: single source of truth for
  constant-time comparison).
