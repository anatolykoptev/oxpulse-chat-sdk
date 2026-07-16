---
"@oxpulse/chat-sdk": patch
---

Escalate reconnect backoff on a connect-then-drop flap. `es.onerror`
previously re-entered at attempt 0 every cycle, so a server that accepts
the SSE stream and immediately drops it was retried at ~1 request/second
indefinitely. Consecutive drops now escalate the backoff; a stream that
delivers a frame resets the counter so a genuine recovery reconnects fast.
