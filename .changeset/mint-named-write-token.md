---
"@oxpulse/chat-sdk": minor
---

client-side named-write mint helper

Adds `mintNamedWriteToken(opts)` — sibling to `mintAnonReadToken`. POSTs to the
client's own mint endpoint with `room_id` in the body, returns the raw JWT string.

Throws `NamedWriteMintError` (with `.code` and `.status`) on non-2xx responses.
Error codes: `unauthorized` (401), `forbidden` (403), `rate_limited` (429),
`mint_failed` (other errors or malformed body).

Both `mintNamedWriteToken` and `NamedWriteMintError` are exported from the package index.
