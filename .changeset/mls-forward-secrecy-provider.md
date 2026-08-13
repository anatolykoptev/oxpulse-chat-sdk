---
"@oxpulse/chat-sdk": minor
---

Add MLS (RFC 9420) forward-secrecy provider alongside sframe-static.

New exports: `createMlsProvider`, `MLSGroupManager`, `MLSStateStore`,
`IdbMlsStateStore`, `InMemoryMlsStateStore`. New `E2EEOptions` arm:
`provider: 'mls'` with `identityKey`, `credential`, `uid`,
`keyPackageDirectoryUrl`, `onEpochAuthenticator`, `stateStore`.
`CryptoMode` now includes `'mls'`. Six MLS-specific error codes added
to `SDKChatErrorCode`.

ts-mls is an optional peer dependency — dynamically imported, not
bundled into the main SDK or CDN widget (~672 KB, code-split).

`removeMember` commits the Remove and then an empty commit. The second
one is load-bearing, not redundant: ts-mls 1.6.2 omits the UpdatePath on
a commit that removes exactly one member, contrary to RFC 9420 §12.4, and
without a path the removed member derives the next epoch's key material
and keeps reading the room. The empty follow-up commit does carry a path,
so revocation actually takes effect.

Both sides of that need handling. The committer applies the AEAD epoch only
after both commits. Receivers get the two commits separately over SSE, so
`processMessage` now advances the MLS state but withholds the AEAD epoch for
a commit that carries a Remove and no UpdatePath, installing it when the
rotation arrives. Without the receive-side half, every member other than the
committer seals one message under a key the person just removed can derive.
A peer that never receives the rotation fails closed.

Upstream fixed the same defect in ts-mls 2.0.0-rc.11 (PR #436) and did not
backport it; npm `latest` is 1.6.2, which predates the fix. Both halves of
this workaround come out on the ts-mls 2.0 upgrade, which is breaking.

`#fetchKeyPackage` binds the returned KeyPackage to the uid that was
requested, so an untrusted directory cannot answer a request for Bob with
Mallory's package. New error code `mls_keypackage_identity_mismatch`.

**KNOWN LIMITATION:** member authentication is closed on the outbound
KeyPackage fetch only. Inbound commits go through ts-mls `acceptAll` and
joins run with a credential validator that returns `true` unconditionally,
so group membership is server-asserted — tracked in #355.

**KNOWN LIMITATION:** `MLSStateStore` does NOT persist state yet
(ts-mls lacks a complete serialize/deserialize API — tracked in #353).
MLS group state does NOT survive a page reload. The store is exported
for DI/testing only.
