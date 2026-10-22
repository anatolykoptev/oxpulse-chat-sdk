---
"@oxpulse/chat-sdk": minor
---

`subscribe()` now recovers from a half-open SSE link (NAT drop, captive Wi-Fi, mobile handover) instead of stalling silently.

EventSource only fires `onerror` when the socket closes, which a half-open link never does. The stream now has a liveness watchdog: if nothing (message, transient event or the server's `ping` keep-alive) arrives for `livenessTimeoutMs` (default 45 s, `0` disables), the stream is torn down and re-attached through the existing reconnect path, which replays from the last delivered seq. The reconnect also fires promptly on the browser `online` event, and on `visibilitychange` to visible when the stream has gone stale.

New `SubscribeArgs.onConnectionState` reports `connecting` / `connected` / `reconnecting` so an app can show a "connecting…" indicator.

The watchdog arms only after the first named `ping` event is seen on the current stream. The server's current keep-alive is an SSE comment (`: keepalive`), which EventSource never surfaces, so until the server emits `event: ping` WITH non-empty data (`data: 1`; an event with an empty data buffer is never dispatched by a browser) the watchdog stays dormant and behaviour is unchanged (the `online` reconnect and `onConnectionState` work regardless). Superseded reconnect cycles are now abandoned by an epoch check, so a replay fetch that hangs on a dead link cannot deliver or attach a second stream after the watchdog restarts the cycle.

Forced reconnects (`online`, watchdog, stale-on-visible) are jittered over 0-1 s and logged at debug level with their reason; a watchdog expiry never cuts an in-progress reconnect backoff short. Abandoned reconnect cycles abort their replay/ticket requests, a multi-page replay that is still making progress is not restarted, the initial connect is epoch-guarded (no duplicate EventSource when `online` fires during a hung first ticket fetch), and pings are tracked per stream. `onConnectionState('connecting')` is delivered on a microtask, never synchronously inside `subscribe()`.
