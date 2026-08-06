---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

Report the loss of outbox durability instead of degrading in silence.

Every storage operation in the outbox caught its own failure and returned as if
nothing had happened. The send still went out, so the message was not lost — but
retry-after-reload was, and the caller had no way to learn it. On Safari private
browsing, under storage-pressure eviction, or with site data blocked, the SDK
promised durability it was not providing and said nothing.

`@oxpulse/chat-sdk` gains `isOutboxDurable()` and `onOutboxDegraded(fn)`, plus the
`OutboxDegradation` and `OutboxOp` types. The signal latches on the first storage
failure and replays to late subscribers, so a consumer that subscribes after the
failure still learns about it.

`@oxpulse/chat-widget` surfaces it as a new `WidgetErrorCode`,
`OUTBOX_UNAVAILABLE`, on the existing `oxpulse-chat:error` event and `onError`
callback — a degradation notice, not a delivery failure. `WidgetError` gains
`outboxOp`, naming the storage operation that failed, so an integrator reads a
field instead of parsing the message string. Fired at most once per widget
instance.

Closes #261.
