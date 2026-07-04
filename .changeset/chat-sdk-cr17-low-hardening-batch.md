---
"@oxpulse/chat-sdk": patch
---

fix(chat-sdk): CR17 LOW security-hardening + robustness batch (deferred from #16/#17/SEC-CR-14-02)

Closes a batch of LOW-severity residuals the B2/B3/SEC-CR-14-02 review councils deferred. No new
primitives; each item reuses the existing per-room poison gate, decrypt-chain refcount, and
DurableReplayGuard.

- **Item A — bound the per-room crypto-mode map on the list()-only path (availability).**
  `#activeCryptoModeByRoom` was populated by `list()`/`#fetchRows` but evicted only by
  `subscribe()`'s teardown (chain refCount 0), so a client paging history across many distinct
  rooms via `list()` with no live subscription accumulated one entry per room forever. The map is
  now capped (256); on overflow the oldest entry whose room has NO live subscription is evicted.
  Live rooms and `#poisonedRooms` are never touched — evicting a mode entry can never un-poison a
  room (`#poisonedRooms` is a separate authoritative set, and a poisoned room can never re-resolve).
  This resolves the "Known follow-up" noted in the SEC-CR-001 (downgrade-default-on) changeset.

- **Item B — gate `getThread` on poison; document the exempt metadata tier (security hygiene).**
  `getThread` reads sealed message-content rows but lacked the poison gate its sibling read
  `list()`/`#fetchRows` has — a room proven to have a downgraded/tampered `crypto_mode` still served
  its thread. `getThread` now calls `#assertRoomNotPoisoned` and fails closed. It does NOT resolve
  `crypto_mode`: the threads endpoint returns a BARE JSON array with no per-response `crypto_mode`
  field (only `list()`'s page wrapper carries it) and returns raw sealed rows (caller unseals), so
  there is no mode-dependent dispatch — the poison gate is the relevant boundary. The gate class is
  now documented at `#assertRoomNotPoisoned`: message-content reads/writes are gated;
  interaction-metadata (reactions / typing / presence / markRead / pins) is cleartext by wire
  contract and stays EXEMPT (not governed by `crypto_mode`). `searchByProductRef` (the direct
  sibling — another bare-array sealed-content read) is likewise gated when scoped to a `roomId`
  (SEC-CR-17-B-01).

- **Item C — `flushOutbox` dequeues a permanently-failed entry (robustness).** `flushOutbox`'s catch
  swallowed all errors and left the message queued, so a poisoned-room entry (`send` throws
  `crypto_mode_poisoned`) was retried forever. It now scrubs ONLY a PERMANENTLY-failed entry
  (`crypto_mode_*` / `invalid_args` / `unsupported` / `forbidden` / `not_found`); a TRANSIENT failure
  (`network` / `unauthorized` / `rate_limited` / `server_error`) stays queued for the next flush
  (SEC-CR-17-C-01 — this is a background durability path with no caller notification, so dropping a
  retriable ciphertext message would be silent E2EE message loss). The outbox holds ciphertext only.

- **Item D — regression test for co-subscriber crypto-mode eviction.** Locks the `=== 0` guard in
  teardown: two subscribers on one room → first teardown must NOT evict (refCount 2→1), second must
  (→0). Guards against a future refactor that drops the guard and re-introduces the co-subscriber
  sibling-brick class #16 closed. (Test only.)

- **Item E — gate the durable replay window on the Web Locks API (CR17-02).** `DurableReplayGuard`'s
  persist read-merge-write ran UNLOCKED where `navigator.locks` was absent (legacy Safari <15.4), so
  two tabs concurrently accepting distinct frames could interleave and silently drop a CTR (later
  replayable after reload). `available` now requires BOTH IndexedDB AND Web Locks; without Web Locks
  the guard degrades to a no-op with a one-time CR17-02 `console.warn` (mirroring the no-IDB path) and
  the library's in-memory window still defends within a session. The reachable persist path now always
  holds the lock, so the unlocked-RMW branch is removed. This supersedes the "unlocked RMW
  (last-writer-wins)" residual noted in the SEC-CR-003 (durable-antireplay) changeset. Tradeoff:
  single-tab durable protection on lockless engines is forgone in exchange for an honest, uniform "no
  durable claim without Web Locks" posture (a silently-droppable window is a worse footgun than a
  clearly-absent one).

- **Item F — aged-evicted-CTR replay residual: no change.** Confirmed the SEC-CR-003
  (durable-antireplay) changeset's "Bounded-window eviction" residual note and the
  `SEC-CR-003-01` test accurately document the inherent aged-evicted-CTR replay; the real fix
  (monotonic-idb + persisted high-watermark) stays out of scope.

- **Item G — reconnect-replay: immediate teardown on downgrade + one-page-cap flag (robustness).**
  `replayMissed`'s catch called only `reportError` on a thrown `crypto_mode_mismatch`, so enforcement
  landed a microtask late via the next attach's connected handler. It now tears the subscription down
  immediately (mirrors the connected handler's contract) on `crypto_mode_mismatch` OR
  `crypto_mode_poisoned` (an already-poisoned room hit during replay — SEC-CR-17-G-02, avoids an
  endless reconnect loop against a bricked room), so no second stream re-attaches. Also flags
  (`TODO(#43)`, no behavior change) the one-page replay cap: `replayMissed` replays only the first
  page (limit 50); whether >50 missed messages are recovered depends on the oxpulse-chat server
  backfilling the full gap past the re-attach `after_seq` cursor — needs server-team confirmation.
