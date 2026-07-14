---
"@oxpulse/chat-widget": patch
---

write 401 fires token-expired + delays optimistic rollback for host refresh; write-failure telemetry event

- A write op (`sendReaction`/`removeReaction`/composer `sendText`) failing
  with an auth error (401/403, `unauthorized`/`forbidden` code) now fires
  the SAME `oxpulse-chat:token-expired` signal + `onTokenExpired` callback
  the subscribe path already used — previously a write-401 silently rolled
  back with only a `console.warn`, and the host never learned the JWT had
  expired.
- Reaction rollback on an auth-expired write is delayed
  (`WRITE_AUTH_ROLLBACK_DELAY_MS`, 3s) instead of immediate: a host that
  refreshes the `jwt` attribute quickly re-bootstraps the widget (tearing
  down the in-flight `MessageList`) before the delay elapses, so the chip
  never flashes away and back. Non-auth failures still roll back
  immediately (unchanged). The timer is cleared on `destroy()`.
- New failure-counter hook: `WidgetConfig.onWriteError({op, reason})` fires
  on every write failure (not just auth), and the existing
  `oxpulse-chat:write-error` event's `WidgetError` detail now carries
  `op`/`reason` fields — extended, not a new event. Dispatch is no longer
  scoped to the named-write path only; any composer send failure reports.
- `isAuthError()` now understands the raw `SDKChatError` shape
  (`statusCode`/`code`) directly, removing a hand-rolled normalizer that
  would otherwise have been copied a 2nd and 3rd time into the reaction and
  composer write paths.

Closes #78.
