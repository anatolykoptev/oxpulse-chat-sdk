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
so revocation actually takes effect. The AEAD epoch is applied only after
both commits, so nothing is sealed under the epoch the removed member can
still compute.

**KNOWN LIMITATION:** `MLSStateStore` does NOT persist state yet
(ts-mls lacks a complete serialize/deserialize API — tracked in #353).
MLS group state does NOT survive a page reload. The store is exported
for DI/testing only.
