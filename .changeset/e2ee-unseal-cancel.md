---
"@oxpulse/chat-sdk": minor
---

fix(chat-sdk): AbortSignal unseal contract + chain-advance gating for the >5s residual

Closes the LAST residual of the concurrent-unseal class (see `docs/architecture/e2ee-model.md`
§3), the one #14 (streamed) / #15 (reconnect-replay) / #14-02 (scrollback) all left open: the
5s per-row unseal deadline was a `Promise.race` that **abandoned** — did not cancel — a slow
unseal. On a >5s row the abandoned `provider.unseal` kept running detached while the chain task
settled as an `unsealError` and the chain started the NEXT unseal → **two unseals in flight for
the same room**, violating the "one unseal in flight per room" invariant a ratcheting AEAD needs.

**Discovery (why the obvious "cancel the decrypt" fix is impossible).** The built-in sframe
provider's unseal bottoms out at `crypto.subtle.decrypt({ name: 'AES-GCM', ... })` (sframe-ratchet
v0.5). WebCrypto's `crypto.subtle.decrypt` takes only `(algorithm, key, data)` — **no**
`AbortSignal` — and is **atomic: it cannot be cancelled mid-flight**. `sframe-ratchet/chat`'s
`unseal(sealed, ctx)` has no signal parameter either. So a genuine "cancel the in-flight decrypt"
is not achievable for the built-in provider.

**What the fix actually does.**
- `CryptoProvider.unseal(sealed, ctx, signal?)` gains an **OPTIONAL, backward-compatible**
  `AbortSignal`. A provider that ignores it (or a pre-existing 2-arg `unseal`) still typechecks
  and works, just non-cancelling.
- `#appendDecryptTask` fires an `AbortController` at the 5s deadline AND **awaits the unseal's
  real settle** (no more `Promise.race` abandonment). The chain never advances to the next unseal
  until the current one actually settles → **at most one unseal in flight per room, categorically**,
  across all three producers (they all funnel through `#appendDecryptTask`).
- The built-in sframe provider honors the signal at its `await` boundaries (before the atomic
  decrypt), so an abort during a slow durable-replay / Web-Locks step skips the uncancellable
  decrypt; once the decrypt has run it completes normally (records + returns — a valid result is
  never discarded).

**Honest claim scope.** For the built-in WebCrypto provider the signal is advisory (the decrypt
is atomic and sub-millisecond); one-in-flight is preserved because the chain awaits the real
settle, not because the decrypt is cancelled. A **cancel-capable** provider (future
worker / streaming / KMS-with-abort) gets a genuine prompt cancel.

**New, narrower residual (deliberate trade-off).** A provider that BOTH ignores the `AbortSignal`
AND hangs forever now stalls THAT one room's decrypt chain (contained per-room; observable via a
distinct `deadline` warn) — a *stalled room*, not a concurrent unseal or a double-delivery. A
stalled-but-genuinely-serial room is safer than a room silently running two unseals against a
ratcheting AEAD. The built-in providers never trigger it (sub-ms decrypt, fast durable steps). A
late-but-successful unseal (a non-cancelling provider finishing after the deadline) delivers its
real plaintext IN ORDER — never re-delivered, never discarded.

**Compatibility.** `minor` (additive optional param). The off-chain `list()` path (a room with no
live subscription) is unchanged — no chain to violate, no deadline, by design.

Tests: `src/__tests__/subscribe-unseal-abort.test.ts` (RED→GREEN — signal-honoring provider stays
one-in-flight across the deadline; non-honoring provider's late success delivered once, in order;
the stalled-room residual is contained + observable; normal <5s unaffected; a 2-arg provider still
works). Two prior tests that asserted the old abandon-at-5s behavior updated to signal-honoring
providers.
