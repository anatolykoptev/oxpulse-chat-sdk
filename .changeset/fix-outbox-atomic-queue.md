---
"@oxpulse/chat-sdk": patch
---

Make outbox enqueue/dequeue atomic. Both previously did a read-modify-write
over two separate idb-keyval transactions, so two concurrent un-awaited
sends for the same room could silently drop a queued message from the
outbox (lost-update race) — if that message's send then failed
transiently, it was never retried after reload (silent E2EE message
loss). Now uses idb-keyval `update()` — a single readwrite IndexedDB
transaction, atomic within a tab and across tabs.
