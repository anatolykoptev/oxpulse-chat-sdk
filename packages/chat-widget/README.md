# @oxpulse/chat-widget

[![npm](https://img.shields.io/npm/v/@oxpulse/chat-widget)](https://www.npmjs.com/package/@oxpulse/chat-widget)
[![license](https://img.shields.io/npm/l/@oxpulse/chat-widget)](./LICENSE)

Embeddable OxPulse chat widget - `<oxpulse-chat>` Custom Element with an iframe embed entry point.

Use it to add a chat panel to any page without a framework, or import it into React/Vue/Svelte. The package bundles `@oxpulse/chat-sdk` and `@oxpulse/voice-core` as runtime dependencies, so you do not need to install them separately.

## Install

```sh
npm install @oxpulse/chat-widget@0
# or
pnpm add @oxpulse/chat-widget@0
# or
yarn add @oxpulse/chat-widget@0
```

## Quickstart

### Script tag (CDN)

Load from a versioned CDN path. The `crossorigin` attribute is required when `integrity` is present.

```html
<script type="module"
  src="https://cdn.oxpulse.chat/widget/0.21/index.js"
  crossorigin="anonymous"></script>

<oxpulse-chat
  app-id="your-app-id"
  jwt="token-from-your-backend"
  room-id="chat-room-id">
</oxpulse-chat>
```

Pin to a specific version path in production and add a Subresource Integrity hash. `/widget/latest/` is a convenience alias only.

### npm / bundler

```tsx
import '@oxpulse/chat-widget';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'oxpulse-chat': React.HTMLAttributes<HTMLElement> & {
        'app-id': string;
        jwt: string;
        'room-id': string;
        mode?: 'inline' | 'iframe';
        theme?: 'light' | 'dark' | 'auto';
        lang?: string;
      };
    }
  }
}

export function ChatPanel({ appId, jwt, roomId }) {
  return <oxpulse-chat app-id={appId} jwt={jwt} room-id={roomId} />;
}
```

### Programmatic

```ts
import { mount } from '@oxpulse/chat-widget';

const widget = mount(document.getElementById('chat-container'), {
  appId: 'your-app-id',
  jwt: await fetchJwtFromYourBackend(),
  roomId: 'support-room',
  theme: 'dark',
});

// later
widget.destroy();
```

## Attributes / config

| Attribute | Type | Required | Default | Description |
|---|---|---|---|---|
| `app-id` | string | yes | - | OxPulse app ID |
| `jwt` | string | yes | - | Signed SDK JWT from your backend |
| `room-id` | string | yes | - | Room to open |
| `mode` | `inline` \| `iframe` | no | `inline` | Render mode (`iframe` is experimental) |
| `theme` | `light` \| `dark` \| `auto` | no | `auto` | Colour scheme |
| `lang` | BCP 47 string | no | auto | Locale override |
| `self-uid` | string | no | - | UID of the current user (for own-reaction chips) |
| `base-url` | string | no | `https://oxpulse.chat` | Server base URL |
| `allow-anon-read` | boolean | no | false | Mint a short-lived anon-read token when `jwt` is absent |
| `allow-write` | boolean | no | false | Enable named-write compose UI |
| `write-mint-endpoint` | string | when `allow-write` | - | Your backend endpoint that mints a named-write token |
| `reactions-enabled` | boolean | no | true | Show reaction UI |

`mode='iframe'` is experimental and does not yet support `allow-write`.

## Events

Attach to the `<oxpulse-chat>` element:

```ts
const el = document.querySelector('oxpulse-chat');

el.addEventListener('oxpulse-chat:ready', (ev) => {
  console.log('ready', ev.detail.roomId);
});

el.addEventListener('oxpulse-chat:token-expired', async () => {
  el.refreshToken(await fetchFreshToken());
});

el.addEventListener('oxpulse-chat:error', (ev) => {
  console.error(ev.detail.code, ev.detail.message);
});
```

| Event | detail | When |
|---|---|---|
| `oxpulse-chat:ready` | `{ roomId }` | Widget connected and passed origin check |
| `oxpulse-chat:error` | `WidgetError` | Unrecoverable error |
| `oxpulse-chat:token-expired` | `{ roomId }` | Server returned 401; call `element.refreshToken()` |
| `oxpulse-chat:message-sent` | `{ roomId, msgId }` | A named-write message was sent |
| `oxpulse-chat:write-error` | `WidgetError` | A named-write send/reaction failed |
| `oxpulse-chat:attachment-error` | `{ msgId, attachmentId, reason }` | Attachment hydration reached final failure |
| `oxpulse-chat:decrypt-error` | `{ roomId, msgId, seq, reason }` | A row with an `unsealError` was rendered |
| `oxpulse-chat:reconnect-exhausted` | `{ roomId, attempts }` | Reconnector gave up after 10 retries |

## Origin allowlist

Your JWT must include an `aud_origins` claim listing allowed embed origins. Configure this when minting tokens via `POST /api/sdk/tokens`.

```json
{
  "aud_origins": ["https://yoursite.com", "https://*.yoursite.com"],
  "sub": "user-123",
  "exp": 1748000000
}
```

Localhost is always allowed in dev mode (inline, `hostname === localhost`).

## API surface

- `OxpulseChatElement` - the `<oxpulse-chat>` custom element class
- `defineElement()` - register the custom element (called automatically on script-tag load)
- `mount(target, MountOptions)` - programmatic mount; returns `{ destroy: () => void }`
- `WidgetConfig` / `MountOptions` / `WidgetEventMap` / `ProductMeta`
- `WidgetError` / `OriginNotAllowedError` / `WidgetErrorCode`
- `checkOrigin(config)` / `decodeJwtPayload(jwt)` / `matchOriginPattern(origin, pattern)` / `OriginCheckResult`
- `isParentMessage(data)` / `isIframeMessage(data)`
- `sendToParent(msg)` / `onParentMessage(handler)` / `onIframeMessage(iframe, handler)`
- `ParentMessage` / `IframeMessage`

The iframe entry point is available at `@oxpulse/chat-widget/iframe`.

## Security

- Origin check runs client-side before any network call (prevents misconfiguration).
- Server enforces the same allowlist on all API requests.
- iframe mode uses `sandbox="allow-scripts allow-same-origin"`.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
