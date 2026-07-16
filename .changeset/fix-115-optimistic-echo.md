---
"@oxpulse/chat-widget": patch
---

Add optimistic echo for sent messages. Messages now appear instantly in
the chat list when the user hits send, instead of waiting for the server
SSE round-trip. The optimistic row is inserted with a client-generated
msgId; when the server SSE event arrives with the same msgId, the row is
updated in place (seq, createdAt, etc.).

Also wires sendTextOptimistic for E2EE consumers (wraps the SDK OptimisticHandle
into the Promise<{msgId}> the Composer expects).
