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

The scoped JWT carries permission claims of the form `<namespace>:<verb>:<resource>`. The ones
a browser token should carry are all per-room:

```
chat:read:<roomId>
chat:write:<roomId>
chat:subscribe:<roomId>
```

Room management is a separate, **app-wide** family that cannot be narrowed to one room:

```
rooms:read:*
rooms:write:*
```

Mint those only for a server-side client — see the warning above the room-management snippets
below. Your server controls which rooms and operations each user may access.

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
> Room operations first **gate on** `rooms:read:*` / `rooms:write:*` — a literal `*` in
> the resource position. `check_scope` compares each of the three scope components with
> `granted == "*" || granted == required`, so a `*` means "any" only on the granted side:
> a per-room grant such as `rooms:write:room-1` does **not** satisfy them. The scope is
> app-wide and cannot be narrowed to one room.
>
> That scope is admission control, not authorization. Each call below applies a second,
> per-room check — for most of them against the caller's own member row, though
> `listRooms` instead scopes its query and returns fewer rows rather than a 403:
>
> | Call | Second gate |
> |---|---|
> | `createRoom` | **none** — the creator becomes owner, *but only if it did not list itself in `initialMembers`*: the owner row is seeded only when the caller is absent from that array, so passing yourself with `role: 'member'` silently forfeits ownership and every later `updateRoom` 403s |
> | `updateRoom` | caller must be an active `owner` |
> | `addMember` / `removeMember` | owner or moderator in open rooms; any active, non-banned member otherwise |
> | `getRoom` | caller must be an *effective* member — in a room whose visibility is `open` that means anyone not banned, member row or not; in any other room it means an active, **non-banned** member row (the row can be active and still carry `role: 'banned'`) |
> | `listRooms` | results are scoped to the caller's own memberships |
>
> `deleteRoom()` is deliberately **absent** from this table: despite the name it is a
> *messages* route and needs `chat:admin:<roomId>`, not `rooms:write:*`. A token minted
> from the rules above will 403 on it. See the caveat under the snippets.
>
> Two consequences worth planning around:
>
> 1. **The unbounded power is room creation.** A `rooms:write:*` holder can create
>    rooms without bound *in number* — there is no room-count cap, though the write
>    routes are rate-limited and a billing quota can return 402. It cannot silently
>    rewrite an arbitrary existing room — reusing a
>    `roomId` that belongs to someone else is rejected 409, not taken over.
> 2. **A "service" token will 403 on almost everything.** The gates key on the JWT `sub`,
>    not on the token having been minted server-side. If `sub` holds no member rows you
>    get an empty `listRooms` and 403 from `updateRoom`, `addMember` and `removeMember`;
>    only `createRoom` works, and `getRoom` works only where the room is `open`. Mint for
>    a `sub` that owns the target room.
>
> Do not include `rooms:write:*` in a token you hand to a browser: the auth model at the
> top of this page assumes a narrowly-scoped browser token, and this scope is app-wide.
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

// List the rooms this token's `sub` is a member of — NOT every room the scope reaches
const { rooms } = await client.listRooms();

// Fetch full room info. Whether `members` is populated depends on visibility:
// in a `member` room (the default, and what the createRoom above produced) every
// active non-banned member gets the full roster; in an `open` room only an owner
// or moderator does, and everyone else gets `members: []` rather than a 403.
const full = await client.getRoom(room.roomId);

// Rename / reconfigure a room — active owner only
await client.updateRoom(room.roomId, { title: 'Support thread #42 (closed)' });

// Erase the room's message history — needs chat:admin:<roomId> FIRST, then
// owner/moderator or a concrete chat:moderate scope. Neither a rooms:write:*
// token nor an ordinary chat:write browser token passes the first gate.
// See the caveat below.
await client.deleteRoom(room.roomId);
```

> **`deleteRoom()` does not delete the room.** It clears the room's *message log*
> (`DELETE /api/sdk/messages/{roomId}`); the room, its title and its memberships all survive,
> and `getRoom()` keeps returning it. There is no endpoint that deletes a room — if you need
> one, track [#248](https://github.com/anatolykoptev/oxpulse-chat-sdk/issues/248).
>
> Its first gate is `chat:admin:<roomId>`. It used to be `chat:write:<roomId>` — the same
> scope an ordinary browser token carries — which made *sending a message* and *wiping the
> room* the same capability, reachable from an anonymously minted token
> ([oxpulse-chat#2858](https://github.com/anatolykoptev/oxpulse-chat/pull/2858)). If you
> mint `chat:admin` today against an older engine you will 403; if you rely on `chat:write`
> against a current one you will 403. Pin your expectation to the engine you deploy against.
>
> A second gate follows (since server v0.15.10), satisfied by **either** of:
>
> - an `owner` or `moderator` row for that room, or
> - a concrete `chat:moderate:<roomId>` scope in the token — no member row needed.
>
> The second path matters more than it looks: the mint copies whatever scopes your
> backend asks for, with no allowlist, so `chat:moderate:<roomId>` is something you can
> put in a browser token today. Treat it as the room-wipe capability it is.
>
> **The same is true of `chat:admin:<roomId>`, and of a wildcard you might not think of
> as one.** `check_scope` treats `*` as a match in every position, so a token carrying
> `chat:*:<roomId>` — the shape you reach for when you want read, write and subscribe in
> one string — also satisfies `chat:admin:<roomId>` and can wipe the room. Enumerate the
> verbs you actually need; never mint a wildcard verb into a browser token.
>
> The erase is a hard delete with no tombstone and no recovery. A plain `chat:write`
> holder now gets 403 where it previously succeeded — if you built a flow that let
> participants clear a room, it will start failing on upgrade.

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

**Who may delete a message.** `deleteMessage()` needs `chat:write:<roomId>`, but that
scope is only admission control: a plain participant may soft-delete **their own**
messages and gets 403 on anyone else's, 404 if the message does not exist — or has
already been soft-deleted, since the lookup carries `deleted_at IS NULL`.

The two statuses are kept distinct deliberately, and it is worth being precise about what
that buys, because the server's own comment overstates it. Collapsing both to 404 would
disclose *less*, not more: the delete matches on sender, so without the split a "not
yours" and a genuinely-missing message look identical. Splitting them **adds** an
existence oracle — a 403 confirms the message exists, including for ids the caller never
saw — in exchange for an error a client can act on. It buys clarity, not privacy:
ownership is already public, since `list()` returns `senderUid` for every message. Do not
build enumeration defences on the assumption that a denial hides presence.

Privilege comes from either an `owner`/`moderator` row **or** a `chat:moderate` scope —
and on this route the scope form is the permissive one, so `chat:moderate:*` makes the
caller a moderator in every room *the same token can already write to*. It does not
stand alone: `chat:write:<roomId>` is still checked first and a `moderate` verb cannot
satisfy it. The stricter concrete-room form is required only by the room-log erase. The
delete itself is soft: the message is tombstoned, not removed.

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
