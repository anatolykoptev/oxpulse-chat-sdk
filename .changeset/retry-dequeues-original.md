---
"@oxpulse/chat-widget": patch
---

Pressing retry on a failed message no longer queues a second copy alongside it.

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

Scope, stated precisely: this removes the queued duplicate. It does not cancel a
send already in flight. flushOutbox calls send() directly rather than through the
per-room serial chain, and dequeuing an entry from storage does not stop a request
that has already left — so a retry pressed while a background flush is mid-send of
the same entry can still produce two messages. That window needs flushOutbox's
in-flight guard (#263) to close, and is not claimed here.

The failed bubble stays visible after retry, unchanged — it is the only evidence
of the lost message until the user has re-staged the attachment.
