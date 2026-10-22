---
"@oxpulse/chat-sdk": minor
---

`batchAppend()` no longer hangs forever or fails on the first blip: each attempt has a timeout and transient failures are retried.

Per-attempt timeout is 20 s plus 1 ms per 4 body bytes (a 32 kbps floor for EDGE-class links), capped at 2 min. Network errors, timeouts, 429 (honouring `Retry-After`, up to 60 s) and 5xx are retried with backoff and jitter, up to 4 attempts. Every other 4xx fails immediately. New optional third argument `{ timeoutMs, maxAttempts, signal }`; the signal also cancels backoff waits. When every attempt fails the call throws the new `SDKChatRetryError` (a subclass of `SDKChatError`, `code`/`statusCode` of the last failure, plus `attempts`).

Retrying is safe because the body is built once and re-sent byte-identical, and the server applies the batch in one transaction with `ON CONFLICT (app_id, room_id, msg_id)`; an applied-but-unacknowledged batch is a no-op on re-send. Callers must reuse the same `msgId`s when they re-call `batchAppend` after an error.

Behaviour change: a call that used to reject on the first network error or 5xx now takes up to roughly 4 x timeout to reject. Pass `{ maxAttempts: 1 }` for the old single-shot behaviour.
