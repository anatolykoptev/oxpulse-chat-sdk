---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

client-side anon-read: `mintAnonReadToken` + widget `allow-anon-read` mode

**@oxpulse/chat-sdk**: adds `mintAnonReadToken(opts)` helper that POSTs to
`/api/sdk/auth/anon-read-mint` and returns a short-lived read-only JWT.
Throws `AnonReadMintError` (with `.code` and `.status`) on non-2xx responses.
Both are exported from the package index.

**@oxpulse/chat-widget**: adds `allow-anon-read` boolean attribute (presence =
true) and `base-url` attribute to `<oxpulse-chat>`. When `allow-anon-read` is
present and no `jwt` attribute is set, the widget automatically mints an anon
token, mounts in read-only mode (composer hidden), and schedules a re-mint 30 s
before the 300 s token expiry. When `jwt` is provided, the existing authed path
is unchanged. Includes injectable `_mintAnonReadToken` DI hook for tests.
