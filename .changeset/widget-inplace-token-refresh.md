---
"@oxpulse/chat-widget": minor
---

feat(chat-widget): in-place token refresh via origin-pinned postMessage (no remount)

`element.refreshToken(jwt)` no longer tears the widget down and rebuilds it to apply a
fresh JWT. In **iframe mode** it now posts the new token to the LIVE iframe over an
origin-pinned `postMessage` (`{ type: 'refresh-token', jwt }`) and the iframe swaps the
session token IN PLACE — the SSE stream, scroll position and decrypt state survive, so
there is no flicker, reconnect or lost scroll on a routine token rotation. When there is
no live iframe to post to (inline mode, or the iframe is not yet ready) it gracefully
falls back to the existing re-bootstrap path, so a refresh never silently no-ops. Inline
mode still re-bootstraps by design: its `SDKChatClient` holds its JWT in a `readonly`
field and can only be re-authed by reconstruction.

**Security hardening (behavior change):** `sendRefreshTokenToIframe` no longer falls back
to the `'*'` wildcard target origin. It now requires an EXPLICIT target origin (the
resolved widget `baseUrl`, the same concrete origin the init path posts to); if none is
available the bearer JWT is dropped with a `console.warn` rather than broadcast to any
origin — mirroring `sendToParent`'s "never send with '*'" (M1) discipline. The iframe-side
receiver applies a `refresh-token` only from inside the existing fail-closed
`onParentMessage` origin gate (M2), so a refresh-token from an unexpected origin is dropped.

Bumped `minor` (→ `0.4.0`) rather than `patch`: this changes the refresh behavior consumers
observe (no remount) and the `sendRefreshTokenToIframe` signature (an explicit origin is now
required, no `'*'` default), so it sits outside the `^0.3.1` caret range and requires an
explicit consumer opt-in.
