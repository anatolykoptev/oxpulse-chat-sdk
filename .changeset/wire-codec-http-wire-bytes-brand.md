---
"@oxpulse/wire-codec": patch
---

fix(wire-codec): brand `encodeHttpBody`/`decodeHttpBody` output as `HttpWireBytes`, distinct from `WireBytes`

`encode()`/`decode()` (peer protocol: CBOR + 1-byte dict-id) and `encodeHttpBody()`/`decodeHttpBody()`
(SDK HTTP protocol: JSON + u16-BE dict-id) are binary-incompatible wire formats that happened to share
both the `0xC7` magic byte and the `WireBytes` phantom brand — nothing at compile time stopped feeding
one protocol's output into the other's decoder, which can silently misparse instead of throwing.

Adds a second phantom brand, `HttpWireBytes` (exported from `@oxpulse/wire-codec`), and retypes
`encodeHttpBody` to return it and `decodeHttpBody` to require it. `encode`/`decode` keep the existing
`WireBytes` brand. This is a pure type-level change — zero runtime behavior differs, `HttpWireBytes` is
a `Uint8Array` exactly like `WireBytes` was.

**Potentially breaking for consumers**: if you called `decodeHttpBody(asWireBytes(bytes))` directly
(rather than `decodeHttpBody(encodeHttpBody(...))` round-trips, which are unaffected), switch the lift
to the new `asHttpWireBytes(bytes)` export. `@oxpulse/chat-sdk`'s `SDKChatClient` already does this
internally — no action needed for consumers who only use the client.
