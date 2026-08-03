---
topic: roadmap
audience: agent-first
last_updated: 2026-08-03
status: live
related:
  - ./architecture/e2ee-model.md
  - ./architecture/threat-model.md
---

# oxpulse-chat-sdk — Wire Optimization Roadmap

> **Mission**: OxPulse chat is a communication protocol for conditions where
> ordinary stacks are dead (RU/IR throttled to 1 KB/s = 8 kbps). The wire-codec
> package (`@oxpulse/wire-codec`) is the SDK-side seam for this: CBOR + zstd +
> shared dictionaries + envelope compaction, all inside the AEAD ciphertext so
> a passive observer cannot tell dict-mode from dictless.
>
> **Master plan** (cross-repo, authoritative):
> `~/deploy/krolik-server/plans/oxpulse-chat/2026-05-04-1kbps-resilience-plan.md`
> and `docs/architecture/wire-optimization.md` in the `oxpulse-chat` repo.
> This document is the SDK-side tracking view — it mirrors the phase ladder
> from the perspective of what ships in **this** repo.

---

## Layer model (SDK scope)

```
┌─────────────────────────────────────────────────────────────┐
│ chat-sdk / chat-widget (HTTP API path)                      │  encodeHttpBody / decodeHttpBody
├─────────────────────────────────────────────────────────────┤
│ wire-codec (this repo — packages/wire-codec)                │  CBOR + zstd ± shared dict ± envelope-v2
├─────────────────────────────────────────────────────────────┤
│ chat-cryptor (oxpulse-chat repo — RoomRatchet + AES-GCM)    │  AEAD seal/open over Uint8Array
├─────────────────────────────────────────────────────────────┤
│ Signaling (WebSocket, partner-edge AmneziaWG)               │  Wire bytes
└─────────────────────────────────────────────────────────────┘
```

The SDK owns the **wire-codec** package and the **chat-sdk HTTP compression**
path. The **peer envelope** path (DataChannel, `encode()` / `decode()`) is
consumed by `oxpulse-chat/web` via the npm package
`@oxpulse/wire-codec@0.4.1` (with a small dist-import patch).

---

## Shipped to prod

| Phase | What | SDK artifact | Status |
|---|---|---|---|
| 2.A | CBOR codec, decoder-tolerant (accepts JSON + CBOR) | `codec.ts` `encode`/`decode` | shipped |
| 2.B | zstd-wasm capability + magic byte 0xC6 | `codec.ts` `ZSTD_MAGIC_PREFIX` | shipped |
| 2.C | cbor+zstd codec end-to-end | `codec.ts` | shipped |
| 2.E.A–D | RU/FA/EN shared zstd dicts (16 KB each) | `dicts/`, `dicts.ts` | shipped |
| 2.E.B | per-room cap + dict negotiation | `negotiateCap`, `negotiateDict` | shipped |
| 2.F.A | envelope-v2 compaction (id raw bytes + ts relative + kind enum) | `envelope-v2.ts`, `negotiateEnvelopeVersion` | shipped |
| T1 | typed `WireCodecError` with code union | `errors.ts` | shipped |
| T2 | branded `WireBytes`/`SealedBytes`/`HttpWireBytes`/`MeshBundleBytes` | `brands.ts` | shipped |
| B-1 | mesh-bundle-v1 (0xC9) signed encoder/decoder | `mesh-bundle.ts` | shipped |
| C1 | zstd-bomb defense (RFC 8878 frame parse, 256 KiB cap) | `codec.ts` `validateZstdFrame` | shipped |
| SDK HTTP | `compression` option on `SDKChatClient` (none/auto/dict) | `chat-sdk/src/client.ts` | shipped (default: none) |

### Envelope-v2 (Phase 2.F.A) — detail

Saves ~33 B per envelope by replacing wasteful field encodings:

| Field | v1 | v2 | Savings |
|---|---|---|---|
| `id` | 36-char UUID string | 16-byte raw `Uint8Array` | −21 B |
| `ts` | absolute ms (uint64) | uint32 ms-since-`ROOM_EPOCH` | −4 B |
| `kind` | 9-char ASCII string | uint8 enum (`k`) | −8 B |
| `from` | 64-char hex pubkey string | **stays** (Phase 2.F.B replaces) | 0 |

Wire shape (inside zstd-of-CBOR):
```
v1: { v: 1, id: string, ts: number, from: string, kind: string, body, ... }
v2: { v: 2, id: Uint8Array(16), ts: uint32, from: string, k: uint8, body, ... }
```

Magic byte `0xC8` + 1-byte dict-id (0x00 = dictless). Opportunistic per-frame:
if a value can't fit v2 (unknown kind, non-UUID id, ts outside uint32 window),
the encoder silently emits v1 for that frame. No wire break.

Forward-compat: `fromV2` returns `kind: "chat-unknown-future"` + `raw: k` for
unknown `k` bytes, so a client on protocol v(N) tolerates frames from v(N+1)
without crashing the receive pipeline.

`ROOM_EPOCH = 1_767_225_600_000` (2026-01-01 UTC) — inviolable constant.
uint32 ms = ~49.7 days range. Encoder falls back to v1 if `ts` is outside.

---

## Next: Phase 2.F.B — per-room peer-index

**Goal**: replace the 64-char hex `from` pubkey string with a 1-byte uint8
peer-index. **−64 B/msg** — the biggest single wire savings in the ladder.

### Why this is cheap to implement

The infrastructure **already exists**:
- `chat-cryptor.ts` (oxpulse-chat) already carries `peerIndex` (1 byte) in the
  SFrame AEAD header: `| epoch (4B) | peerIndex (1B) | ctr (8B) |`.
- `peer_index_map` is maintained by the RoomRatchet (`e2e/ratchet.ts`).
- Each peer is already assigned a collision-free uint8 index at KX time.

Phase 2.F.B just needs to use that index in the **envelope `from` field**
instead of the pubkey string — the crypto layer already knows who sent it.

### Prior art (GitHub research, 2026-08-03)

| System | Approach | Reference |
|---|---|---|
| **SFrame (RFC 9420)** | `senderId` is an integer in [0, 2^32); "assign a collision-free per-call ordinal (e.g. the sorted member index)" | briannadoubt/Frick `packages/core/src/e2ee.ts` |
| **Signal Sender Key** | `SenderKeyDistributionMessage` carries a `uint32 id` — the sender key ID replaces the full identity on the wire | signalapp/Signal-Server `service/src/main/proto/org/signal/chat/messages.proto` |
| **MLS (RFC 9420)** | `senderLeafIndex` — a `uint32` leaf position in the ratchet tree; the receiver resolves it to a leaf node | ignite-chat/ignite-frontend `src/discord/services/discord-dave.ts` |
| **bitchat** | `peerID_e` — fingerprint-derived short peer ID with epoch rotation; binds the tag to the announce carrying it | permissionlesstech/bitchat `docs/PEER-ID-ROTATION.md` |

**Consensus**: every group-E2EE protocol replaces the full pubkey with a small
integer on the wire. OxPulse is the only one that still carries the 64-char hex
string in the envelope — the SFrame header already has the index.

### Implementation plan (SDK side)

1. **`envelope-v2.ts`** — add v3 transform (or extend v2 with an optional `f`
   field):
   - `toV3(v1, peerIndex)`: replace `from: string` → `f: uint8`
   - `fromV3(v3, resolvePeer)`: reconstruct `from` via `resolvePeer(f) → pubkey`
   - `canEncodeAsV3`: same checks as v2 + `from` is in the peer-index map
2. **`codec.ts`** — new magic byte `0xCA` (next free slot after 0xC9
   mesh-bundle) + 1-byte dict-id + 1-byte peer-index. Or reuse `0xC8` with a
   v3 flag.
3. **`negotiateEnvelopeVersion`** — add `"envelope-v3"` cap; negotiate to 3
   only when ALL peers advertise it (same conservative intersection as v2).
4. **Tests** — forward-compat (unknown peer-index → sentinel), round-trip,
   negotiation, fallback to v2/v1 when peer-index map is incomplete.

### Implementation plan (oxpulse-chat side, cross-repo)

5. **`useBurnerChat.svelte.ts`** — pass `myPeerIndex` to `currentEncodeOpts()`;
   negotiate `envelope-v3` cap alongside `envelope-v2`.
6. **`useBurnerChat-receive.ts`** — resolve `f` byte → pubkey via
   `peer_index_map` from the ratchet; fall back to v2/v1 if unknown.
7. **`webrtc-keys.ts`** — advertise `envelope-v3` in caps when ratchet has
   assigned a peer-index.

### What does NOT change

- AEAD additionalData = SFrame header (epoch + peerIndex + counter) — unchanged.
- The peer-index is INSIDE the ciphertext (in the envelope), same as dict-id.
  A passive observer sees only the SFrame header's peerIndex (already leaked
  by the crypto layer) — no new fingerprint.
- Replay protection: strict `ctr > lastSeen` per (epoch, peerIndex) — unchanged.

---

## After 2.F.B: Phase 2.F.C — id-derivation

**Goal**: `id` is no longer on the wire. The receiver reconstructs it from
`(peerIndex, ctr)` — the same pair that already identifies the frame in the
SFrame header. **−17 B/msg** (additive on top of 2.F.B).

The `id` UUID is currently 16 raw bytes in v2. In v3 it disappears entirely:
the receiver derives `id = uuidV5(roomId, peerIndex, ctr)` or simply uses
`(peerIndex, ctr)` as the canonical message identifier.

This is the same insight as SFrame: `(senderId, counter)` IS the frame
identifier — no separate message ID is needed.

**Dependency**: requires 2.F.B (peer-index on the wire) — without it, `id`
can't be derived from the peer-index.

---

## Full phase ladder (reference)

| Priority | Phase | Description | Est savings | Status |
|---|---|---|---|---|
| ✅ | 2.A–E | CBOR + zstd + shared dicts + cap negotiation | −58..−85% | shipped |
| ✅ | 2.F.A | envelope-v2 (id raw + ts relative + kind enum) | −33 B | shipped |
| 🔥 | **2.F.B** | per-room peer-index (uint8 replaces 64-char pubkey) | **−64 B** | **next** |
| 🔥 | **2.F.C** | id-derivation from (peerIndex, ctr) | −17 B | planned (after 2.F.B) |
| 🟡 | 4.B | Fountain codes in send-queue (LT packets) | resilience under 30% loss | primitive done (4.A) |
| 🟡 | 5 | Degradation FSM + ClientBudgetHint (auto-tier on RTT/loss) | adaptive | planned |
| 🟢 | 6 | Offline OCR (Tesseract WASM) — photos with text → text envelope | photo→2 KB | planned |
| 🟢 | 7 | Codec2 voice messages (700 b/s async) | 875 B per 10 sec | planned |
| 🟢 | 8 | LPCNet over Codec2 — neural vocoder | near-telephone at 1.6 kbps | R&D |
| 🟢 | 9 | AVIF keyframe slideshow video | 2-4 kbps | R&D |
| 🟢 | 10 | sfu-kit SuspendVideo tier (Rust) | adaptive media | separate repo |
| 🟢 | 11 | AV1 store-and-forward video | 5-10 KB per 10 sec | R&D |
| 🟢 | 12 | E2E tc-netem 1 KB/s scenario test (CI gate) | confirms the stack | depends on all |

---

## Per-field accounting (target after 2.F.B + 2.F.C)

«ок» (2 chars body, RU) — theoretical breakdown:

| Layer / Field | v1 | v2 (shipped) | v3 (2.F.B) | v3+ (2.F.B+C) |
|---|---|---|---|---|
| AEAD SFrame header | 12 B | 12 B | 12 B | 12 B |
| AEAD GCM tag | 16 B | 16 B | 16 B | 16 B |
| zstd frame header | ~6 B | ~6 B | ~6 B | ~6 B |
| CBOR map header + version | 2 B | 2 B | 2 B | 2 B |
| `id` UUID | 38 B (string) | 17 B (raw) | 17 B (raw) | **0 B** (derived) |
| `ts` | 7 B (abs ms) | 5 B (rel uint32) | 5 B | 5 B |
| `from` peer-pubkey | 66 B (string) | 66 B (string) | **2 B** (uint8) | 2 B (uint8) |
| `kind` | 10 B (string) | 2 B (uint8) | 2 B (uint8) | 2 B (uint8) |
| `body` "ок" | ~5 B (post-dict) | ~5 B | ~5 B | ~5 B |
| **Total wire** | **~162 B** | **~131 B** | **~67 B** | **~50 B** |

Latency at 1 KB/s = bytes in ms (1024 B/s ≈ 1 ms/B).
«ок» at 50 B = **50 ms** delivery time at 1 KB/s.

---

## SDK HTTP path (chat-sdk / chat-widget)

The HTTP API path (`POST /api/sdk/messages`) has a separate, simpler
compression story:

| Consumer | `compression` option | Default | Notes |
|---|---|---|---|
| `SDKChatClient` (direct) | `'none' \| 'auto' \| 'dict'` | `'none'` | Opt-in; `auto` = dictless 0xC6, `dict` = 0xC7 + shared dict |
| `chat-widget` | hardcoded `'none'` | `'none'` | Widget uses plaintext crypto mode; HTTP compression off |

The HTTP path is NOT the anti-censorship path — it's the embeddable-widget
integration path. The anti-censorship path is the peer envelope (DataChannel)
in `oxpulse-chat/web`. Enabling HTTP compression in the widget is a future
optimization but not on the 1 KB/s critical path.

---

## Magic-byte registry (stable — never renumber)

| Bytes | Codec | Phase | Status |
|---|---|---|---|
| `0x7B` `{` / `0x5B` `[` | JSON v1 envelope | pre-2.A | legacy |
| `0xC6` | cbor + zstd dictless v1 | 2.D | shipped |
| `0xC7 0x01..0x03` | cbor + zstd + dict (RU/FA/EN) | 2.E.B–D | shipped |
| `0xC8 0x00..0x03` | cbor + zstd + envelope-v2 | 2.F.A | shipped |
| `0xC9` | mesh-bundle v1 (signed) | B-1 | shipped |
| `0xCA..0xCF` | reserved (Phase 2.F.B peer-index, etc.) | future | — |

---

## Cross-repo dependencies

| This repo (SDK) | Consumer (oxpulse-chat) | Interface |
|---|---|---|
| `@oxpulse/wire-codec` | `web/src/lib/useBurnerChat-*.ts` | `encode()`, `decode()`, `negotiateCap`, `negotiateDict`, `negotiateEnvelopeVersion` |
| `@oxpulse/wire-codec` | `web/src/lib/chat-cryptor.ts` | `WireBytes` / `SealedBytes` brands (compress-then-seal) |
| `@oxpulse/chat-sdk` | `web/src/lib/` (HTTP fallback) | `SDKChatClient` with `compression` option |
| `@oxpulse/wire-codec` | `web/package.json` | `@oxpulse/wire-codec@0.4.1` + `patches/` dist-import fix |

Changes to `wire-codec` ship as npm releases; `oxpulse-chat` bumps the version
in `web/package.json` and re-applies the patch. The patch is ESM `.js`
extension fixes in dist imports — it should be upstreamed to eliminate the
patch dependency.
