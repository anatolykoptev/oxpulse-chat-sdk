---
"@oxpulse/chat-sdk": minor
---

Add `exportRoom()` / `exportRoomHistory()` — client-side room history export.

Walks `list()` forward from the beginning of the room to exhaustion and
serialises the decrypted rows as JSON (canonical) or text. Rows that failed to
unseal are exported as explicit error entries carrying `seq`, `msgId` and
`unsealError` — never skipped. `ExportResult` reports `totalRows`,
`exportedRows` and `failedRows` so a caller can tell a clean export from a
lossy one without diffing the output. An `AbortSignal` is honoured between
pages. New module `export.ts` (does not grow `client.ts`); thin delegating
method on `SDKChatClient`.
