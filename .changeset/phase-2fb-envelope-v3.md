---
"@oxpulse/wire-codec": minor
---

Phase 2.F.B — envelope-v3 peer-index compaction. Replace the 64-char hex
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
