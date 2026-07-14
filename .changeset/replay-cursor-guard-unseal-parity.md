---
"@oxpulse/chat-sdk": patch
---

fix(chat-sdk): replayMissed: reject non-monotonic pagination cursor from server; unify unseal mode resolution across list/getThread/searchByProductRef

pr-review-council MED-1 + MED-3.

**MED-1 — replayMissed() cursor-monotonicity guard.** `subscribe()`'s reconnect-replay
loop (`replayMissed()`) trusted the server's `has_more`/`next_cursor` pagination
envelope to strictly advance on every page. The server is UNTRUSTED under the E2EE
threat model (same convention as every other SEC-CR guard in this file) — a
malicious or buggy server replying `has_more: true` with a `next_cursor` that does
not advance past the current cursor would spin the loop forever, re-fetching the
same page. The loop now throws `SDKChatError('server_error', ...)` the first time
`next_cursor` fails to strictly advance (or is `null` on a `has_more: true` page),
mirroring `#fetchRows`' existing `has_more`/`next_cursor==null` guard.

**MED-3 — list()/getThread()/searchByProductRef() unseal-mode parity.**
`#unsealFetchedRows`'s docstring claimed it was "Used by list(), getThread() and
searchByProductRef()", but `list()` had never actually been migrated — it kept a
divergent ~70-line inline copy of the plaintext/E2EE/decrypt-chain dispatch that,
unlike the shared helper, did NOT fall back to the client-configured `#cryptoMode`
when a room's `crypto_mode` had not yet been discovered (the same fallback
`send()`/`sendText()` already rely on). Concretely: a `cryptoMode: 'plaintext'`
client (no e2ee) hitting a server response that omits the `crypto_mode` envelope
field left `list()` silently returning rows with no `.plaintext` field set, while
`getThread()` on the identical input correctly aliased the sealed bytes to
plaintext. `list()` now delegates to `#unsealFetchedRows` like its siblings; the
docstring is now true, and the SEC-CR-14-02 decrypt-chain rationale (previously
duplicated only in `list()`'s inline comment) now lives once, next to the shared
implementation all three callers run.

Tests: `src/__tests__/replay-cursor-monotonic.test.ts` (advancing-cursor
multi-page replay delivers all rows in order and terminates; a non-advancing
`next_cursor` is rejected on the FIRST offending page — bounded fetch-call count,
not a spin — and surfaces via `onError` as the guard's own `SDKChatError`, not a
hang). `src/__tests__/list-getthread-unseal-parity.test.ts` (list() and
getThread() resolve an undiscovered room's plaintext/E2EE mode identically via
the shared `#cryptoMode` fallback).
