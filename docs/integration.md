# Integration guide

Start here. This page is the end-to-end path: which host to call, how to get credentials, what your backend does, and what your frontend does. It links out rather than repeating — [quickstart.md](./quickstart.md) is the client API, [embedding.md](./embedding.md) is the drop-in widget.

## Environments

| | Base URL | |
|---|---|---|
| Staging | `https://staging.oxpulse.chat` | integrate against this first |
| Production | `https://api.oxpulse.chat` | |

Both expose the same API and the same generated contract. The only difference an integrator sees is the base URL.

**Staging shares production's database.** It is a separate process, not a separate environment — there is no per-environment schema. Rows are scoped by `app_id` and that boundary is enforced, so your data stays yours; but a staging integration writes into the production database, and a schema migration applied from either side is visible to both. Use a dedicated `app_id` for integration testing and treat its data as live.

## The API contract

Generated from the server's request handlers, so it cannot drift from what the server actually accepts:

- **[https://docs.oxpulse.chat/docs](https://docs.oxpulse.chat/docs)** — browsable reference
- **[https://docs.oxpulse.chat/openapi.json](https://docs.oxpulse.chat/openapi.json)** — the OpenAPI 3.1 document, for code generation or import into Postman / Insomnia / Bruno

The same two paths are served on each environment host (`/api/sdk/docs`, `/api/sdk/openapi.json`) if you want the contract as that environment serves it.

## Entities

The five you will touch. Field-level detail is in the OpenAPI document; this is the vocabulary.

| | |
|---|---|
| **App** | your product surface, `app_id` like `sapp_…`. Every room, message and member belongs to exactly one app, and nothing crosses that boundary. |
| **Key** | a server-side credential, `key_id` + a raw secret. Your backend uses it to mint user tokens. **Never reaches a browser.** |
| **User JWT** | short-lived (default 1 h, max 24 h), minted per user by your backend, carries scopes. This is what your frontend holds. |
| **Room** | a conversation. Has a `crypto_mode` fixed at creation — `sframe-static` (end-to-end encrypted) or `plaintext` (server-readable, searchable, moderatable). |
| **Message** | belongs to a room. `msg_id` is a **UUID** — the field is declared `format: uuid` and any other id is a `422`. Carries a `seq` that is monotonic **per app, not per room** (see below). Supports edit, delete, reactions, threads, pins and attachments. |

## Setup

1. Sign in to **[https://panel.oxpulse.chat/admin](https://panel.oxpulse.chat/admin)** as account owner.
2. **SDK Apps → Create.** Pick a name and a crypto mode. The crypto mode is immutable after creation, so decide first: `plaintext` if you need server-side search or moderation, `sframe-static` if you need the server unable to read messages.
3. On the app page, **Issue key**. The raw secret is shown **once**. Store it in a vault or an environment variable — there is no way to retrieve it later, only to issue a new one and revoke the old.

## Your backend: mint a user token

```bash
KEY_ID="sak_…"
RAW_SECRET="sak_secret_…"          # saved at issue time
BASE="https://staging.oxpulse.chat"

BODY='{"user_id":"u_42","scopes":["chat:read:room-1","chat:write:room-1","chat:subscribe:room-1"],"ttl_secs":3600}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAW_SECRET" -hex | awk '{print $2}')

curl -fsS -X POST "$BASE/api/sdk/tokens" \
  -H "X-SDK-Key-Id: $KEY_ID" \
  -H "X-SDK-Secret: $RAW_SECRET" \
  -H "X-SDK-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
# -> { "token": "eyJ…", "expires_at": 1715520000 }
```

**Sign the exact bytes you send.** The HMAC covers the raw request body, so serialize once, sign that string, and send that same string. Signing a re-serialization — a different key order, different whitespace, a pretty-printer in your HTTP client — yields `401`, and that `401` is indistinguishable from a wrong secret. It is the single most common way an integration loses an afternoon.

Hand `token` to the frontend. Never the key or the secret.

### Scopes

`<namespace>:<verb>:<resource>`.

Per-room, and safe in a browser token:

```
chat:read:<roomId>
chat:write:<roomId>
chat:subscribe:<roomId>
```

App-wide, and **not** safe in a browser token:

```
rooms:read:*
rooms:write:*
```

The `*` is literal and the wildcard is asymmetric — a per-room grant does not satisfy it. So the only token that can create one room can also modify **every** room in your app. Room and member lifecycle belongs on your backend.

There is no server-side SDK package yet; drive those endpoints from your backend with the OpenAPI contract above. ([#244](https://github.com/anatolykoptev/oxpulse-chat-sdk/issues/244) tracks the package.)

### A scope is not a membership

This is the one that costs an afternoon. A token carrying `chat:read:<roomId>` for a room the
user has not been **added to** gets `403`, not `404` — the right to read the room and being in
it are separate checks. Room membership is a server-side call your backend makes:

```bash
curl -fsS -X POST "$BASE/api/sdk/rooms/$ROOM/members" \
  -H "Authorization: Bearer $BACKEND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_42"}'
```

### `seq` counts the app, not the room

`seq` is monotonic across the whole app. The first message in a brand-new room does not come
back as `1` — in a live walk it came back as `2152`, and the next as `2153`. It is still a
correct cursor for `after_seq` resumption; it is not a per-room message count, and treating it
as one will make a room look like it has thousands of messages it does not have.

### Subscribing needs a ticket

`EventSource` cannot set an `Authorization` header, so the stream is not opened with the JWT
directly — mint a short-lived ticket with it first:

```bash
curl -fsS -X POST "$BASE/api/sdk/messages/subscribe-ticket" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"room_id\":\"$ROOM\"}"
# -> {"ticket":"…"}   then:  GET /api/sdk/messages/subscribe?room_id=<room>&ticket=<ticket>
```

## Your frontend: two paths

**A drop-in widget, no build step** — a `<script>` tag and one element. See [embedding.md](./embedding.md).

```html
<script type="module" src="https://cdn.oxpulse.chat/widget/latest/index.js"></script>
<oxpulse-chat base-url="https://staging.oxpulse.chat" room-id="room-1" jwt="eyJ…"></oxpulse-chat>
```

**The SDK, for your own UI** — `npm install @oxpulse/chat-sdk`. See [quickstart.md](./quickstart.md).

```ts
import { SDKChatClient } from '@oxpulse/chat-sdk';

const client = new SDKChatClient({
  baseUrl: 'https://staging.oxpulse.chat',
  jwt: tokenFromYourBackend,
  appId: 'sapp_…',
});
```

## Token lifetime

`exp` is checked with **zero leeway** — there is no grace period, not even a second. Refresh before expiry rather than on failure; a token that expires mid-request fails that request. `iat` is the other direction and more forgiving: rejected only if more than 30 s in the future, so mild clock skew on your minting host is tolerated.

## Where things fail, and what it looks like

| Symptom | Usually |
|---|---|
| `401` on `/api/sdk/tokens` | the signature covers different bytes than the body sent — see above. Also: revoked key, or wrong environment for the key. |
| `401` on an SDK call with a valid-looking JWT | expired (`exp`, zero leeway), or the scope does not name this exact `roomId`. |
| `403` where you expected `404` | you have the scope but not the membership — add the user to the room server-side. Room-log delete and message edit/delete additionally need owner or moderator, not just `chat:write`. |
| `422` on append, no field named | `msg_id` is not a UUID. |
| `400` opening the SSE stream | you passed the JWT instead of a subscribe-ticket. |
| `crypto_mode_mismatch` thrown by the client | the room's mode is not the one pinned in `cryptoMode`. The mode is fixed at room creation and cannot be changed. |

## Support

Issues and questions: [github.com/anatolykoptev/oxpulse-chat-sdk/issues](https://github.com/anatolykoptev/oxpulse-chat-sdk/issues).
