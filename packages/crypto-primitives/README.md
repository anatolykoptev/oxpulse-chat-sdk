# @oxpulse/crypto-primitives

X25519 + HKDF-SHA256 + AES-256-GCM primitives, the `MessageEnvelope v2`
wire codec (authenticated binding transcript), and timing-safe comparison
helpers used by SDK + mesh transports to carry pairwise-sealed messages
opaquely.

## Public surface (flat exports — ADR-003)

All exports are flat from the package root (`@oxpulse/crypto-primitives`);
there are no sub-path exports.

- **X25519** — `generateEphemeralKeypair`, `deriveSharedSecret`
- **HKDF-SHA256** — `deriveKey`
- **AEAD (AES-256-GCM)** — `aesGcmSeal`, `aesGcmOpen`
- **Addressing** — `derivePeerIdTarget`
- **Envelope codec** — `encodeMessageEnvelope`, `decodeMessageEnvelope`,
  `MESSAGE_ENVELOPE_MAGIC`, `MESSAGE_ENVELOPE_VERSION`, `HEADER_BYTES`,
  `MessageEnvelopeV2`
- **Pairwise seal** — `sealMessage`, `openMessage`, `SealMessageArgs`,
  `OpenMessageArgs`, `OpenMessageResult`, `ReplayWindow`
- **Timing-safe comparison (ADR-008)** — `timingSafeEqual`,
  `timingSafePubkeyEqualB64u`

## Timing-safe comparison (CWE-208 invariant)

`timingSafeEqual(a, b)` performs an XOR-reduce over `Uint8Array` and
returns `false` on length mismatch (length is non-secret). No
short-circuit path based on byte content.

`timingSafePubkeyEqualB64u(a, b)` decodes both base64url strings to
bytes and delegates to `timingSafeEqual`.

**INVARIANT:** NEVER use `===` on crypto-derived b64u strings (pubkeys,
MAC tags, signatures, sessionIds). `===` leaks the first-mismatch byte
position via timing (OWASP ASVS V11.3.1, CWE-208). Use
`timingSafePubkeyEqualB64u` for any comparison that influences a
security decision.

```ts
import { timingSafeEqual, timingSafePubkeyEqualB64u } from '@oxpulse/crypto-primitives';

timingSafeEqual(macA, macB);                 // Uint8Array vs Uint8Array
timingSafePubkeyEqualB64u(pubA_b64u, pubB_b64u); // base64url strings
```

## Dep arrow

```
@oxpulse/identity → @oxpulse/crypto-primitives → { @oxpulse/mesh-core, web, @oxpulse/chat-sdk }
```

**This package MUST NOT import from `@oxpulse/identity`.** Shared helpers
(e.g. `toArrayBuffer`) are deliberately copy-pasted into `src/_internal.ts`
per operator decision #7 of the Phase 1 plan (identity-extraction-adr §2.2
sole-consumer audit pattern).

## Non-goals

- No IndexedDB.
- No UI components.
- No transport logic (routing, WebSocket, BLE).
- No group ratchet. See `web/src/lib/chat-cryptor.ts::sealGroupFrame`
  (renamed in Phase 2) for group AEAD.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).

## Usage (sender)

```ts
import { sealMessage } from '@oxpulse/crypto-primitives';
const envelopeBytes = await sealMessage({
  plaintext,
  recipientX25519Pub,
  senderEd25519PrivKey,
  senderEd25519PubKey,
  msgId,
});
// Transport (SDK or mesh) carries envelopeBytes opaquely by recipientAddr.
```

## Usage (recipient)

```ts
import { openMessage, decodeMessageEnvelope } from '@oxpulse/crypto-primitives';
// Peek recipientAddr to route to local user; lookup expected sender pubkey by sig-cache:
const env = decodeMessageEnvelope(envelopeBytes);
const { plaintext, msgId, flags } = await openMessage({
  envelopeBytes,
  recipientX25519Priv,
  recipientX25519Pub,
  expectedSenderEd25519Pub,
});
```
