---
"@oxpulse/chat-sdk": minor
---

fix(chat-sdk): bound the stalled decrypt chain + honest semantics + reuse AbortSignal stdlib

Closes the LAST residual of the concurrent-unseal class (see `docs/architecture/e2ee-model.md`
§3): the 5s per-row unseal deadline was a `Promise.race` that **abandoned** — not cancelled — a
slow unseal. On a >5s row the abandoned `provider.unseal` kept running detached while the chain
task settled as `unsealError` and the chain started the NEXT unseal → **two unseals in flight**
against a ratcheting AEAD, for EVERY >5s row.

**Discovery.** The built-in provider's unseal bottoms out at `crypto.subtle.decrypt({name:'AES-GCM'})`
(sframe-ratchet v0.5). WebCrypto's decrypt takes only `(algorithm, key, data)` — **no AbortSignal,
atomic, non-cancellable**. So "cancel the in-flight decrypt" is impossible for the built-in provider;
the honest fix is chain-advance gating, not decrypt cancellation.

**The fix — TWO bounds (reconciles one-in-flight with bounded-settle):**
- `CryptoProvider.unseal(sealed, ctx, signal?)` gains an **OPTIONAL, backward-compatible**
  `AbortSignal`. A provider that ignores it (or a pre-existing 2-arg `unseal`) still works.
- `#appendDecryptTask` bounds each unseal twice:
  1. **Abort deadline** — an `AbortController` fires at the deadline (passed to `provider.unseal`).
     A signal-honoring provider rejects promptly so the chain advances; the task AWAITS the real
     settle (no Promise.race abandonment) → a **healthy provider gives strictly at most one unseal
     in flight per room** (the built-in decrypt is sub-ms and never even reaches the deadline).
  2. **Force-drain** at `deadline + grace` — if the unseal has STILL not settled (a provider that
     ignores the signal AND hangs), that one row is bailed as `unsealError` so the chain **drains**:
     the next unseal runs, `list()`/`Promise.all` resolves, and the `RoomDecryptChain` entry is
     cleaned up. **No room-wide black-hole, no Map leak.**
- The built-in sframe provider reuses the stdlib `signal.throwIfAborted()` at its await boundaries
  (before the atomic decrypt); a successfully-decrypted frame is always recorded + returned.

**Why this replaced an earlier (wrong) "await the real settle, accept a stalled room" attempt.**
The pr-review-council caught that awaiting the real settle *without* a hard bound turned a hung
non-honoring provider into a **permanent** black-hole (list() never resolves, every future room
row queued behind an eternal tail) + a `RoomDecryptChain` leak — strictly WORSE than the bounded
`Promise.race` it replaced. The force-drain restores the bounded-settle guarantee.

**Honest claim scope + the two bounded residuals.**
- Healthy provider (incl. built-in): strict one-in-flight, real plaintext in order.
- Genuinely-stuck non-honoring provider (crossed `deadline + grace`): (a) its orphaned unseal stays
  *pending* while the chain advances, so `maxInFlight` can transiently reach 2 — but ONLY for a row
  past the hard bound, and the orphan is *parked* (not progressing / not racing the ratchet); its
  late result is dropped by a `settled` guard (never re-delivers, never advances the chain).
  (b) that orphaned continuation lives until the provider's own operation settles — inherent, since
  JS cannot cancel a live promise; only the provider honoring the signal releases it.
  Both are contained per-room, and observable via distinct `deadline` + `force-drain` warns.

**Compatibility.** `minor` (additive optional param). The off-chain `list()` path (a room with no
live subscription) is unchanged — no chain to violate, no deadline, by design.

**Deviation note.** The client-side deadline uses a manual `AbortController` + `setTimeout` (not
`AbortSignal.timeout()`) because the latter is not controllable by the test harness's fake timers
(empirically verified), and a manual force-drain `setTimeout` is required regardless. The stdlib
`signal.throwIfAborted()` IS reused inside the built-in provider (timer-independent).

Tests: `src/__tests__/subscribe-unseal-abort.test.ts` (one-in-flight for a honoring provider across
the deadline; late-success delivered once in order; **bounded-drain** for a never-settling provider —
row bailed as unsealError, chain advances, orphan's late settle dropped, no chain-entry leak;
normal <5s unaffected; 2-arg provider works). `src/__tests__/subscribe-scrollback-decrypt-chain.test.ts`
adds a **list() RESOLVES via force-drain** case for a non-honoring stuck provider. `sframe-unseal-abort.test.ts`
guards the SEC-CR-003 durable-replay integrity across the abort boundary.
