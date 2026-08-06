# Embedding the Chat Widget

`@oxpulse/chat-widget` provides a ready-to-use group chat UI with no framework dependency. Two embed modes:

- **Custom Element** (`<oxpulse-chat>`) — renders inline inside a Shadow DOM. The simplest path.
- **iframe** — runs in a sandboxed `<iframe>` with a `postMessage` protocol. Strongest content-security isolation.

Both modes require a scoped JWT from your backend. See [quickstart.md](./quickstart.md) for the auth model.

---

## CDN delivery (primary embed channel)

The widget is distributed as a self-contained single-file ES module from `cdn.oxpulse.chat`.
This is the **primary embed channel** for zero-build pages. The npm package channel is also live (`npm install @oxpulse/chat-widget`) — use it when you already have a bundler.

### Versioned path (production — recommended)

Pin to an exact version. Use the versioned URL with Subresource Integrity so the browser
verifies the file has not changed since it was built:

```html
<script type="module"
  src="https://cdn.oxpulse.chat/widget/0.22.1/index.js"
  integrity="sha384-sP1U/QKMIBAGdoWA5BNKA/dpDdzwXLTUOGLyY5jKublrxNjpGU7QR6dMWsfRv9hZ"
  crossorigin="anonymous"></script>
```

`crossorigin="anonymous"` is **required** whenever `integrity` is present — the browser
performs a CORS fetch to read the bytes for hash verification, and the CDN already
responds with `Access-Control-Allow-Origin: *`.

A sibling `zstd.wasm` file is fetched lazily from the same versioned path on the first
compressed frame. No action required; it resolves automatically via the same CORS policy.

### `latest/` path (convenience only)

`https://cdn.oxpulse.chat/widget/latest/index.js` always resolves to the current release.
Do **not** use it in production alongside an `integrity` attribute: the hash would mismatch
after every release. `latest/` is suitable for quick prototypes and documentation examples
where reproducibility is not required.

### Required CSP headers

A page embedding the widget needs at minimum:

```
Content-Security-Policy:
  script-src https://cdn.oxpulse.chat;
  connect-src https://cdn.oxpulse.chat <your-api-origin>;
```

If you restrict `script-src` to a nonce-only list, add `https://cdn.oxpulse.chat` as an
additional allowed origin. The `zstd.wasm` fetch is covered by `connect-src` in modern
browsers (Chromium 112+, Firefox 115+). Safari requires `script-src` to also permit the
wasm origin; the CDN URL covers both.

### Architecture note

`cdn.oxpulse.chat` is served by Caddy `file_server` behind an nginx SNI front on the
OxPulse infrastructure. Immutable versioned paths (`/widget/0.22.1/`) receive
`Cache-Control: public, max-age=31536000, immutable`. The `latest/` symlink is served
without `immutable`.

---

## Custom Element mode

### 1. Include the script

```html
<!-- CDN (versioned, with SRI) — recommended -->
<script type="module"
  src="https://cdn.oxpulse.chat/widget/0.22.1/index.js"
  integrity="sha384-sP1U/QKMIBAGdoWA5BNKA/dpDdzwXLTUOGLyY5jKublrxNjpGU7QR6dMWsfRv9hZ"
  crossorigin="anonymous"></script>

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

`WidgetErrorCode` values: `'ORIGIN_NOT_ALLOWED'`, `'JWT_MALFORMED'`, `'JWT_EXPIRED'`, `'TOKEN_REFRESH_FAILED'`, `'NETWORK_ERROR'`, `'OUTBOX_UNAVAILABLE'`, `'UNKNOWN'`.

### `OUTBOX_UNAVAILABLE` — durability, not delivery

Fired at most once per page when IndexedDB is unavailable (Safari private browsing,
storage-pressure eviction, blocked site data). **Sending still works.** What is lost is
retry-after-reload: a message not yet delivered when the tab closes is gone.

Treat it as a degradation notice, not an error — it is worth logging, and worth telling a
user only if your product promises delivery across a reload. It exists so a support
conversation can tell “we lost your message” apart from “durability was never available
in this browser”.

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

---

## Named-write mode (`allow-write`) — T8

Named-write mode lets your page POST new messages through the widget using a short-lived
write token minted by your backend. The widget remains read-only by default; enabling
`allow-write` and providing `write-mint-endpoint` unlocks the inline compose UI.

**Scope:** inline mode only. The iframe allow-write path is deferred to a later release.

### Attributes

| Attribute | Required | Description |
|---|---|---|
| `allow-write` | Yes (boolean) | Present → enable named-write compose. Absent → read-only. |
| `write-mint-endpoint` | Yes with `allow-write` | URL your backend exposes to mint a write token. The widget POSTs `{ roomId }` to this URL and expects `{ token: string }` in return. |

### Minimal host-page setup

```html
<!-- 1. Load the widget (CDN or npm+bundler) -->
<script type="module"
  src="https://cdn.oxpulse.chat/widget/0.22.1/index.js"
  integrity="sha384-sP1U/QKMIBAGdoWA5BNKA/dpDdzwXLTUOGLyY5jKublrxNjpGU7QR6dMWsfRv9hZ"
  crossorigin="anonymous"></script>

<!-- 2. Add the element with allow-write -->
<oxpulse-chat
  app-id="YOUR_APP_ID"
  jwt="READ_JWT_FROM_YOUR_BACKEND"
  room-id="demo-room"
  allow-write
  write-mint-endpoint="/api/write-token">
</oxpulse-chat>
```

Your backend's `/api/write-token` endpoint must:

1. Authenticate the request (session cookie, header token, etc.).
2. Call `POST /api/sdk/named-write/mint` on the OxPulse server with the room ID.
3. Return `{ "token": "<named-write-token>" }`.

See [`packages/chat-sdk/src/named-write.ts`](../packages/chat-sdk/src/named-write.ts) for
the `mintNamedWriteToken` helper if you build the backend step in TypeScript.

### Programmatic mount

```js
import { mount } from '@oxpulse/chat-widget';

const widget = mount(document.getElementById('chat-container'), {
  appId: 'YOUR_APP_ID',
  jwt: readJwt,
  roomId: 'demo-room',
  allowWrite: true,
  writeMintEndpoint: '/api/write-token',
  onMessageSent: ({ roomId, msgId }) => {
    console.log('sent', msgId, 'in', roomId);
  },
  onWriteError: (err) => console.error(err.code, err.message),
});
```

### Events

The element dispatches two additional events in named-write mode:

| Event | Detail | When |
|---|---|---|
| `oxpulse-chat:message-sent` | `{ roomId: string; msgId: string }` | Named-write send succeeded. |
| `oxpulse-chat:write-error` | `WidgetError` (`.code`, `.message`) | Named-write send failed after the error chip was shown. |

```js
const el = document.querySelector('oxpulse-chat');

el.addEventListener('oxpulse-chat:message-sent', (ev) => {
  console.log('sent msg', ev.detail.msgId, 'in room', ev.detail.roomId);
});

el.addEventListener('oxpulse-chat:write-error', (ev) => {
  console.error('write failed:', ev.detail.code, ev.detail.message);
});
```

### Error codes

| Code | When |
|---|---|
| `WRITE_MINT_FAILED` | The `write-mint-endpoint` fetch failed or returned a non-`{ token }` body. |
| `WRITE_SEND_FAILED` | The named-write message send to the OxPulse server failed. |

These extend the existing `WidgetErrorCode` union — you can handle them in the same
`oxpulse-chat:error` listener or via the dedicated `oxpulse-chat:write-error` event above.

### Combining with anon-read

`allow-write` and `allow-anon-read` can be set together. The widget uses two separate
clients: the anon-read client subscribes to the room (no `jwt` required), while the write
client uses the minted write token for sends. This is the recommended setup for publicly
visible rooms with moderated posting.
