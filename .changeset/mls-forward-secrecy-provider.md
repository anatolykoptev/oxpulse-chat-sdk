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

ts-mls 2.0 is an optional peer dependency — dynamically imported, not
bundled into the main SDK or CDN widget (~672 KB, code-split).

MLS ClientState is serialized via ts-mls 2.0 `clientStateEncoder`/
`clientStateDecoder` and persisted to IndexedDB — group state survives
page reloads. Credential validation uses ts-mls `AuthenticationService`
(KCI protection).
