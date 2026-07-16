---
"@oxpulse/chat-sdk": patch
---

Harden two crypto-adjacent paths:

- **Bound the durable replay-guard in-memory cache (F4, resource exhaustion).**
  `DurableReplayGuard` created one `MemWindow` per distinct (namespace, room, sender) on
  hydrate and never released it, so a long-lived always-open widget seeing many distinct
  senders/rooms grew memory without bound. The cache is now FIFO-capped
  (`REPLAY_MEM_CACHE_CAP = 256`, mirroring `client.ts`'s shipped `ACTIVE_CRYPTO_MODE_MAP_CAP`);
  an evicted (room, sender) re-hydrates from the authoritative IndexedDB store on next use, so
  cross-reload replay protection is preserved. Eviction never drops an entry mid-hydration or
  with an in-flight persist (which would let a fresh hydrate read a stale window and re-accept a
  replayed CTR).

- **Fail closed when no CSPRNG is available in `generateUUID` (F13, crypto invariant).**
  When both `crypto.randomUUID` and `crypto.getRandomValues` were absent, `generateUUID` silently
  fell back to `Math.random()` — a non-CSPRNG. Since this is a public export usable for
  nonces/session ids (not only message ids), it now throws instead of returning weak randomness.
  On every supported runtime (browser secure origin, Node >= 18 WebCrypto) `getRandomValues` is
  present, so the throw is unreachable in practice.
