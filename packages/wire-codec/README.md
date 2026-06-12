# @oxpulse/wire-codec

TypeScript codec for binary chat envelopes. Supports zstd compression with optional shared dictionaries for RU/FA/EN. Designed for E2EE chat where the server is blind to compression (compress-then-seal pattern).

## Install

```sh
npm i @oxpulse/wire-codec
```

> **Note:** the package is currently `private: true` (workspace-only). See [Publishing](#publishing) below.

## Quick start

### HTTP body encode/decode

For SDK HTTP requests (`/api/sdk/messages`):

```ts
import {
  encodeHttpBody,
  decodeHttpBody,
  ensureWireCodecReady,
  setDictBaseUrl,
} from '@oxpulse/wire-codec';

await ensureWireCodecReady();
setDictBaseUrl('/dicts'); // optional — only required for 0xC7 dict path

const bodyJson = JSON.stringify({ hello: 'world' });
const bytes = encodeHttpBody(
  new TextEncoder().encode(bodyJson),
  // optional: 'zstd-dict-ru-v1' | 'zstd-dict-fa-v1' | 'zstd-dict-en-v1'
);
const decoded = decodeHttpBody(bytes); // returns parsed JSON value
```

### Peer envelope

For WebSocket/RTC peer-to-peer (CBOR + 1-byte dict-id, 0xC8 magic for v2):

```ts
import { encode, decode } from '@oxpulse/wire-codec';

const frame = encode(
  { kind: 'chat-msg', text: '...' },
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
| `setDictLoader(loader)` | Plug in a custom dict fetch function |
| `setDictBaseUrl(url)` | Set base URL for default `fetch`-based dict loader |
| `ensureWireCodecReady()` | Async zstd-wasm init; idempotent — safe to call multiple times |
| `loadDict(name)` | Pre-load a named dict into the in-memory cache |
| `getDictBytes(name)` | Return cached dict bytes (undefined if not loaded) |
| `DICT_ID_TO_NAME` | `Record<number, DictName>` — wire ID → name |
| `DICT_NAME_TO_ID` | `Record<DictName, number>` — name → wire ID |
| `ALL_DICTS` | `readonly DictName[]` — all shipped dicts in negotiation-priority order |
| `DictName` | `'zstd-dict-ru-v1' \| 'zstd-dict-fa-v1' \| 'zstd-dict-en-v1'` |
| `DictLoader` | `(name: DictName) => Promise<Uint8Array>` |

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
| `0xC8` | peer envelope v2 (CBOR) | NOT for HTTP — use peer `encode()` |

## Bundled dictionaries

Three zstd shared dictionaries are bundled in `packages/wire-codec/dicts/`, each **16 384 B** (~16 KB):

| File | Language | Wire ID |
|---|---|---|
| `zstd-dict-ru-v1.zstd` | Russian | `0x01` |
| `zstd-dict-fa-v1.zstd` | Farsi / Persian | `0x02` |
| `zstd-dict-en-v1.zstd` | English | `0x03` |

Total on-disk: **48 KB** (one-time per SW cache version).

Every client ships all three dicts. Per-language gating would fingerprint the user's language at handshake — carrying the full set makes the dict-id leak benign.

## Bench numbers

Measured on Node.js 20, ARM 24 GB (krolik/Oracle Cloud). Numbers are indicative; your mileage may vary by payload entropy and hardware.

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

EN's lower JSON saving reflects Latin-script entropy; the dict-vs-dictless win (−34%) is the operative metric — without dict, short EN payloads expand due to zstd framing overhead.

### Envelope-v2 (0xC8) vs v1 — RU short bodies (n=50 full envelopes)

| Format | Avg size | vs JSON |
|---|---|---|
| JSON | 204.3 B | — |
| v1 dictless (0xC6) | 181.8 B | −11% |
| v1 dict (0xC7) | 179.4 B | −12% |
| v2 dictless (0xC8, dict-id=0) | 157.9 B | −23% |
| v2 dict (0xC8, dict-id=1) | 139.1 B | **−32%** |

v2 encodes UUID id as 16 raw bytes (not 36-char hex string) and ts as a delta from the room epoch — shaving ~37 B per envelope vs v1.

## Dict regeneration

Corpus generators and the training script live in `tools/`:

```sh
# Requires: node ≥20, zstd CLI ≥1.5 (apt install zstd)
sh tools/train-zstd-dict.sh
```

Each `tools/gen-<lang>-chat-corpus.mjs` generates synthetic conversational messages (~120–600 KB); `zstd --train` produces a 16 KB dictionary per language. Output goes to `web/static/dicts/` (served to browsers) and is mirrored into `packages/wire-codec/dicts/` for Node.js tests.

Dict format: standard zstd trained dictionary (magic `0x37 0xA4 0x30 0xEC`, RFC 8878 Appendix B).

Wire ID assignments are stable — **never renumber**:

| Dict | Wire ID byte |
|---|---|
| `zstd-dict-ru-v1` | `0x01` |
| `zstd-dict-fa-v1` | `0x02` |
| `zstd-dict-en-v1` | `0x03` |

Source of truth: `packages/wire-codec/src/dicts.ts`.

## Publishing

The package is `private: true` — workspace-only for now. To publish:

1. Flip `"private": false` in `packages/wire-codec/package.json`.
2. Add `"publishConfig": { "access": "public" }`.
3. Run `npm publish --workspace packages/wire-codec` from the repo root.

No npm publish pipeline exists yet in this repo (GHA workflows were removed — see project memory). Wire up a release workflow before flipping `private`.

## License

AGPL-3.0-or-later. Internal workspace-only; publish step is a deliberate future decision.
