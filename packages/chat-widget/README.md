# @oxpulse/chat-widget

Embeddable OxPulse chat widget — `<oxpulse-chat>` Custom Element + iframe mode.

## Quickstart

### Script tag (CDN — primary embed channel)

Load from the versioned CDN path with [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
for production. The `crossorigin` attribute is **required** when `integrity` is present.

```html
<script type="module"
  src="https://cdn.oxpulse.chat/widget/0.4.0/index.js"
  integrity="sha384-PnbVBbsLURwmH6l5DUgolRHP4H+u4slfzLMjNwCb+vf4VcuW9LQRDK85Sjv6fFwz"
  crossorigin="anonymous"></script>

<oxpulse-chat
  app-id="your-app-id"
  jwt="token-from-your-backend"
  room-id="chat-room-id">
</oxpulse-chat>
```

**Versioning.** Pin to a specific version path (`/widget/0.4.0/`) in production.
`/widget/latest/` resolves to the current release and is provided for convenience only —
do not use it where SRI or reproducible deployments matter.

**CSP.** A consumer page loading the widget needs at minimum:

```
Content-Security-Policy:
  script-src https://cdn.oxpulse.chat;
  connect-src https://cdn.oxpulse.chat <your-api-origin>;
```

`zstd.wasm` is fetched lazily from the same versioned CDN path on first compressed frame.
If your policy restricts `wasm-unsafe-eval` or `script-src` to a `'nonce-…'`-only list,
add `https://cdn.oxpulse.chat` explicitly or use the npm+bundler path instead.

### npm (bundler / framework projects)

```
npm install @oxpulse/chat-widget
```

The CDN `<script>` tag above remains the primary embed channel for zero-build pages;
use npm when your project already goes through a bundler (React/Vue/Svelte examples below)
or when CSP forbids adding `https://cdn.oxpulse.chat` to `script-src`.

### React

```tsx
import '@oxpulse/chat-widget';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'oxpulse-chat': React.HTMLAttributes<HTMLElement> & {
        'app-id': string; jwt: string; 'room-id': string;
        mode?: string; theme?: string; lang?: string;
      };
    }
  }
}

export function ChatPanel({ appId, jwt, roomId }: Props) {
  return <oxpulse-chat app-id={appId} jwt={jwt} room-id={roomId} />;
}
```

### Vue

```vue
<script setup>
import '@oxpulse/chat-widget';
const { appId, jwt, roomId } = defineProps(['appId', 'jwt', 'roomId']);
</script>

<template>
  <oxpulse-chat :app-id="appId" :jwt="jwt" :room-id="roomId" />
</template>
```

### Svelte

```svelte
<script>
  import '@oxpulse/chat-widget';
  export let appId, jwt, roomId;
</script>

<oxpulse-chat app-id={appId} {jwt} room-id={roomId} />
```

### Programmatic (no HTML)

```ts
import { mount } from '@oxpulse/chat-widget';

const widget = mount(document.getElementById('chat-container'), {
  appId: 'your-app-id',
  jwt: await fetchJwtFromYourBackend(),
  roomId: 'support-room',
  theme: 'dark',
});

// Later:
widget.destroy();
```

## Attributes / Config

| Attribute | Type | Required | Default | Description |
|---|---|---|---|---|
| `app-id` | string | yes | — | OxPulse app ID (from admin panel) |
| `jwt` | string | yes | — | Signed JWT from your backend |
| `room-id` | string | yes | — | Room to open |
| `mode` | `inline` \| `iframe` | no | `inline` | Render mode (`iframe` is **experimental** — see below) |
| `theme` | `light` \| `dark` \| `auto` | no | `auto` | Colour scheme |
| `lang` | BCP 47 string | no | auto | Locale override |

> **`mode='iframe'` is EXPERIMENTAL — not production-ready.**
> The iframe render mode is a half-built feature: it creates a sandboxed
> `<iframe>` but does not yet construct a real chat client inside it, and
> in-place JWT refresh writes `liveConfig.jwt` with no consumer (W2.2 TODO).
> Use `mode='inline'` (the default) for production deployments. Selecting
> `mode='iframe'` emits a one-time `console.warn` to surface this gap.

## Events

```ts
element.addEventListener('oxpulse-chat:ready', (ev) => {
  console.log('Widget ready, room:', ev.detail.roomId);
});

element.addEventListener('oxpulse-chat:error', (ev) => {
  console.error('Widget error:', ev.detail.code, ev.detail.message);
});

element.addEventListener('oxpulse-chat:token-expired', async (ev) => {
  const newJwt = await fetchFreshToken(ev.detail.roomId);
  element.refreshToken(newJwt);
});

element.addEventListener('oxpulse-chat:attachment-error', (ev) => {
  // Fired when an authenticated attachment fetch reaches final failure (after
  // retries exhaust, or immediately for a permanent 403/404/410). Fires once
  // per attachment per final failure — not per retry.
  console.warn('Attachment unavailable:', ev.detail.msgId, ev.detail.attachmentId, ev.detail.reason);
});

element.addEventListener('oxpulse-chat:write-error', (ev) => {
  // Fired when a named-write send or reaction op fails (non-recoverable, after
  // the inline error chip is shown). ev.detail is a WidgetError with .op
  // ('send' | 'reaction_add' | 'reaction_remove') and .reason
  // ('auth_expired' | 'network' | 'other').
  console.warn('Write failed:', ev.detail.op, ev.detail.reason, ev.detail.message);
});

element.addEventListener('oxpulse-chat:message-sent', (ev) => {
  // Fired after a named-write message is successfully sent to the server.
  console.log('Message sent:', ev.detail.roomId, ev.detail.msgId);
});

element.addEventListener('oxpulse-chat:decrypt-error', (ev) => {
  // Fired when a row that failed end-to-end decryption is rendered. chat-sdk's
  // classifyUnsealError distinguishes reason 'replay' | 'auth' | 'unknown' —
  // a replay-attack signature and a benign timeout are otherwise
  // indistinguishable to the host. Deduped once per msgId per widget lifetime.
  // The 'replay' reason is the one that matters most on an untrusted server.
  console.warn('Decrypt failed:', ev.detail.roomId, ev.detail.msgId, ev.detail.seq, ev.detail.reason);
});

element.addEventListener('oxpulse-chat:reconnect-exhausted', (ev) => {
  // Fired when the Reconnector gives up after MAX_ATTEMPTS (10) retries — a
  // permanently-dead room is otherwise invisible to host monitoring. Contrast
  // oxpulse-chat:token-expired which fires on auth expiry. This event is only
  // reached for non-auth (network) failures; auth errors branch to
  // token-expired before exhaustion.
  console.error('Reconnect exhausted:', ev.detail.roomId, 'attempts:', ev.detail.attempts);
});
```

### Events reference

| Event | detail | When |
|---|---|---|
| `oxpulse-chat:ready` | `{ roomId }` | Widget connected and passed origin check |
| `oxpulse-chat:error` | `WidgetError` | Unrecoverable error (origin mismatch, bad JWT, etc) |
| `oxpulse-chat:token-expired` | `{ roomId }` | Server returned 401; call `element.refreshToken()` |
| `oxpulse-chat:write-error` | `WidgetError` (`.op`, `.reason`) | A named-write send or reaction op failed |
| `oxpulse-chat:message-sent` | `{ roomId, msgId }` | A named-write message was successfully sent |
| `oxpulse-chat:attachment-error` | `{ msgId, attachmentId, reason }` | Attachment hydration reached final failure |
| `oxpulse-chat:decrypt-error` | `{ roomId, msgId, seq, reason }` | An undecryptable row was rendered (deduped per msgId) |
| `oxpulse-chat:reconnect-exhausted` | `{ roomId, attempts }` | Reconnector gave up after 10 retries (network death) |

## Origin allowlist

Your JWT must include an `aud_origins` claim listing allowed embed origins.
Configure this when minting tokens via `POST /api/sdk/tokens`.

```json
{
  "aud_origins": ["https://yoursite.com", "https://*.yoursite.com"],
  "sub": "user-123",
  "exp": 1748000000
}
```

Localhost is always allowed in dev mode (inline, hostname === localhost).

## Security

- Origin check runs client-side before any network call (prevents misconfiguration).
- Server enforces the same allowlist on all API requests (JWT verification).
- iframe mode uses `sandbox="allow-scripts allow-same-origin"`.

## v3.0 — Voice/Video

The `<oxpulse-chat with-voice>` attribute interface is reserved for v3.0.
