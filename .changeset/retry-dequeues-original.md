---
"@oxpulse/chat-widget": patch
---

Pressing retry on a failed message no longer delivers it twice.

A send that exhausts its retries deliberately stays queued in the outbox, so a
later flushOutbox can still deliver it. The widget's retry button restores the
caption to the composer and the user re-picks the attachment, which mints a new
msgId — so the original entry was still queued alongside it and the next flush
sent both. One user intent, two messages in the room, with no error, counter or
log to show for it.

Retry now dequeues the original entry first, matching what TDLib and GetStream
do. Reusing the msgId instead would be worse here: the user re-picks the
attachment, so the content can differ, and the server's dedup would keep the
original and silently discard what the user just chose.

The failed bubble stays visible after retry, unchanged — it is the only evidence
of the lost message until the user has re-staged the attachment.
