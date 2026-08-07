---
"@oxpulse/chat-sdk": patch
"@oxpulse/chat-widget": patch
---

fix(sdk): flushOutbox in-flight guard + reconnect flush debounce

flushOutbox had no "already running" flag. Two concurrent calls — mount racing
a reconnect, or two reconnects — both read the same pending list and both send
the same entries (wasted requests, server-deduplicated on msgId). There was
also no debounce on the reconnect trigger, so N pending entries over M
reconnects was N×M requests.

SDK: a per-room in-flight guard (`#flushInFlight` Set) makes a second
concurrent `flushOutbox(roomId)` return immediately while the first is still
running. "Return immediately" (not "wait") because the widget calls
fire-and-forget: a dropped flush loses no work — the running flush sends
everything, and transient failures stay queued for the next reconnect/mount.
The guard releases in a `finally` on every exit path including a throw, so a
send rejection cannot latch the outbox into a permanently dead state. The
guard is SEPARATE from `#serializeSend` — feeding a background bulk retry into
the foreground serial chain would park the user's next message behind the
whole outbox queue (#258's head-of-line problem by another door).

Widget: a 500ms debounce on the reconnect-triggered flush collapses rapid
reconnects on a flaky network into one flush. The debounce lives in the widget
(not the SDK) because the reconnect is a widget concept (Reconnector), and
`flushOutbox` is a public SDK method with immediate semantics — a debounce
there would change its contract for every caller. The mount trigger is not
debounced (fires once).

Closes #263.
