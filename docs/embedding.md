# Embedding the Chat Widget

`@oxpulse/chat-widget` provides a ready-to-use group chat UI with no framework dependency. Two embed modes:

- **Custom Element** (`<oxpulse-chat>`) — renders inline inside a Shadow DOM. The simplest path.
- **iframe** — runs in a sandboxed `<iframe>` with a `postMessage` protocol. Strongest content-security isolation.

Both modes require a scoped JWT from your backend. See [quickstart.md](./quickstart.md) for the auth model.

---

## Custom Element mode

### 1. Include the script

```html
<!-- From a CDN (replace with your preferred CDN URL or self-hosted path) -->
<script type="module" src="https://cdn.example.com/@oxpulse/chat-widget/dist/index.js"></script>

<!-- Or npm + bundler -->
<!-- import '@oxpulse/chat-widget'; -->
```

Importing the module auto-registers `<oxpulse-chat>` as a Custom Element. Safe to import multiple times.

### 2. Add the element

```html
<div id="chat-container" style="height: 500px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
  <oxpulse-chat
    app-id="YOUR_APP_ID"
    jwt="YOUR_JWT_FROM_BACKEND"
    room-id="demo-room"
    theme="auto">
  </oxpulse-chat>
</div>
```

### Observed attributes

All attribute names are kebab-case:

| Attribute | Required | Values | Description |
|---|---|---|---|
| `app-id` | Yes | string | OxPulse app identifier |
| `jwt` | Yes | string | Scoped JWT from your backend |
| `room-id` | Yes | string | Room to display |
| `mode` | No | `'inline'` \| `'iframe'` | Render mode. Default `'inline'`. |
| `theme` | No | `'light'` \| `'dark'` \| `'auto'` | Color scheme. Default `'auto'` (follows `prefers-color-scheme`). |
| `lang` | No | BCP 47 string | Locale override, e.g. `'en'`, `'ru'`. |
| `self-uid` | No | string | UID of the current user — used to highlight the user's own reaction chips. |

Changing `app-id`, `jwt`, `room-id`, or `self-uid` triggers a re-bootstrap. Multiple synchronous `setAttribute` calls are debounced into one bootstrap via `queueMicrotask`.

### Events

The element dispatches Custom Events that bubble and compose (cross Shadow DOM):

| Event | Detail | When |
|---|---|---|
| `oxpulse-chat:ready` | `{ roomId: string }` | Widget connected and origin check passed |
| `oxpulse-chat:error` | `WidgetError` (`.code`, `.message`) | Unrecoverable error (bad JWT shape, origin mismatch, etc.) |
| `oxpulse-chat:token-expired` | `{ roomId: string }` | Server returned 401 — JWT needs refresh |

```js
const el = document.querySelector('oxpulse-chat');

el.addEventListener('oxpulse-chat:ready', (ev) => {
  console.log('ready, room:', ev.detail.roomId);
});

el.addEventListener('oxpulse-chat:token-expired', async () => {
  const { jwt } = await fetch('/api/refresh-token').then(r => r.json());
  el.refreshToken(jwt);
});

el.addEventListener('oxpulse-chat:error', (ev) => {
  console.error(ev.detail.code, ev.detail.message);
});
```

### JS API methods

| Method | Signature | Description |
|---|---|---|
| `refreshToken(jwt)` | `(jwt: string) => void` | Provide a fresh JWT after `token-expired`. |
| `getLastSeq()` | `() => number` | Returns the last `seq` seen by the message list. |
| `destroy()` | `() => void` | Tear down the widget and cancel in-flight requests. |

### Programmatic mount (alternative to HTML)

```js
import { mount } from '@oxpulse/chat-widget';

const widget = mount(document.getElementById('chat-container'), {
  appId: 'YOUR_APP_ID',
  jwt: jwtFromBackend,
  roomId: 'demo-room',
  theme: 'auto',
  onTokenExpired: async () => {
    const { jwt } = await fetch('/api/refresh-token').then(r => r.json());
    return jwt;
  },
  onError: (err) => console.error(err.code, err.message),
});

// Remove widget later
widget.destroy();
```

See the runnable example at [`packages/chat-widget/examples/vanilla-element.html`](../packages/chat-widget/examples/vanilla-element.html).

---

## iframe mode

In iframe mode the widget renders inside a sandboxed `<iframe>` served from the OxPulse origin. The parent page communicates with the iframe via a typed `postMessage` protocol.

### Usage

```js
import { mount } from '@oxpulse/chat-widget';

const widget = mount(document.getElementById('chat-container'), {
  appId: 'YOUR_APP_ID',
  jwt: jwtFromBackend,
  roomId: 'demo-room',
  mode: 'iframe',                          // enable iframe mode
  baseUrl: 'https://oxpulse.chat',         // OxPulse server (iframe src base)
  theme: 'auto',
  onTokenExpired: async () => {
    const { jwt } = await fetch('/api/refresh-token').then(r => r.json());
    return jwt;
  },
  onError: (err) => console.error(err.code, err.message),
});
```

The `<iframe>` is always created with `sandbox="allow-scripts allow-same-origin"`.

See the runnable example at [`packages/chat-widget/examples/vanilla-iframe.html`](../packages/chat-widget/examples/vanilla-iframe.html).

### postMessage protocol

All messages are namespaced under `ns: 'oxpulse-chat'`. Origin pinning is enforced on both sides — the iframe only accepts messages from the origin that loaded it, and only sends to the exact parent origin.

#### Parent → iframe messages

| `type` | Payload | When to send |
|---|---|---|
| `'init'` | `{ config: WidgetConfig }` | Sent automatically on iframe load — you do not send this manually. |
| `'refresh-token'` | `{ jwt: string }` | Send after receiving `token-expired` from the iframe. |
| `'set-theme'` | `{ theme: 'light' \| 'dark' \| 'auto' }` | Change the color scheme at runtime. |

#### iframe → parent messages

| `type` | Payload | Meaning |
|---|---|---|
| `'ready'` | `{ roomId: string }` | Widget initialized and origin check passed. |
| `'error'` | `{ code: WidgetErrorCode, message: string }` | Unrecoverable error. |
| `'token-expired'` | `{ roomId: string }` | JWT expired — send `refresh-token`. |
| `'resize'` | `{ height: number }` | Iframe content height changed — resize the container if needed. |
| `'user-action'` | `{ event: 'send' \| 'reaction' \| 'typing' }` | User performed an action inside the widget. |

Listen:

```js
window.addEventListener('message', (ev) => {
  if (ev.data?.ns !== 'oxpulse-chat') return;
  const msg = ev.data;

  if (msg.type === 'token-expired') {
    // refresh and send back
    fetch('/api/refresh-token')
      .then(r => r.json())
      .then(({ jwt }) => {
        // send via the iframe element reference
        iframeEl.contentWindow.postMessage(
          { ns: 'oxpulse-chat', type: 'refresh-token', jwt },
          'https://oxpulse.chat',
        );
      });
  }
});
```

`WidgetErrorCode` values: `'ORIGIN_NOT_ALLOWED'`, `'JWT_MALFORMED'`, `'JWT_EXPIRED'`, `'TOKEN_REFRESH_FAILED'`, `'NETWORK_ERROR'`, `'UNKNOWN'`.

---

## Theming via CSS custom properties

The widget uses a Shadow DOM. Override CSS custom properties on the `<oxpulse-chat>` host element to reskin it:

```css
oxpulse-chat {
  /* Brand color */
  --oxp-accent: #7c3aed;

  /* Backgrounds */
  --oxp-bg: #ffffff;
  --oxp-bubble-self-bg: #ede9fe;
  --oxp-bubble-other-bg: #f3f4f6;

  /* Text */
  --oxp-fg: #111827;
  --oxp-muted: #767676;

  /* Borders and shape */
  --oxp-border: #e5e7eb;
  --oxp-radius: 12px;

  /* Typography */
  --oxp-font: 'Inter', system-ui, sans-serif;
  --oxp-spacing-unit: 8px;
}
```

Full list of available properties (sourced from `packages/chat-widget/src/ui/theme.ts`):

| Property | Default (light) | Default (dark) | Purpose |
|---|---|---|---|
| `--oxp-bg` | `#ffffff` | `#1c1c1e` | Widget background |
| `--oxp-fg` | `#1a1a1a` | `#ebebf5` | Primary text |
| `--oxp-accent` | `#0088cc` | `#0a84ff` | Interactive elements, links |
| `--oxp-on-accent` | `#000000` | `#000000` | Text on accent-colored surfaces |
| `--oxp-muted` | `#767676` | `#8e8e93` | Secondary/metadata text |
| `--oxp-fg-secondary` | `#5a5a5a` | `#cccccc` | Sender names, timestamps |
| `--oxp-border` | `#e0e0e0` | `#38383a` | Dividers, input borders |
| `--oxp-bubble-self-bg` | `#dcf8c6` | `#1e4e31` | Message bubble — current user |
| `--oxp-bubble-other-bg` | `#f1f0f0` | `#2c2c2e` | Message bubble — other users |
| `--oxp-danger` | `#c00000` | `#ff6b6b` | Error text and borders |
| `--oxp-radius` | `12px` | `12px` | Border radius |
| `--oxp-font` | `system-ui, -apple-system, sans-serif` | same | Font stack |
| `--oxp-spacing-unit` | `8px` | `8px` | Base spacing multiplier |
| `--oxp-link` | `#0066a3` | `#7cc4ff` | In-message link color |
| `--oxp-code-bg` | `#f5f5f5` | `#1a1a1c` | Inline code background |

All color tokens pass WCAG 2.1 AA contrast requirements in both built-in themes.

Theme switching at runtime: set the `theme` attribute to `'light'`, `'dark'`, or `'auto'`. The widget applies `data-theme` to the host element immediately without re-bootstrapping.
