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

**KNOWN LIMITATION:** `MLSStateStore` does NOT persist state yet
(ts-mls lacks a complete serialize/deserialize API — tracked in #353).
MLS group state does NOT survive a page reload. The store is exported
for DI/testing only.
