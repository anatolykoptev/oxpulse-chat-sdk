---
"@oxpulse/chat-sdk": minor
---

fix(chat-sdk): SEC-CR-003 — durable cross-reload anti-replay for the sframe provider

Closes a MEDIUM replay vulnerability (CWE-294). sframe-ratchet's receiver-side replay window is
an in-memory bounded set that is WIPED on page reload, and `ctrStrategy: 'monotonic-idb'` only
persists the SENDER's counter — NOT the receiver's replay defense. So after a reload a malicious or
compromised app-server (the adversary in the E2EE threat model — it cannot forge, but it CAN replay
authentic old ciphertext) could re-serve an OLD sealed frame under a fresh `msg_id`: the AEAD
verifies (the ciphertext is genuinely authentic, just old), the widget's `msg_id` dedup does not
catch it (fresh id), and the stale message renders as new (e.g. replaying an old "approved" / "paid"
chat instruction).

`createSFrameProvider` now persists the set of already-accepted per-(room, sender) CTRs to
IndexedDB (via `idb-keyval`, the same store the outbox uses) so the replay defense survives a
reload. The CTR is read from the RFC 9605 header — which is the AEAD AAD, hence authenticated — via
the library's own `parseHeader`; a replayed CTR is rejected with the library's `ReplayError` (so
`list()` / `subscribe()` already classify it as `unsealError: 'replay'`, no consumer change needed).

Behavior change (why this is a minor, not a patch):

- Durable replay protection is DEFAULT-ON whenever IndexedDB is feature-detected available. A frame
  whose CTR was already accepted in a prior session is now REJECTED instead of accepted. Only
  replays are newly rejected — genuinely-new frames (new CTR) are unaffected — so no legitimate
  send/receive path breaks. The provider now writes a small per-(room, sender) entry to IndexedDB.
- Where IndexedDB is unavailable (SSR, Node without a polyfill, private-mode quirks) the provider
  degrades gracefully to the library's in-memory window (session-scoped only) and emits a one-time
  `console.warn`. It never throws at construct and never breaks a no-IDB runtime.

New `SFrameProviderOptions`:

- `durableReplay?: boolean` (default `true`) — opt out to revert to the in-memory-only window.
- `durableReplayNamespace?: string` / `durableReplayWindow?: number` — namespace + size the durable store.
- `ctrStrategy` / `ctrKeyspace` / `replayWindow` are now surfaced as explicit passthroughs to
  sframe-ratchet (`ctrStrategy: 'monotonic-idb'` additionally persists the sender's counter and
  avoids the random-64 birthday bound; note it does NOT by itself protect the receiver — that is
  what `durableReplay` does).

Residual (documented): the durable window is bounded (default 1024 recent CTRs per sender per room),
so a replay of a frame whose CTR has since been evicted could still pass — the same bound the
library's in-memory window has within a session, now extended across reloads. Multi-tab receivers
each keep their own in-memory mirror; the last tab to write wins the persisted snapshot.
