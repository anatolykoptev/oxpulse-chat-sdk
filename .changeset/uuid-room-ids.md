---
"@oxpulse/url-contract": minor
---

Accept the dashed-UUID opaque room-id form (36-char lowercase hex) in parseRoomCode, isValidRoomId and the RoomId brand. The server's sdk-room mint has always returned this shape while the URL layer accepted only the 22-char form, so every navigation into an existing sealed chat bounced off the catch-all route to the landing page (prod 2026-08-18: 156 of 164 rooms carry the UUID shape).
