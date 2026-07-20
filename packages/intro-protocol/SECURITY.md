# Security policy — @oxpulse/intro-protocol

**EXPERIMENTAL — version 0.1.0.** This package has not been independently
audited. The invariants below are documented for review and regression
testing; they are not a substitute for a formal audit.

## Threat model

This package implements the **L2 introduction protocol**: two parties
(Alice and Bob) are introduced by a mutual introducer over a QR code /
introduction channel. The threat model is:

- The **introducer** is partially trusted — they choose which two parties
  to introduce but must not be able to forge a session undetected.
- **Long-term Ed25519 pubkeys** are PUBLIC — they are exchanged over the
  QR code / introduction channel in cleartext. They are not secret material.
- The **introducer's public key** is attacker-influenced (a malicious
  introducer controls it). The **wire sessionId** is attacker-influenced
  (a malicious introducer or man-in-the-channel can set it).
- **Ephemeral X25519 keys**, the **master key**, **MAC keys**, and the
  **AEAD key** are secret and never transmitted.
- The channel is asynchronous (sdk-inbox-bridge sealed payloads); there is
  no live key-agreement handshake, so redundancy checks and MACs/signatures
  carry the integrity guarantee.

## CWE-208 fix — `verifySessionIdRedundancy` (ADR-011)

**Vulnerable (before):** `verifySessionIdRedundancy` compared the wire
sessionId to the locally-derived sessionId with plain `===`:

```ts
return msg.sessionId === derivedSessionId;
```

A plain `===` on a crypto-derived base64url string short-circuits on the
first mismatched character, leaking the first-mismatch byte position via
timing. Because the wire sessionId is attacker-influenced (a malicious
introducer controls it), this created a **timing oracle**: an attacker
could iteratively guess the locally-derived sessionId one byte at a time
by measuring how long the comparison ran before returning `false`. This
violates **OWASP ASVS V11.3.1** and is classified as **CWE-208**
(Observable Timing Discrepancy).

**Fixed (now):** The comparison uses `timingSafePubkeyEqualB64u` from
`@oxpulse/crypto-primitives`, which decodes both base64url strings to
bytes and compares with `timingSafeEqual` (XOR-reduce over all bytes,
returns `false` on length mismatch — length is non-secret). No
short-circuit path based on byte content remains.

```ts
return timingSafePubkeyEqualB64u(msg.sessionId, derivedSessionId);
```

A regression test (`intro-wire.test.ts`) asserts the fix: two sessionIds
differing only in the last byte return `false` without throwing, and the
function returns a boolean for equal, first-char-differing, last-char-
differing, and different-length inputs.

## Constant-time invariants

**INVARIANT:** Every comparison of an attacker-influenced cryptographic
identifier uses `timingSafeEqual` (raw bytes) or
`timingSafePubkeyEqualB64u` (base64url strings), imported from
`@oxpulse/crypto-primitives`. Plain `===` is NEVER used on crypto-derived
b64u strings, MAC tags, signatures, or sessionIds.

The functions that enforce this:

| Function | Compares | Constant-time? |
|---|---|---|
| `verifySessionIdRedundancy` | wire sessionId vs derived sessionId (b64u) | ✅ `timingSafePubkeyEqualB64u` |
| `verifyAuthMac` | expected HMAC vs received HMAC (bytes) | ✅ `timingSafeEqual` |
| `verifyActivateMac` | expected HMAC vs received HMAC (bytes) | ✅ `timingSafeEqual` |
| `verifyAuthSig` | Ed25519 signature (delegated to `ed25519.verify`) | ✅ (noble verifies in constant time) |
| `isAliceRole` | local pubkey vs peer pubkey (bytes) | ✅ walks all bytes, branchless decide |

## Non-constant-time — safe because public (ADR-012)

Two comparisons in this package are intentionally NOT constant-time. This
is safe because the values being compared are PUBLIC over the QR code /
introduction channel — they are not secret, so leaking the
first-differing-byte position via timing reveals nothing an attacker does
not already know.

### `lexLess` (intro-safety-number.ts)

`lexLess` orders the two long-term pubkeys (lex-smaller first) before
CBOR-encoding the safety-number input. It returns early on the first
differing byte. This is safe because:

1. The pubkeys are already public (transmitted in cleartext over the
   QR / introduction channel).
2. The ordering only determines array position in the CBOR input — it
   does not gate any security decision on secret data.
3. A constant-time version (`isAliceRole` in intro-crypto.ts) exists where
   the comparison itself IS security-relevant (role assignment).

See **ADR-012** for the full reasoning.

### SAS human comparison (SECURITY_COST-8)

`deriveSafetyNumber` returns a 60-digit Short Authentication String (SAS)
intended to be read aloud or compared visually by the two human parties
over an authenticated side channel (in-person, phone call). The comparison
is performed by **humans**, who are inherently non-constant-time. No
constant-time comparison is required or meaningful for the SAS value
itself — the security property comes from the human comparing the full
string, not from a code-level equality check. The underlying
`deriveSafetyNumber` computation is deterministic and side-channel-free
(pure SHA-512 + CBOR, no secret-dependent branches on attacker-controlled
input beyond the public pubkey ordering).

## Reporting a vulnerability

Do NOT open a public GitHub issue for a security vulnerability. Email the
maintainer privately. See the repository root for contact details.
