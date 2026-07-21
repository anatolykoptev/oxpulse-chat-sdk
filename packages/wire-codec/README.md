# @oxpulse/wire-codec

[![npm](https://img.shields.io/npm/v/@oxpulse/wire-codec)](https://www.npmjs.com/package/@oxpulse/wire-codec)
[![license](https://img.shields.io/npm/l/@oxpulse/wire-codec)](./LICENSE)

TypeScript codec for compressed OxPulse chat payloads: JSON/CBOR, zstd, and shared dictionaries for SDK HTTP and peer envelopes.

Use it when you need to encode or decode wire bytes before sealing (E2EE) or sending to the OxPulse SDK HTTP API. It is designed for the compress-then-seal pattern: encode first, then encrypt the resulting bytes.

## Install

```sh
npm install @oxpulse/wire-codec@0
# or
pnpm add @oxpulse/wire-codec@0
# or
yarn add @oxpulse/wire-codec@0
```

## Quick start

### SDK HTTP body

For `POST /api/sdk/messages` request bodies:

```ts
import {
  encodeHttpBody,
  decodeHttpBody,
  ensureWireCodecReady,
  setDictBaseUrl,
} from '@oxpulse/wire-codec';

await ensureWireCodecReady();
setDictBaseUrl('/dicts'); // optional - only needed for 0xC7 dict path

const json = JSON.stringify({ hello: 'world' });
const bytes = encodeHttpBody(new TextEncoder().encode(json));
const decoded = decodeHttpBody(bytes);
```

### Peer envelope

For WebSocket/RTC peer-to-peer frames:

```ts
import { encode, decode, ensureWireCodecReady } from '@oxpulse/wire-codec';

await ensureWireCodecReady();

const frame = encode(
  { kind: 'chat-msg', text: 'hello' },
  { cbor: true, zstd: true, dict: 'zstd-dict-ru-v1' },
);
const obj = decode(frame);
```

## API surface

| Export | Description |
|---|---|
| `encode(value, opts?)` | Peer envelope: zstd-of-CBOR, 1-byte dict-id, `0xC8` magic for v2 |
| `decode(bytes)` | Peer envelope decode (auto-detects magic byte) |
| `encodeHttpBody(jsonBytes, dictName?)` | Server HTTP body: zstd-of-JSON, 2-byte BE dict-id, `0xC6`/`0xC7` magic |
| `decodeHttpBody(bytes)` | Server HTTP body decode; returns parsed JSON value |
| `ensureWireCodecReady()` | Async zstd-wasm init + eager dict preload; idempotent |
| `asWireBytes(bytes)` | Lift a `Uint8Array` into the `WireBytes` domain |
| `asHttpWireBytes(bytes)` | Lift a `Uint8Array` into the `HttpWireBytes` domain |
| `asSealedBytes(bytes)` | Lift a `Uint8Array` into the `SealedBytes` domain |
| `asMeshBundleBytes(bytes)` | Lift a `Uint8Array` into the `MeshBundleBytes` domain |
| `WireBytes` / `HttpWireBytes` / `SealedBytes` / `MeshBundleBytes` | Phantom-branded byte types |
| `setDictLoader(loader)` | Plug in a custom dict fetch function |
| `setDictBaseUrl(url)` | Set base URL for the default fetch-based dict loader |
| `loadDict(name)` | Pre-load a named dict into the in-memory cache |
| `getDictBytes(name)` | Return cached dict bytes, or `undefined` |
| `ALL_DICTS` / `DICT_NAME_TO_ID` / `DICT_ID_TO_NAME` | Dict registry and wire-id maps |
| `DictName` / `DictLoader` | Types: `'zstd-dict-ru-v1' \| ...` and `(name) => Promise<Uint8Array>` |
| `WireCodecError` | Typed error with `.code` and optional `.details` |
| `WireCodecErrorCode` / `WireCodecErrorDetail` / `WireCodecErrorDetails` | Error-code union and detail types |
| `WireCap` / `EncodeOpts` / `ALL_CAPS` | Capability union, encode options, capability list |
| `negotiateCap(mine, theirs)` | Pick the highest shared codec capability |
| `negotiateDict(mine, others, priority?)` | Pick the strongest shared zstd dict |
| `capToOpts(cap)` | Convert a negotiated `WireCap` to `EncodeOpts` |
| `negotiateEnvelopeVersion(mine, others)` | Pick envelope v1 or v2 |
| `canonicalizeEnvelope(v)` | Strip undefined keys to make payloads canonical |
| `isCborMagic(bytes)` | Returns true when the first byte is not JSON |
| `ROOM_EPOCH` / `KIND_TO_BYTE` / `BYTE_TO_KIND` | Envelope-v2 constants |
| `ChatKindEncodable` | Type of kind strings accepted by `toV2` |
| `uuidToBytes(s)` / `bytesToUuid(b)` | Convert UUID string to 16 bytes and back |
| `canEncodeAsV2(v)` / `toV2(v)` / `fromV2(v)` | Envelope-v2 transforms |
| `encodeMeshBundle(args)` / `decodeMeshBundle(bytes)` / `meshBundleSignedRange(bytes)` | Mesh-bundle v1 encode/decode/signature range |
| `MESH_BUNDLE_MAGIC_V1` / `MESH_BUNDLE_VERSION` / `MESH_BUNDLE_MAX_BODY` | Mesh-bundle constants |
| `MeshBundleEncodeArgs` / `MeshBundleDecoded` / `MeshBundleBytes` | Mesh-bundle types |

## Compression decision matrix

| Mode | Magic | When to use |
|---|---|---|
| `none` (plain JSON) | `0x7B`/`0x5B` | Always works; no setup; baseline for small payloads |
| `auto` (dictless zstd) | `0xC6` | Large payloads; no dict assets required |
| `dict` (zstd + dict) | `0xC7` | Best ratio for known-language text; requires dict files |

## Magic-byte protocol

| First byte | Format | Notes |
|---|---|---|
| `0x7B` / `0x5B` | Plain JSON | `{` / `[` start |
| `0xC6` | zstd-dictless | `[0xC6][zstd_frame]` |
| `0xC7` | zstd-with-dict (HTTP) | `[0xC7][dict_id u16 BE][zstd_frame]` |
| `0xC8` | peer envelope v2 (CBOR) | NOT for HTTP - use peer `encode()` |
| `0xC9` | mesh-bundle v1 (signed) | `[0xC9][version][header][body][Ed25519 sig]` - use `encodeMeshBundle`/`decodeMeshBundle` |

## Bundled dictionaries

Three zstd shared dictionaries are bundled in `packages/wire-codec/dicts/`, each **16 384 B** (~16 KB):

| File | Language | Wire ID |
|---|---|---|
| `zstd-dict-ru-v1.zstd` | Russian | `0x01` |
| `zstd-dict-fa-v1.zstd` | Farsi / Persian | `0x02` |
| `zstd-dict-en-v1.zstd` | English | `0x03` |

Total on-disk: **48 KB** (one-time per SW cache version).

Every client ships all three dicts. Per-language gating would fingerprint the user's language at handshake; carrying the full set makes the dict-id leak benign.

## Bench numbers

Measured on Node.js 20, Oracle Cloud ARM64 (4-core, 24 GB). Numbers are indicative; your mileage will vary by payload entropy and hardware.

### Peer envelope size (full chat-msg envelopes)

| Payload | JSON | CBOR | zstd (0xC6) | vs JSON |
|---|---|---|---|---|
| chat-msg short (body=`"hi"`) | 174 B | 152 B | 73 B | **−58%** |
| chat-msg medium (body ~50 chars) | 237 B | 212 B | 86 B | **−64%** |
| chat-msg long-repeat (480 chars) | 667 B | 643 B | 101 B | **−85%** |
| chat-typing | 180 B | 158 B | 79 B | **−56%** |
| chat-receipt (1 target) | 240 B | 214 B | 102 B | **−58%** |
| chat-receipt (10 targets) | 591 B | 556 B | 133 B | **−78%** |
| msg + 32 B binary (ThumbHash) | 462 B | 194 B | 86 B | **−81%** |

### Dict compression on chat message bodies (body bytes only)

| Lang | JSON avg | dictless avg | dict (0xC7) avg | dict vs JSON | dict vs dictless |
|---|---|---|---|---|---|
| RU | 40.4 B | 49.4 B | 27.9 B | **−31%** | **−44%** |
| FA | 38.7 B | 47.5 B | 28.2 B | **−27%** | **−41%** |
| EN | 26.0 B | 34.3 B | 22.8 B | **−12%** | **−34%** |

EN's lower JSON saving reflects Latin-script entropy; the dict-vs-dictless win (−34%) is the operative metric. Without a dict, short EN payloads expand due to zstd framing overhead.

### Envelope-v2 (0xC8) vs v1 - RU short bodies (n=50 full envelopes)

| Format | Avg size | vs JSON |
|---|---|---|
| JSON | 204.3 B | - |
| v1 dictless (0xC6) | 181.8 B | −11% |
| v1 dict (0xC7) | 179.4 B | −12% |
| v2 dictless (0xC8, dict-id=0) | 157.9 B | −23% |
| v2 dict (0xC8, dict-id=1) | 139.1 B | **−32%** |

v2 encodes UUID `id` as 16 raw bytes (not 36-char hex string) and `ts` as a delta from the room epoch, shaving ~37 B per envelope vs v1.

## Dict regeneration

Corpus generators and the training script live in `tools/`:

```sh
# Requires: node >=20, zstd CLI >=1.5 (apt install zstd)
sh tools/train-zstd-dict.sh
```

Each `tools/gen-<lang>-chat-corpus.mjs` generates synthetic conversational messages (~120–600 KB); `zstd --train` produces a 16 KB dictionary per language. Output goes to `web/static/dicts/` (served to browsers) and is mirrored into `packages/wire-codec/dicts/` for Node.js tests.

Dict format: standard zstd trained dictionary (magic `0x37 0xA4 0x30 0xEC`, RFC 8878 Appendix B).

Wire ID assignments are stable - **never renumber**:

| Dict | Wire ID byte |
|---|---|
| `zstd-dict-ru-v1` | `0x01` |
| `zstd-dict-fa-v1` | `0x02` |
| `zstd-dict-en-v1` | `0x03` |

Source of truth: `packages/wire-codec/src/dicts.ts`.

## Publishing

Published to npm as a public package via automated [Changesets](https://github.com/changesets/changesets) + npm OIDC trusted publishing. See [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
