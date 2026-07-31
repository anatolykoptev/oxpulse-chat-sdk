# Quickstart — @oxpulse/chat-sdk

Build a chat experience in a web app using the SDK directly. For a zero-JS-framework drop-in, see [embedding.md](./embedding.md).

## Install

```bash
npm install @oxpulse/chat-sdk
```

Requires a runtime environment with `fetch`, `EventSource`, and `crypto.subtle` (modern browsers, Node.js >= 18, Deno, Bun).

## Auth model

**Your backend mints the JWT; the browser only holds a scoped token.**

```
Browser ──── POST /api/your-auth ───► Your server
                                           │
                                           │  POST /api/sdk/tokens  (server-to-server)
                                           ▼
                                      OxPulse server
                                           │
                                           │  { jwt: "eyJ..." }
                                           ▼
Your server ◄──── { jwt } ───────────────────
     │
     │  return jwt to browser
     ▼
Browser (holds scoped JWT only — never the minting secret)
```

The scoped JWT carries permission claims of the form:

```
chat:read:<roomId>
chat:write:<roomId>
chat:subscribe:<roomId>
```

Your server controls which rooms and operations each user may access.

## Minimal example

```ts
import { SDKChatClient } from '@oxpulse/chat-sdk';

// 1. Construct the client with a JWT your backend minted
const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',    // OxPulse server base URL (no trailing slash)
  jwt: jwtFromYourBackend,                // Bearer JWT — do NOT include "Bearer " prefix
});

// 2. List messages (paginated, newest-first cursor available)
const result = await client.list('room-abc', { afterSeq: 0, limit: 50 });
for (const msg of result.items) {
  console.log(msg.seq, msg.senderUid, msg.createdAt);
}
// Fetch the next page if available:
if (result.hasNext && result.next) {
  const page2 = await result.next();
}

// 3. Subscribe to live updates via SSE
const unsubscribe = client.subscribe('room-abc', {
  onMessage: (msg) => {
    console.log('new message', msg.seq, msg.senderUid);
  },
  onMutation: (ev) => {
    // edit / delete / pin / unpin on an existing message
    console.log(ev.op, ev.msgId);
  },
  onError: (err) => {
    console.error('subscribe error', err);
  },
});

// 4. Send a message
//    sendText requires e2ee config (see E2EE section below).
//    To send raw pre-sealed bytes use client.send() directly.
await client.send('room-abc', {
  senderUid: 'user-123',
  sealed: new TextEncoder().encode('hello').buffer,
});

// Stop the SSE connection when done
unsubscribe();
```

### `SDKChatClientOptions` — full reference

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | Yes | OxPulse server base URL, no trailing slash |
| `jwt` | `string` | Yes | Scoped JWT from your backend. No `"Bearer "` prefix. |
| `appId` | `string` | No | App namespace ID — matches JWT `aud` claim. Recommended for multi-tenant setups. |
| `cryptoMode` | `'sframe-static' \| 'plaintext'` | No | Pin the expected server crypto mode. When set, the client rejects mismatches to prevent downgrade attacks. |
| `e2ee` | `E2EEOptions` | No | End-to-end encryption config. See E2EE section. |
| `compression` | `'none' \| 'auto' \| 'dict'` | No | Wire compression for outgoing messages. Default `'none'`. |

## Crypto modes

The server negotiates a `crypto_mode` per room, emitted in every `list()` response and every SSE `connected` prelude:

- **`sframe-static`** — messages are sealed with sframe-ratchet v0.5 (AEAD, per-sender counter, replay protection). The server stores and forwards opaque ciphertext. Only holders of the room key can read messages. Search and server-side moderation are not available.

- **`plaintext`** — the client skips seal/unseal and sends UTF-8 bytes. The server can read, search, and moderate messages. Suitable for non-sensitive community or support chats.

The `cryptoMode` constructor option pins the client's expectation. If the server emits a different mode the client throws `SDKChatError('crypto_mode_mismatch')` and stops — this prevents a compromised signaling path from silently downgrading an encrypted room.

## E2EE

When `crypto_mode` is `sframe-static`, configure `e2ee` so `sendText()` and `list()`/`subscribe()` auto-seal and auto-unseal:

```ts
import { SDKChatClient, createSFrameProvider } from '@oxpulse/chat-sdk';

// Obtain a shared HKDF base-key (e.g. via your key-exchange protocol)
const sharedSecret = new Uint8Array(32); // replace with real bytes
const hkdfKey = await crypto.subtle.importKey(
  'raw', sharedSecret, 'HKDF', false, ['deriveKey', 'deriveBits'],
);

const client = new SDKChatClient({
  baseUrl: 'https://chat.example.com',
  jwt: jwtFromYourBackend,
  cryptoMode: 'sframe-static',
  e2ee: {
    provider: 'sframe',           // built-in sframe-ratchet v0.5 chat provider
    getKey: async (_roomId) => hkdfKey,
  },
});

// sendText() encrypts automatically
await client.sendText('room-abc', {
  senderUid: 'user-123',
  text: 'Hello, encrypted world!',
});

// list() and subscribe() decrypt automatically; plaintext bytes live in msg.plaintext
const result = await client.list('room-abc', {});
for (const msg of result.items) {
  if (msg.plaintext) {
    console.log(new TextDecoder().decode(msg.plaintext));
  } else if (msg.unsealError) {
    console.warn('failed to decrypt:', msg.unsealError); // 'replay' | 'auth' | 'unknown'
  }
}
```

`getKey` receives the `roomId` and must return a `CryptoKey` with usages `['deriveKey', 'deriveBits']` (HKDF). sframe-ratchet derives its own AES-128-GCM key internally — do not pass a raw AES key.

## Room management

> **These calls need an app-wide scope and belong on your backend, not in the browser.**
>
> Room operations authorize against `rooms:read:*` / `rooms:write:*` — a literal `*` in
> the resource position. The scope matcher is asymmetric (`granted == "*" || granted ==
> required`), so a per-room grant such as `rooms:write:room-1` does **not** satisfy them.
> The practical consequence: the only token that can create a room can create and mutate
> **every** room in the app.
>
> Mint that token server-side and make these calls from your backend. Do not include
> `rooms:write:*` in a token you hand to a browser — the auth model at the top of this
> page assumes the browser holds a narrowly-scoped token, and this scope is the opposite
> of that.
>
> The snippets below use `client.*` for brevity; run them against a server-side client.

```ts
// Create a room
const room = await client.createRoom({
  roomId: 'optional-stable-id',   // omit to let server generate one
  title: 'Support thread #42',
  initialMembers: [{ userId: 'user-456', role: 'member' }],
});

// Add / remove members
await client.addMember(room.roomId, 'user-789', 'member');
await client.removeMember(room.roomId, 'user-456');

// List rooms the JWT has access to
const { items } = await client.listRooms();

// Fetch full room info (includes members)
const full = await client.getRoom(room.roomId);
```

## Reactions

```ts
await client.sendReaction('room-abc', msgId, '👍');
await client.removeReaction('room-abc', msgId, '👍');
const { counts, users } = await client.getReactions('room-abc', msgId);
```

Reaction changes also arrive on the SSE stream via `onReaction` in `SubscribeArgs`.

## Edit, delete, pin

```ts
await client.updateMessage('room-abc', msgId, { sealed: newSealedBytes });
await client.deleteMessage('room-abc', msgId);
await client.pinMessage('room-abc', msgId);
await client.unpinMessage('room-abc', msgId);
const pins = await client.listPins('room-abc');
```

Edit and delete events arrive on the SSE stream via `onMutation` in `SubscribeArgs`.

## Optimistic send (outbox)

`sendTextOptimistic()` queues the message locally and retries on network failure. Returns an `OptimisticHandle`:

```ts
const handle = client.sendTextOptimistic('room-abc', {
  senderUid: 'user-123',
  text: 'Hello!',
});

handle
  .onPending(() => { /* show optimistic bubble */ })
  .onSucceeded(({ seq, msgId }) => { /* confirm sent */ })
  .onFailed((err) => { /* show retry UI */ });

// Or await the promise:
const { seq, msgId } = await handle.done;
```

## Next steps

- Drop-in UI widget (no React/Vue/Svelte required): see [embedding.md](./embedding.md).
- Wire codec docs: `packages/wire-codec/README.md`.
