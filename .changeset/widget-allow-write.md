---
"@oxpulse/chat-widget": minor
---

add allow-write (named-write) mode to chat widget (inline mode only)

Adds `allowWrite` / `allow-write` config to `<oxpulse-chat>` and `mount()`. When
enabled, the widget mints a named-write JWT from the host page's own backend
(`writeMintEndpoint`) and renders a compose UI (input + send button) for
`mode:'inline'` (shadow DOM). Without `allowWrite` the widget stays read-only
(no behaviour change from previous releases).

Note: `mode:'iframe'` named-write support is not yet implemented (W5). Setting
`allowWrite:true` with `mode:'iframe'` logs a console warning and the compose UI
is not shown.

New `WidgetConfig` fields:
- `allowWrite?: boolean` — enable named-write compose UI (default: false)
- `writeMintEndpoint?: string` — URL of the host's named-write mint endpoint
- `_mintNamedWriteToken?` — test-only injectable mint override

New HTML attributes on `<oxpulse-chat>`:
- `allow-write` (boolean)
- `write-mint-endpoint` (string)

New events on `<oxpulse-chat>`:
- `oxpulse-chat:message-sent` — fires after a successful send `{ roomId, msgId }`
- `oxpulse-chat:write-error` — fires on non-recoverable write failures

New `WidgetErrorCode` values:
- `WRITE_MINT_FAILED` — emitted when the write-token mint request fails
- `WRITE_SEND_FAILED` — emitted via `oxpulse-chat:write-error` when a named-write send fails

The write token is kept separate from the read JWT (different capability level).
`allow-write` can be combined with `allow-anon-read` — the widget creates two SDK
clients: one for reading (anon or authed JWT), one for writing (named-write JWT).

Minimal host integration:
```html
<oxpulse-chat
  app-id="YOUR_APP_ID"
  room-id="event-room-slug"
  allow-anon-read
  allow-write
  write-mint-endpoint="/api/oxpulse-write-token">
</oxpulse-chat>
```

Backend mint endpoint shape:
```
POST /api/oxpulse-write-token
Body:    { room_id: string }
Returns: { token: string }   // named-write SDK JWT from OxPulse group-grant-mint
```
