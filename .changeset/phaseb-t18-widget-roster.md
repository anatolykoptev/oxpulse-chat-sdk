---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

feat(T18): widget roster consumption — display names for other writers

- SDK: new `fetchRoster()` helper fetches `GET /api/sdk/roster` with SDK JWT
- SDK: new `rosterDisplayName(roster, epid)` with 8-char short-form fallback
- SDK: `SubscribeArgs.onRosterSignal` callback — fires on `type:"roster"` SSE signal
- Widget: MessageList fetches roster on mount and re-fetches on invalidation signals (100ms debounce)
- Widget: bubbles show roster display names for other writers; own messages show "You"
- Widget: XSS-safe — roster names use textContent only, never innerHTML (SEC-CR-003 / FF3)
- CI: FF5 issuer-disjointness test (grant JWT iss=app-id ≠ SDK JWT iss=oxpulse)
- CI: FF6 alg-pin tests (alg:none and alg:HS256 rejected; EdDSA passes)
