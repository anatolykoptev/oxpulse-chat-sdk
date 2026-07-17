---
"@oxpulse/chat-widget": patch
---

Fix reconnect tearing down the fresh subscription on success. On a successful
reconnect, `notifyReconnected()` called `stopReconnectLoop()`, whose unsubscribe
branch immediately tore down the SSE subscription that `#scheduleAttempt` (and the
`online`-event retry) had just established — leaving a permanently-dead room behind
a false "connected" banner: no frames ever arrived again after any network blip.

`stopReconnectLoop()` conflated two responsibilities — cancel the pending retry
timer, and tear down the live subscription. `notifyReconnected()` only wanted the
former. Extracted a timer-only `#cancelRetryTimer()`; `notifyReconnected()` now
calls it instead of `stopReconnectLoop()`. Genuine-teardown callers (clear,
destroy, notifyAuthExpired) keep the full `stopReconnectLoop()`.

Also fixes the complementary leak the self-teardown had been masking: the two
success sites (`#scheduleAttempt`, `#onOnline`) overwrote `#unsubscribe` with the
fresh sub without releasing the previous one. On a flap (reconnect → drop →
reconnect) the prior subscription's teardown was dropped on the floor, so the SDK
decrypt-chain refcount never reached 0 and the orphaned sub kept self-reconnecting
(duplicate delivery + request fan-out). Both sites now route through a
`#replaceSubscription()` helper that tears down the stale sub before assigning the
fresh one (idempotent teardown; the fresh sub is assigned after the release, so it
is never the one torn down).

The existing suite masked all of this because it mocked the unsubscribe fn as a
no-op; added regression tests with a non-noop unsub spy asserting the fresh
subscription stays live after a successful reconnect (both the timer and `online`
paths), that on a flap the stale sub is torn down before the fresh one replaces it,
and that genuine teardown (clear/destroy) still unsubscribes.
