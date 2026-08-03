# @oxpulse/wire-codec

## 0.6.0

### Minor Changes

- cd19dc8: Add epoch binding to DecodeOpts.resolvePeer — crypto-critical UKS fix

  DecodeOpts gains an `epoch?: number` field. `resolvePeer` signature
  changed from `(peerIndex) => string | undefined` to
  `(epoch, peerIndex) => string | undefined`. The SDK threads `epoch`
  from DecodeOpts to `resolvePeer`, ensuring the peer-index is resolved
  against the correct epoch's peer_index_map — not the current one.

  This prevents a cross-epoch sender misattribution (UKS) attack: a
  delayed frame from epoch N was previously resolved against the current
  epoch N+1's map, potentially attributing Alice's message to Charlie.
  See RFC 9420 §4.1.1: each epoch has a distinct ratchet tree, and the
  sender's leaf index is bound to that epoch's tree.

  If `epoch` is missing in DecodeOpts, v3 frames get `from=undefined`
  (safe drop) — the SDK refuses to call resolvePeer without an epoch.
  Pre-v3 frames (JSON/CBOR/0xC6/0xC7/0xC8) ignore both `epoch` and
  `resolvePeer` entirely.

  Migration: callers using `resolvePeer` must add `epoch` to their
  DecodeOpts, passing the AEAD-authenticated epoch from the SFrame header.

## 0.5.0

### Minor Changes

- 3d6ac37: Phase 2.F.B — envelope-v3 peer-index compaction. Replace the 64-char hex
  `from` pubkey string with a 1-byte uint8 peer-index inside the AEAD
  ciphertext envelope (magic byte 0xCA). The peer-index mirrors the SFrame
  AEAD header's peerIndex — no new fingerprint leaked to passive observers.

  New API:

  - `encode(value, { cbor:true, zstd:true, envelope:3, peerIndex:N })` —
    emits 0xCA + dict-id + peer-index. Falls back to v2 (0xC8) then v1 (0xC6)
    per-frame when the value isn't v3-encodable.
  - `decode(bytes, { resolvePeer })` — optional `resolvePeer` maps the uint8
    peer-index back to the pubkey string via the ratchet's peer_index_map.
    Without a resolver, `from` is undefined + `f` is preserved for diagnostics.
  - `negotiateEnvelopeVersion` now returns `1 | 2 | 3` (v3 > v2 > 1).
  - `canEncodeAsV3`, `toV3`, `fromV3` exported from envelope-v2 module.
  - `DecodeOpts` type exported.
  - `"envelope-v3"` added to `WireCap` union and `ALL_CAPS`.

  Backward-compatible: `decode(bytes)` without opts works for all pre-v3 magic
  bytes. Existing v1/v2 frames decode unchanged.

## 0.4.1

### Patch Changes

- ddbab29: docs: republish so npm-displayed READMEs match shipped reality

  npm serves a package's README from the tarball snapshot taken at publish time, so
  the source-tree doc fixes do not reach npmjs.com until the next published version.
  This patch bump republishes all three packages so their npm pages show current docs:

  - chat-sdk: version badge 1.0.0 → 2.0.0; document the SEC-CR-001 downgrade-defense
    default-on behaviour + cryptoMode option; correct the batchAppend example (was
    documenting the internal snake_case wire DTO, not the exported camelCase
    BatchAppendItem — old example would not type-check); fix the error-code table
    (server_5xx → server_error, add the crypto-mode/unsupported codes); add the
    edited/deleted MessageRow fields; fix a dangling ../../LICENSE link.
  - wire-codec: drop the stale "private: true / no publish pipeline" claims (the
    package is public on npm via the changesets+OIDC pipeline); document the 0xC9
    mesh-bundle-v1 API + magic byte.
  - chat-widget: carry the CDN version/SRI/npm-install README fixes (already in the
    source tree) onto npm.

## 0.4.0

### Minor Changes

- 29b5d83: fix(wire-codec): brand `encodeHttpBody`/`decodeHttpBody` output as `HttpWireBytes`, distinct from `WireBytes`

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

  Bumped `minor` rather than `patch`: pre-1.0, the package's `^0.3.1` caret range auto-upgrades through
  all `0.3.x` releases, so a `patch` (`0.3.2`) would silently pull this compile-breaking type narrowing
  into any caret-pinned consumer's next install. A `minor` (`0.4.0`) sits outside the caret range and
  requires an explicit consumer opt-in.

## 0.3.0 — 2026-05-17

- Added mesh-bundle v1 wire format (magic byte `0xC9`): `encodeMeshBundle`, `decodeMeshBundle`, `meshBundleSignedRange`, `MeshBundleBytes` brand type, `MESH_BUNDLE_MAGIC_V1`, `MESH_BUNDLE_VERSION_V1` constants. Header layout: 61 B fixed (magic + version + sender_pubkey + msg_id + ts_s_offset + ttl_hops + channel_id_hash + body_len) + body (≤ 1500 B) + Ed25519 sig (64 B).
- Added error codes `MESH_BUNDLE_FIELD_INVALID`, `MESH_BUNDLE_TRUNCATED`, `MESH_BUNDLE_VERSION_UNSUPPORTED`, `MESH_BUNDLE_TOO_LARGE`, `MESH_BUNDLE_SIG_INVALID`.
- Fixed u32 unsigned coercion on `tsSecOffset` decode — boundary case `0xFFFFFFFF` previously read as `-1`.
- Note: mesh-bundle `tsSecOffset` is u32 seconds since `ROOM_EPOCH = 1767225600000` (2026-01-01 UTC), giving 136-year headroom. Validation: integer in [0, 2^32-1].
- Hygiene: `@types/node` added to devDependencies for hermetic install robustness.

## 0.2.0 — 2026-05-16

- Add branded `WireBytes` / `SealedBytes` types and `asWireBytes` / `asSealedBytes` lifters for compile-time enforcement of compress-then-seal ordering.

## 0.1.0 — 2026-05-16

- Phase 5 — production-ready: README, bench results, public API stable.
- Phase 4 — web/ migrates to direct import (@oxpulse/wire-codec), shims removed.
- Phase 3 — chat-sdk integration: encodeHttpBody/decodeHttpBody, compression option.
- Phase 2 — pluggable dict loader (setDictLoader/setDictBaseUrl), bundled RU/FA/EN dicts.
- Phase 1 — extracted from web/src/lib/\_kit/ as standalone workspace package.
