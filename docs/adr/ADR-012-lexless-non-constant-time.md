# ADR-012: `lexLess` is non-constant-time — safe because pubkeys are public

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** architect, crypto

## Context

`intro-safety-number.ts` contains a `lexLess(a, b)` helper that returns
true if byte array `a` is lexicographically less than byte array `b`. It
is used to canonically order the two parties' long-term pubkeys
(lex-smaller first) before CBOR-encoding the safety-number input, so that
`swap(alice, bob)` produces an identical safety number.

`lexLess` is **not constant-time** — it returns early on the first
differing byte:

```ts
function lexLess(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}
```

A reviewer flagged this as a potential CWE-208 timing leak, since the
package's other comparisons (MAC tags, sessionIds) are all constant-time.

## Decision

**Keep `lexLess` non-constant-time.** This is safe. Document the reasoning
in the code (a comment on `lexLess`) and in `SECURITY.md`.

### Safe-because-public reasoning

1. **The inputs are public.** The two pubkeys being ordered are the
   parties' long-term Ed25519 public keys. In the L2 introduction
   protocol, these are exchanged over the QR code / introduction channel
   in **cleartext** — they are not secret material. An attacker observing
   the channel already knows both pubkeys.

2. **The ordering does not gate a security decision on secret data.**
   `lexLess` only determines which pubkey is listed first in the CBOR
   safety-number input array. The safety number is derived from a hash of
   `[min(alice, bob), max(alice, bob), masterKey]`; the ordering ensures
   symmetry (both parties compute the same value). The ordering itself is
   not a secret and does not control access to any secret.

3. **Leaking the first-differing-byte position reveals nothing.** Because
   the pubkeys are public, an attacker already knows every byte. The
   timing leak would reveal which byte position first differs between two
   values the attacker already has — this is zero information gain.

### Contrast with `isAliceRole` (intro-crypto.ts)

`isAliceRole` performs a similar lexicographic comparison but IS
constant-time (walks all bytes, branchless decide). This is because
`isAliceRole` is used for **role assignment** in the crypto protocol —
the comparison result determines which MAC key a party uses, which is a
security-relevant decision. While the pubkeys are still public, the
constant-time implementation is kept there for defense-in-depth and
consistency with the crypto module's invariant. `lexLess` in the
safety-number module does not need this defense because its output is not
security-relevant.

## Consequences

- `lexLess` stays simple and early-exiting (no performance cost for a
  non-secret comparison).
- The code comment and `SECURITY.md` document the reasoning so future
  reviewers do not re-flag it.
- A constant-time alternative (`isAliceRole`) exists in `intro-crypto.ts`
  for the case where the comparison IS security-relevant.
