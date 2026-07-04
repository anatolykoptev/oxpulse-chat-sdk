# @oxpulse/chat-sdk

[![version](https://img.shields.io/badge/version-2.0.0-blue)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](./LICENSE)

TypeScript client for the OxPulse encrypted chat message log API.

> **v2.0.0 — production release.**
> The `web/` mirror (`$lib/api/sdkChat`) has been deleted.
> All production code imports directly from this package.
>
> **v2.0.0 is a security-driven major bump (SEC-CR-001):** with an `e2ee` provider
> configured, downgrade defense to plaintext is now default-on — see [E2EE](#e2ee).

## Install

```bash
npm install @oxpulse/chat-sdk
```

## Quick start

```ts
import { SDKChatClient } from '@oxpulse/chat-sdk';

// JWT obtained from POST /api/sdk/tokens (server-side mint).
const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'raw-jwt-here', // do NOT include "Bearer " prefix
});

// Send a sealed (E2EE) message.
const { seq, msgId } = await client.send('room-123', {
  senderUid: 'user-1',
  sealed: ciphertextArrayBuffer,
});

// List historical messages.
const { items, hasNext } = await client.list('room-123', { afterSeq: 0, limit: 100 });

// Subscribe to live messages via SSE.
// Auth uses a short-lived ticket (RFC 6750 compliant — no JWT in URL).
// subscribe() auto-reconnects with exponential backoff and replays missed
// messages via list() before re-attaching the live stream.
const teardown = client.subscribe('room-123', {
  onMessage: (row) => {
    // row.sealed — ciphertext as ArrayBuffer; pass to your E2EE decrypt function.
    console.log('new message seq=%d', row.seq);
  },
  onError: (err) => console.error('SSE error', err),
});

// Stop subscribing.
teardown();
```

## API reference

### `new SDKChatClient(options)`

| Option | Type | Description |
|---|---|---|
| `jwt` | `string` | Raw SDK JWT. Do NOT include `"Bearer "` prefix. |
| `baseUrl` | `string?` | URL prefix; default `''` (same-origin). |
| `compression` | `'none' \| 'auto' \| 'dict'` | Wire compression; default `'none'`. |
| `e2ee` | `E2EEOptions?` | End-to-end encryption config. |
| `cryptoMode` | `'sframe-static' \| 'plaintext'` | Expected server crypto mode. Defaults to `'sframe-static'` when `e2ee` is configured (downgrade defense, SEC-CR-001), otherwise auto-detected. |

### Methods

#### `send(roomId, args): Promise<{ seq, msgId }>`

Send a single sealed message. Returns server-assigned `seq` and `msgId`.

#### `sendText(roomId, args): Promise<{ seq, msgId }>`

Send a plaintext message with auto-seal. Requires `e2ee` configured.

#### `sendOptimistic(roomId, args): OptimisticHandle`

Enqueue message for offline-safe delivery with retry. Returns handle with
`onPending`, `onSucceeded`, `onFailed` callbacks.

#### `sendTextOptimistic(roomId, args): OptimisticHandle`

Like `sendOptimistic()` but auto-seals plaintext before enqueue. Use instead
of `sendOptimistic()` when `e2ee` is configured.

#### `batchAppend(roomId, items): Promise<void>`

Send multiple pre-sealed messages in a single `POST /api/sdk/messages/batch` transaction.

- `room_id` is injected automatically per item.
- `created_at` is set server-side; do not include it.
- Does **NOT** auto-seal — callers must set `sealed` to the pre-sealed ciphertext as
  an `ArrayBuffer` before calling (the SDK base64-encodes it for the wire internally).
  Use `sendText` / `sendTextOptimistic` for auto-seal.
- Scope required: `chat:write:<room_id>`.

```ts
const items: BatchAppendItem[] = messages.map((m) => ({
  msgId: m.id,
  sealed: m.sealedBytes, // ArrayBuffer
}));
await client.batchAppend('room-123', items);
```

#### `list(roomId, args?): Promise<ListResult>`

Fetch message history. Supports cursor pagination via `ListArgs.afterSeq` / `beforeSeq`.

#### `subscribe(roomId, args): () => void`

Open an SSE stream. Auto-reconnects with exponential backoff (max ~30 s jitter).
On reconnect, replays missed messages via `list()` before re-attaching.

Returns a teardown function; call it to unsubscribe and close the stream.

#### Room management

`createRoom(args?)`, `updateRoom(roomId, args)`, `listRooms()`, `getRoom(roomId)`,
`archiveRoom(roomId)` — full CRUD for SDK rooms.

#### Message operations

`deleteMessage(roomId, msgId)`, `pinMessage(roomId, msgId)`,
`unpinMessage(roomId, msgId)`, `listPinnedMessages(roomId)`,
`updateMessage(roomId, msgId, args)`.

#### Reactions

`addReaction(roomId, msgId, reaction)`, `removeReaction(roomId, msgId, reaction)`,
`getReactions(roomId, msgId)`.

#### Presence / typing

`sendTyping(roomId, ttlSecs?)`, `sendPresence(roomId)`, `getPresence(roomId)`,
`sendReadReceipt(roomId, seq)`.

#### File attachments

`sendFile(roomId, args)` — presign-then-upload helper. See
`packages/chat-sdk/src/attachments.ts` for the `SendFileArgs` shape.

### E2EE

Use the built-in SFrame provider:

```ts
import { SDKChatClient, createSFrameProvider } from '@oxpulse/chat-sdk';

const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'jwt...',
  e2ee: {
    provider: 'sframe',
    getKey: async ({ roomId }) => derivedKeyForRoom(roomId),
  },
});
```

Or supply a custom `CryptoProvider`:

```ts
const client = new SDKChatClient({
  baseUrl: '...',
  jwt: '...',
  e2ee: {
    provider: myProvider, // implements CryptoProvider { seal, unseal }
  },
});
```

`subscribe()` decrypts each message row asynchronously in a per-room serial
chain to preserve ordering. Rows that fail decryption are delivered with
`MessageRow.unsealError: 'replay' | 'auth' | 'unknown'` instead of being dropped.

#### Downgrade defense (default-on since v2.0.0, SEC-CR-001)

When an `e2ee` provider is configured, `cryptoMode` defaults to `'sframe-static'` —
the client refuses to accept a server-emitted `crypto_mode: 'plaintext'` for that
room. A mismatch throws `SDKChatError('crypto_mode_mismatch')` and poisons **only
that room** (sibling rooms on the same client keep working); recreate the client
instance to retry a poisoned room. Constructing with an `e2ee` provider **and**
`cryptoMode: 'plaintext'` now throws `invalid_args` at construction (contradictory
config) instead of silently sending plaintext. An e2ee client with no explicit
`cryptoMode` seals and sends immediately by default — no discovery round-trip
required before the first send. Clients with no `e2ee` provider are unaffected:
plaintext remains a valid auto-detected mode.

### `BatchAppendItem`

```ts
interface BatchAppendItem {
  msgId: string;                 // UUID
  sealed?: ArrayBuffer | null;   // pre-sealed ciphertext; SDK base64-encodes for the wire
  threadRootMsgId?: string | null;
  productRef?: string | null;
  productMeta?: unknown;
}
```

### `MessageRow`

```ts
interface MessageRow {
  seq: number;
  msgId: string;
  senderUid: string;
  sealed: ArrayBuffer;     // ciphertext
  plaintext?: ArrayBuffer; // set by SDK when e2ee is configured
  unsealError?: 'replay' | 'auth' | 'unknown'; // set on decrypt failure
  createdAt: string;       // ISO 8601
  threadRootMsgId: string | null;
  productRef: string | null;
  productMeta: unknown;    // catalog metadata (title/price/currency/imageUrl/productUrl); set when productRef is set
  editedAt?: string;       // last-edit timestamp; unset when never edited
  deletedAt?: string;      // soft-delete timestamp; unset when not deleted
  editCount?: number;      // number of edits; 0 when never edited
}
```

## Error model

All failures throw `SDKChatError` with a typed `code` field:

| Code | When |
|------|------|
| `unauthorized` | 401 — invalid or expired JWT / ticket |
| `forbidden` | 403 — missing scope |
| `not_found` | 404 |
| `rate_limited` | 429 |
| `invalid_args` | 400–4xx (other than above); also thrown at construct time for contradictory options (e.g. `e2ee` + `cryptoMode: 'plaintext'`) |
| `server_error` | 5xx |
| `network` | fetch/network-level failure |
| `unsupported` | an e2ee-only operation (e.g. `sendText`) called without `e2ee` configured |
| `crypto_mode_mismatch` | server-emitted `crypto_mode` doesn't match the configured/discovered expectation (SEC-CR-001 downgrade defense) — poisons that room |
| `crypto_mode_poisoned` | room already poisoned by a prior `crypto_mode_mismatch`; recreate the client to retry |
| `crypto_mode_undiscovered` | `sendText` called before `crypto_mode` is known and no `e2ee` provider is configured (e2ee clients default to `'sframe-static'` and never hit this) |

## Compression (optional)

Enable zstd compression to reduce payload size:

```ts
const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'jwt...',
  compression: 'auto',       // zstd dictless when payload ≥ 256 B
});
```

See `@oxpulse/wire-codec` README for codec internals and dict management.

## CSP compatibility

`@oxpulse/chat-sdk` is **strict-CSP-safe** — zero `eval()`, zero `new Function()`.
Verified by `src/__tests__/csp-cleanliness.test.ts` on every build.

Compatible with:

```
script-src 'self' 'wasm-unsafe-eval' 'nonce-...' 'strict-dynamic'
```

## Notifications (Web Push)

Use `SDKPushClient` to manage Web Push subscriptions for buyer/seller notifications.

```ts
import { SDKChatClient, SDKPushClient } from '@oxpulse/chat-sdk';

const chat = new SDKChatClient({ baseUrl, jwt });
const push = new SDKPushClient({ baseUrl, jwt });

// 1. fetch VAPID key
const vapidKey = await push.getVapidPublicKey();

// 2. browser subscribe
const reg = await navigator.serviceWorker.ready;
const subscription = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidKey,
});

// 3. register with server
const { deviceId } = await push.subscribe();

// 4. listen for server-rotated endpoints
push.attachSubscriptionChangeListener({
  onResubscribed: newEndpoint => console.log('rotated', newEndpoint),
  onLost: () => console.log('permission revoked'),
});
```

Permission check before subscribing:

```ts
const perm = await SDKPushClient.requestPermission();
if (perm === 'granted') {
  const { endpoint, deviceId } = await push.subscribe();
}
```

All failures throw `SDKPushError` with a typed `code: SDKPushErrorCode` field.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
