# @oxpulse/chat-widget

Embeddable OxPulse chat widget — `<oxpulse-chat>` Custom Element + iframe mode.

## Quickstart

### Script tag (zero config)

```html
<script type="module" src="https://cdn.oxpulse.chat/widget/0.1.0/index.js"></script>

<oxpulse-chat
  app-id="your-app-id"
  jwt="token-from-your-backend"
  room-id="chat-room-id">
</oxpulse-chat>
```

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
| `mode` | `inline` \| `iframe` | no | `inline` | Render mode |
| `theme` | `light` \| `dark` \| `auto` | no | `auto` | Colour scheme |
| `lang` | BCP 47 string | no | auto | Locale override |

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
```

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
