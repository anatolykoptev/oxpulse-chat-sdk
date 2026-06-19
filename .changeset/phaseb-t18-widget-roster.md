---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

feat(T18): widget roster consumption — display names for other writers

- SDK: new `fetchRoster()` helper fetches `GET /api/sdk/roster` with SDK JWT
- SDK: new `rosterDisplayName(roster, epid)` with 8-char short-form fallback
- SDK: `SubscribeArgs.onRosterSignal` callback — fires on `type:"roster"` SSE signal
- SDK: `mintNamedWriteToken` alg-pin guard — rejects tokens with alg≠EdDSA returned by the mint endpoint (defense-in-depth; server enforces EdDSA at exchange, client now enforces at receipt)
- Widget: MessageList fetches roster on mount and re-fetches on `type:"roster"` SSE invalidation signals (100ms debounce)
- Widget: element adapter now forwards `onRosterSignal` to `sdkClient.subscribe` (was silently dropped — the re-fetch end-to-end path was broken)
- Widget: bubbles show roster display names for other writers; own messages show "You"
- Widget: XSS-safe — roster names use textContent only, never innerHTML (SEC-CR-003 / FF3)
- CI: FF6 alg-pin — `mintNamedWriteToken` rejects alg:none and alg:HS256 tokens (real production guard, red-on-revert)
- CI: issuer-disjointness (FF5) — server-enforced invariant; client-side tautology removed; server tests own it
