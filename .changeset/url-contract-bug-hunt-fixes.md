---
"@oxpulse/url-contract": minor
---

Bug-hunt fixes: decode fragments in standalone parsers, /s/ short-link support in parseRoomUrl, fragment-route validation per ADR-0005, implement stripChecksum.

- **#341 (HIGH):** `parseCallFragment`/`parseBurnerFragment`/`parseRoomFragment` now `decodeURIComponent` their output, matching `parseRoomUrl`. Invalid percent-sequences return null.
- **#342 (MEDIUM):** `parseRoomUrl` now supports `/s/<alias>` short-link URLs — returns `{ alias, routePrefix: '/s/' }`.
- **#343 (MEDIUM):** `parseRoomUrl` validates fragment type matches route prefix per ADR-0005: call fragment on bare-root only, burner fragment on `/c/` only, no fragments on `/r/` or `/m/`.
- **#344 (MEDIUM):** Implemented `stripChecksum` — inverse of `appendChecksum`, returns 9-char payload from 10-char code without verifying.
