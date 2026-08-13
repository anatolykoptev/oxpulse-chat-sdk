---
"@oxpulse/chat-sdk": minor
---

feat(sdk): add mintShareLink + joinByLink for share-link room join (#292)

Two new public methods on SDKChatClient:
- `mintShareLink(roomId, args?)` — POST /api/sdk/rooms/:room_id/shortlink
- `joinByLink(roomId, alias)` — POST /api/sdk/rooms/:room_id/join

New exported types: `ShareLink`, `JoinResult`.

`joinByLink` returns `joined: false` for the idempotent already-a-member
path (not an error). Error mapping reuses the shared `httpStatusToCode`
so 429→rate_limited is distinguishable from 403→forbidden at the call site.
12 contract tests, 3 mutation gates (F1/F2/F3) verified RED.
