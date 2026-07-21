# @oxpulse/chat-sdk

[![npm](https://img.shields.io/npm/v/@oxpulse/chat-sdk)](https://www.npmjs.com/package/@oxpulse/chat-sdk)
[![license](https://img.shields.io/npm/l/@oxpulse/chat-sdk)](./LICENSE)

TypeScript client for the OxPulse SDK HTTP chat API: send, list, subscribe, room management, reactions, attachments, push subscriptions, and optional sframe-ratchet E2EE.

Use it in marketplace or third-party integrations that talk to the OxPulse SDK backend. It is CSP-safe: no `eval()` or `new Function()` calls.

## Install

```sh
npm install @oxpulse/chat-sdk@3
# or
pnpm add @oxpulse/chat-sdk@3
# or
yarn add @oxpulse/chat-sdk@3
```

## Quick start

```ts
import { SDKChatClient } from '@oxpulse/chat-sdk';

const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'raw-jwt-from-your-backend', // do NOT include "Bearer " prefix
});

const { seq, msgId } = await client.send('room-123', {
  senderUid: 'user-1',
  sealed: ciphertextArrayBuffer,
});

const { items, hasNext, next } = await client.list('room-123', { afterSeq: 0, limit: 50 });

const teardown = client.subscribe('room-123', {
  onMessage: (row) => console.log('seq', row.seq, 'msgId', row.msgId),
  onError: (err) => console.error(err),
});

// later
teardown();
```

## API surface

### `SDKChatClient`

Constructor options (`SDKChatClientOptions`):

- `baseUrl` - server URL (no trailing slash)
- `jwt` - raw SDK JWT (no `Bearer ` prefix)
- `compression?: 'none' | 'auto' | 'dict'` - default `'none'`
- `minCompressBytes?: number` - threshold for `auto`/`dict` (default 256)
- `dictHint?: 'zstd-dict-ru-v1' | 'zstd-dict-fa-v1' | 'zstd-dict-en-v1'`
- `e2ee?: E2EEOptions` - see [E2EE](#e2ee)
- `cryptoMode?: 'sframe-static' | 'plaintext'` - defaults to `'sframe-static'` when `e2ee` is set
- `appId?: string`

Methods:

- `send(roomId, SendArgs)` → `{ seq, msgId }`
- `sendText(roomId, { senderUid, text, ... })` → `{ seq, msgId }` (requires `e2ee`)
- `sendOptimistic(roomId, SendArgs)` → `OptimisticHandle`
- `sendTextOptimistic(roomId, { senderUid, text, ... })` → `OptimisticHandle` (requires `e2ee`)
- `flushOutbox(roomId)` → `Promise<void>`
- `batchAppend(roomId, BatchAppendItem[])` → `Promise<void>`
- `list(roomId, ListArgs?)` → `ListResult` with `items`, `hasNext`, and optional `next()`
- `subscribe(roomId, SubscribeArgs)` → teardown `() => void`
- `getThread(roomId, rootMsgId)` → `MessageRow[]`
- `searchByProductRef(productRef, { roomId?, limit? })` → `MessageRow[]`
- `sendTyping(roomId, ttlSecs?)` / `sendPresence(roomId)` / `getPresence(roomId)`
- `markRead(roomId, seq)`
- `sendFile(roomId, blob, SendFileArgs)` → `{ seq, msgId }`
- `createRoom(CreateRoomArgs?)` / `getRoom(roomId)` / `updateRoom(roomId, UpdateRoomArgs)` / `listRooms({ limit?, offset?, includeArchived? })` / `listMembers(roomId)`
- `addMember(roomId, userId, role?)` / `removeMember(roomId, userId)` / `batchAddMembers(roomId, userIds[], role?)`
- `updateMessage(roomId, msgId, { sealed })` / `deleteMessage(roomId, msgId)`
- `pinMessage(roomId, msgId)` / `unpinMessage(roomId, msgId)` / `listPins(roomId)`
- `addReaction(roomId, msgId, reaction)` / `removeReaction(roomId, msgId, reaction)` / `getReactions(roomId, msgId)`
- `encodeEnvelope(payload)` / `decodeEnvelope(bytes)`

Static: `MAX_RETRIES`, `BATCH_ADD_MEMBERS_CHUNK`.

### Other exports

- `SDKChatError` / `SDKChatBatchError` / `SDKChatErrorCode`
- `SDKPushClient` / `SDKPushError` / `SDKPushErrorCode` / `SubscribeResult` / `SubscriptionChangeListenerOpts`
- `createSFrameProvider` / `SFrameProviderOptions` / `ReplayError` (re-exported from `sframe-ratchet/chat`)
- `mintAnonReadToken` / `AnonReadMintError` / `AnonReadMintResult`
- `mintNamedWriteToken` / `NamedWriteMintError` / `MintNamedWriteOptions`
- `fetchRoster` / `rosterDisplayName` / `rosterAvatar` / `rosterRole`
- `setDictLoader` / `setDictBaseUrl` / `ensureWireCodecReady` (re-exported from `@oxpulse/wire-codec`)
- `generateUUID` / `backoffWithJitter` / `backoffMs`

Key types: `SendArgs`, `ListArgs`, `ListResult`, `MessageRow`, `SubscribeArgs`, `UpdateMessageArgs`, `PinnedMessage`, `BatchAppendItem`, `OptimisticHandle`, `CreateRoomArgs`, `UpdateRoomArgs`, `Room`, `RoomSummary`, `Member`, `RoomVisibility`, `CryptoProvider`, `E2EEOptions`, `CryptoMode`, `SealContext`, `SendFileArgs`, `PresignResult`, `RosterEntry`, `PrivilegedRole`, `FetchRosterOptions`, `AnonReadMintResult`, `NamedWriteMintErrorCode`, `PendingMessage`.

### E2EE

Use the built-in SFrame provider:

```ts
import { SDKChatClient, createSFrameProvider } from '@oxpulse/chat-sdk';

const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'jwt...',
  e2ee: {
    provider: 'sframe',
    // HKDF base-key with usages ['deriveKey', 'deriveBits']
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
    provider: myProvider, // implements { seal, unseal, dispose? }
  },
});
```

`sendText()` encrypts before sending. `list()` and `subscribe()` transparently decrypt each row. Rows that fail decryption are delivered with `MessageRow.unsealError: 'replay' | 'auth' | 'unknown'` instead of being dropped.

#### Downgrade defense

When `e2ee` is configured, `cryptoMode` defaults to `'sframe-static'`. The client refuses a server-emitted `crypto_mode: 'plaintext'` for that room and throws `SDKChatError('crypto_mode_mismatch')`, poisoning only that room. Recreate the client to retry a poisoned room. Passing `e2ee` with `cryptoMode: 'plaintext'` throws `invalid_args` at construction.

## Error model

All failures throw `SDKChatError` with a typed `code`:

| Code | When |
|---|---|
| `unauthorized` | 401 - invalid or expired JWT / ticket |
| `forbidden` | 403 - missing scope |
| `not_found` | 404 |
| `rate_limited` | 429 |
| `invalid_args` | 400–4xx (other than above); also thrown at construction for contradictory options |
| `server_error` | 5xx |
| `network` | fetch/network-level failure |
| `unsupported` | an e2ee-only operation called without `e2ee` configured |
| `crypto_mode_mismatch` | server-emitted `crypto_mode` does not match the configured/discovered expectation |
| `crypto_mode_poisoned` | room already poisoned by a prior mismatch; recreate the client |
| `crypto_mode_undiscovered` | `sendText` called before `crypto_mode` is known and no `e2ee` provider is configured |

## Compression (optional)

Enable zstd compression to reduce payload size:

```ts
const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: 'jwt...',
  compression: 'auto', // zstd dictless when payload >= 256 B
});
```

See `@oxpulse/wire-codec` for codec internals and dict management. The SDK re-exports `setDictLoader`, `setDictBaseUrl`, `ensureWireCodecReady`, `DictLoader`, and `DictName` from `@oxpulse/wire-codec`, so most apps do not need to install the codec separately.

## CSP compatibility

`@oxpulse/chat-sdk` is strict-CSP-safe. It contains zero `eval()` and zero `new Function()`. Verified by `src/__tests__/csp-cleanliness.test.ts` on every build.

Compatible with:

```
script-src 'self' 'wasm-unsafe-eval' 'nonce-...' 'strict-dynamic'
```

## Notifications (Web Push)

Use `SDKPushClient` to manage Web Push subscriptions:

```ts
import { SDKPushClient } from '@oxpulse/chat-sdk';

const push = new SDKPushClient({ baseUrl, jwt });

const vapidKey = await push.getVapidPublicKey();
const reg = await navigator.serviceWorker.ready;
const subscription = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidKey,
});

const { endpoint, deviceId } = await push.subscribe();

push.attachSubscriptionChangeListener({
  onResubscribed: (newEndpoint) => console.log('rotated', newEndpoint),
  onLost: () => console.log('permission revoked'),
});
```

Request permission first:

```ts
const perm = await SDKPushClient.requestPermission();
if (perm === 'granted') {
  const { endpoint, deviceId } = await push.subscribe();
}
```

All failures throw `SDKPushError` with a typed `code: SDKPushErrorCode`.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
