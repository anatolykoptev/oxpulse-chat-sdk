---
"@oxpulse/chat-sdk": patch
"@oxpulse/chat-widget": patch
---

Gate the attachment-upload path on the poisoned-room fail-closed check
(SEC-CR-001).

`SDKChatClient#assertRoomNotPoisoned` already refuses `send`/`sendText`/`sendFile`
for a room poisoned by a prior `crypto_mode_mismatch` (a downgrade tripwire), so
no message content leaves a poisoned room. But the widget's direct-upload path
(`uploadAttachment` → `presignAttachment` + a raw PUT, which deliberately bypasses
`sendFile()` to keep the presigned `attachmentId` for stage-then-send) had no such
gate: in a poisoned room it presigned and uploaded the file BYTES to storage
before the later, gated `send` — leaking the fail-closed guarantee.

- chat-sdk: expose a minimal public `assertRoomNotPoisoned(roomId)` delegate that
  reads the same authoritative `#poisonedRooms` set as every internal gate (no
  second poison store).
- chat-widget: `uploadAttachment` now calls it before presign, and upload
  capability requires it — a client that cannot answer poison state gets no upload
  capability at all (fail closed). Stage-then-send UX is preserved.
