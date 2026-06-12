# @oxpulse/wire-codec

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
- Phase 1 — extracted from web/src/lib/_kit/ as standalone workspace package.
