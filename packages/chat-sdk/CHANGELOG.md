# @oxpulse/chat-sdk — Changelog

## 3.0.2

### Patch Changes

- 73c08db: Product-card followups (#113, #114, #116, #117):

  - **chat-widget**: Composer now renders a dismissible "product card attached" chip
    when a card is staged via `setProductCard`, mirroring the reply-preview bar
    pattern. The chip's × dismiss calls `clearProductCard()`; the chip is hidden on
    clear and after a successful send. i18n: `productCardAttached` + `removeProductCard`
    in en and ru. Theme CSS mirrors the reply-preview classes.
  - **chat-widget**: New end-to-end test mounts `OxpulseChatElement` with a real
    `SDKChatClient` + fetch mock, calls `setProductCard` + sends, and asserts the
    outgoing POST body carries `product_ref` + `product_meta` through the full
    adapter → SDK → wire path.
  - **chat-sdk**: `rowToMessageRow` now normalizes `product_meta` at the receive
    boundary — requires title/price/currency non-empty strings, caps lengths
    (title 200, price 40, currency 16, urls 2048), coerces bad URLs to '', returns
    null for non-object or invalid payloads. `MessageRow.productMeta` is now honest
    for all SDK consumers.
  - **chat-sdk**: `sendProductCard()` doc-comment documents its role as the public
    external-integrator convenience API and explains why the in-house widget routes
    cards through `sendText()` instead. No behavior change.

## 3.0.1

### Patch Changes

- ba359e1: fix(chat-sdk): replayMissed: reject non-monotonic pagination cursor from server; unify unseal mode resolution across list/getThread/searchByProductRef

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

## 3.0.0

### Major Changes

- 779bf9f: feat: roster avatar_url + display name end-to-end

  `GET /api/sdk/roster` now returns an additive `avatars` map alongside `roster`.
  `fetchRoster` parses it and returns `Map<epid, RosterEntry>` (`{ displayName,
avatarUrl }`) instead of `Map<epid, string>`. `rosterDisplayName(map, epid)` is
  unchanged; new `rosterAvatar(map, epid): string | null`. The widget renders a
  leading avatar (image with an initials-circle fallback, deterministic color per
  epid) beside other writers' messages; own messages are unchanged.

  BREAKING (@oxpulse/chat-sdk): code reading the raw roster map value as a string
  must switch to `rosterDisplayName(map, epid)` / `rosterAvatar(map, epid)` (or read
  `.displayName` / `.avatarUrl`). The HTTP response is backward-compatible — the
  `roster` name map is unchanged and `avatars` is purely additive, so a widget
  built against the old response keeps working.

### Minor Changes

- 6c59dcb: feat: roster role badge (moderator/owner)

  `GET /api/sdk/roster` now returns an additive, sparse `roles` map alongside
  `roster`/`avatars` (only privileged members appear; a plain `member` is
  implied by absence). `fetchRoster` parses it into `RosterEntry.role?:
"moderator" | "owner"`; new `rosterRole(map, epid): PrivilegedRole |
undefined`. An unrecognised role string fails closed (no role, no badge).

  The widget renders a small badge ("mod" / "owner" by default) next to a
  privileged member's name for other writers' messages (own messages are
  unchanged, mirroring the avatar convention). New widget config option
  `roleLabels?: Record<string, string>` lets partners rebrand the badge text
  (e.g. `{ moderator: "Seller" }`) — presentation only, never client-side
  authorization.

  Fully additive and backward-compatible: a server response with no `roles`
  key (old engine) parses with `role` `undefined` on every entry, and the
  badge simply does not render.

## 2.0.1

### Patch Changes

- ddbab29: docs: republish so npm-displayed READMEs match shipped reality

  npm serves a package's README from the tarball snapshot taken at publish time, so
  the source-tree doc fixes do not reach npmjs.com until the next published version.
  This patch bump republishes all three packages so their npm pages show current docs:

  - chat-sdk: version badge 1.0.0 → 2.0.0; document the SEC-CR-001 downgrade-defense
    default-on behaviour + cryptoMode option; correct the batchAppend example (was
    documenting the internal snake_case wire DTO, not the exported camelCase
    BatchAppendItem — old example would not type-check); fix the error-code table
    (server_5xx → server_error, add the crypto-mode/unsupported codes); add the
    edited/deleted MessageRow fields; fix a dangling ../../LICENSE link.
  - wire-codec: drop the stale "private: true / no publish pipeline" claims (the
    package is public on npm via the changesets+OIDC pipeline); document the 0xC9
    mesh-bundle-v1 API + magic byte.
  - chat-widget: carry the CDN version/SRI/npm-install README fixes (already in the
    source tree) onto npm.

- Updated dependencies [ddbab29]
  - @oxpulse/wire-codec@0.4.1

## 2.0.0

### Major Changes

- ce7863f: fix(chat-sdk): SEC-CR-001 — default-on E2EE downgrade defense, scoped per-room

  Closes a HIGH confidentiality vulnerability (CWE-757 protocol downgrade). An E2EE-configured
  channel could silently fall back to PLAINTEXT on a server-controlled `crypto_mode: 'plaintext'`
  signal, because downgrade defense was opt-in. A malicious or compromised app-server could make any
  consumer that enabled `e2ee` (without also setting `cryptoMode: 'sframe-static'`) transmit cleartext
  the server reads — TLS does not help, the server is the endpoint.

  Behavior changes (why this is a major bump):

  - With an `e2ee` provider configured, `cryptoMode` now DEFAULTS to `'sframe-static'` (previously
    effectively null/auto-detect). A server-emitted `crypto_mode: 'plaintext'` for an e2ee client is now
    a poison-mismatch (throws `crypto_mode_mismatch`, and that room then fails closed) instead of an
    accepted downgrade. Callers who legitimately ran an e2ee client against plaintext rooms must
    reconsider that configuration.
  - Constructing with an `e2ee` provider AND `cryptoMode: 'plaintext'` now THROWS `invalid_args` at
    construct (contradictory config: an encryption provider plus an explicit opt-out of encryption).
    Previously it succeeded and sent plaintext. Migration: pass only one of the two.
  - An e2ee client with no explicit `cryptoMode` now seals and sends immediately by default. Previously a
    send before the first `list()`/`subscribe()` threw `crypto_mode_undiscovered`; that path is now
    safe-by-default and the error no longer fires for e2ee clients.

  Availability: the discovered crypto_mode and the poison flag are scoped PER ROOM, so one room's
  mismatch/downgrade poisons only that room — sibling rooms on the same `SDKChatClient` keep working
  (no client-wide brick / DoS amplification via a single malicious `crypto_mode` for one room).

  No change for clients WITHOUT an `e2ee` provider: plaintext remains a valid auto-detected mode.

  Known follow-up (non-security): the per-room `crypto_mode` cache is evicted at subscription teardown,
  but rooms touched only via `list()` without a live subscription are not yet evicted — a client paging
  many distinct rooms accumulates a small (~100 B) per-room entry until it is recreated. RESOLVED by
  CR17-01 (Item A of the CR17 hardening batch): the map is now capped and the oldest no-live-subscription
  entry is evicted on overflow.

### Minor Changes

- 78d7327: fix(chat-sdk): SEC-CR-003 — durable cross-reload anti-replay for the sframe provider

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

  New options, surfaced both on `SFrameProviderOptions` AND on the public client config
  (`E2EEOptions` `'sframe'` variant) so they are reachable without the custom-provider escape hatch:

  - `durableReplay?: boolean` (default `true`) — opt out to revert to the in-memory-only window.
  - `durableReplayNamespace?: string` — namespaces the durable store. Through the client it DEFAULTS
    to the client's `appId`, so distinct tenants on one origin do not share a replay window.
  - `durableReplayWindow?: number` — size of the durable window. `0` DISABLES it (mirrors
    `replayWindow: 0`); a negative value is invalid and falls back to the default (does not disable).
  - `ctrStrategy` / `ctrKeyspace` / `replayWindow` are surfaced as explicit passthroughs to
    sframe-ratchet (`ctrStrategy: 'monotonic-idb'` additionally persists the sender's counter and
    avoids the random-64 birthday bound; note it does NOT by itself protect the receiver — that is
    what `durableReplay` does).

  Residuals (documented, accepted):

  - Bounded-window eviction: the durable window tracks the 1024 most-recent CTRs per (room, sender),
    so a replay of a frame whose CTR has since been evicted by ≥1024 later accepts can still pass —
    the same bound the library's in-memory window has within a session, now extended across reloads.
    A high-watermark would close this for a monotonic sender, but is intentionally NOT applied: the
    receiver cannot know a REMOTE sender's CTR strategy from the frame, so assuming monotonicity would
    false-reject every legitimate message from a `random-64` peer in a mixed-strategy room. The
    strategy-agnostic bounded set is safe for mixed rooms; a homogeneous `monotonic-idb` deployment
    that wants unbounded protection is a possible future opt-in.
  - Storage growth: one small IDB entry per (room, sender), not garbage-collected (mirrors the
    outbox's per-room key). Bounded per entry (≤1024 CTRs); the entry count grows with distinct
    (room, sender) over the client lifetime.
  - Concurrency: cross-tab persist writes are serialized by the Web Locks API and each write is a
    read-merge-write, so a second tab's accepted CTRs are merged rather than clobbered (the earlier
    "last tab wins" caveat no longer applies UNDER CAPACITY). Each tab still keeps its own in-memory
    mirror; a CTR another tab accepted is reflected into this tab on its next persist / on reload.
    Residual: the merge is bounded to `window` and eviction is position-based (the writing tab's
    entries sit last), so when two divergent live tabs together exceed `window` distinct CTRs a peer
    tab's older recent CTRs can still be evicted — no worse than the bounded window's inherent horizon.
    (SUPERSEDED by CR17-02 / Item E of the CR17 hardening batch: where `navigator.locks` is absent the
    RMW no longer runs unlocked — durable persistence is gated OFF entirely, so there is no
    last-writer-wins drop.) A strict-recency cross-tab merge would need per-CTR acceptance ordinals (a
    `v:1`→`v:2` store migration) — tracked as a follow-up, not in this PR.
  - Same-session ordering: `check()` and `accept()` straddle the `await inner.unseal`. This does NOT
    weaken cross-reload protection (hydrate loads persisted CTRs before any `check()` resolves). The
    only residual is a within-session double-DELIVERY of one genuinely-new CTR when two `unseal()`
    calls for the same frame overlap: `subscribe()` / reconnect serialize every unseal through the
    per-room decrypt chain (SEC-CR-14-01) and are safe; `list()` calls `unseal()` directly and is NOT
    serialized, so two concurrent `list()` calls could double-deliver. Pre-existing, idempotent,
    tracked as tasks #44 / #42 — not a replay bypass introduced here.
  - Same-origin multi-deployment: two independent deployments sharing an origin AND a namespace (e.g.
    both omitting `appId` → `'default'`) with a colliding (roomId, senderUid) would share a window;
    give each deployment a distinct `appId` / `durableReplayNamespace`.
  - If IndexedDB is present but its read/write throws (private-mode / partitioned storage), the
    session starts with an empty window and a one-time warning is emitted — cross-reload protection
    is unavailable that session (the in-memory window still defends within the session).

- e3a31ed: fix(chat-sdk): bound the stalled decrypt chain + honest semantics + reuse AbortSignal stdlib

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
  The pr-review-council caught that awaiting the real settle _without_ a hard bound turned a hung
  non-honoring provider into a **permanent** black-hole (list() never resolves, every future room
  row queued behind an eternal tail) + a `RoomDecryptChain` leak — strictly WORSE than the bounded
  `Promise.race` it replaced. The force-drain restores the bounded-settle guarantee.

  **Honest claim scope + the two bounded residuals.**

  - Healthy provider (incl. built-in): strict one-in-flight, real plaintext in order.
  - Genuinely-stuck non-honoring provider (crossed `deadline + grace`): (a) its orphaned unseal stays
    _pending_ while the chain advances, so `maxInFlight` can transiently reach 2 — but ONLY for a row
    past the hard bound, and the orphan is _parked_ (not progressing / not racing the ratchet); its
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

- def28fc: feat(T18): widget roster consumption — display names for other writers

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

### Patch Changes

- 917c97a: fix(chat-sdk): CR17 LOW security-hardening + robustness batch (deferred from #16/#17/SEC-CR-14-02)

  Closes a batch of LOW-severity residuals the B2/B3/SEC-CR-14-02 review councils deferred. No new
  primitives; each item reuses the existing per-room poison gate, decrypt-chain refcount, and
  DurableReplayGuard.

  - **Item A — bound the per-room crypto-mode map on the list()-only path (availability).**
    `#activeCryptoModeByRoom` was populated by `list()`/`#fetchRows` but evicted only by
    `subscribe()`'s teardown (chain refCount 0), so a client paging history across many distinct
    rooms via `list()` with no live subscription accumulated one entry per room forever. The map is
    now capped (256); on overflow the oldest entry whose room has NO live subscription is evicted
    (bounded FIFO / insertion-order, NOT LRU — equivalent for the page-once-per-room pattern; hot
    rooms are not specially protected). Live rooms and `#poisonedRooms` are never touched — evicting
    a mode entry can never un-poison a room (`#poisonedRooms` is a separate authoritative set, and a
    poisoned room can never re-resolve). This resolves the "Known follow-up" noted in the SEC-CR-001
    (downgrade-default-on) changeset. (Follow-up, tracked separately: `#poisonedRooms` itself is not
    yet bounded — it grows only under an active downgrade attack today, but a server crypto_mode
    bookkeeping bug touching many rooms would grow it unboundedly.)

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

  - **Item C — unify the outbox permanence doctrine across ALL THREE write paths (robustness).**
    All three outbox writers (`flushOutbox`, `sendOptimistic`, `sendTextOptimistic`) now consult ONE
    authority — `PERMANENT_OUTBOX_FAILURE_CODES`. They scrub an entry ONLY on a PERMANENTLY-failed code
    (`crypto_mode_*` / `invalid_args` / `unsupported` / `forbidden` / `not_found`); a TRANSIENT failure
    (`network` / `unauthorized` / `rate_limited` / `server_error`) stays queued for a later flush
    (SEC-CR-17-C-01 — dropping a refreshable-401 / rate-limited / 5xx ciphertext entry would be silent
    E2EE message loss). `flushOutbox`'s original swallow-all catch retried a poisoned entry forever; the
    first pass fixed only `flushOutbox` with a blanket `!== 'network'` rule that STILL dropped transient
    429/5xx on the two foreground paths — this unifies all three on the permanent-code Set. The
    foreground paths keep their retry loop for transient codes, then leave the entry queued for
    `flushOutbox` (still notifying the caller via `onFailed`). The outbox holds ciphertext only.

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

- f3e9c7f: fix(chat-sdk): SEC-CR-14-02 — route scrollback unseal through the per-room decrypt chain when a subscription exists

  Closes the last OFF-CHAIN unseal path of the concurrent-unseal class (same class as
  #14, which serialized the streamed unseal, and #15/SEC-CR-14-01, which serialized the
  reconnect/replay unseal).

  The public `list()` pagination / scrollback path (backward paging via `beforeSeq`, and
  any `list()` of a room that also has a live subscription) unsealed rows directly via
  `provider.unseal()` — OFF the per-room serial `#decryptChain`. A direct-SDK consumer
  that `subscribe()`d a room AND `list()`d that same e2ee room's scrollback concurrently
  ran two unseals at once on the room's SFrame ratchet → ratchet / replay-window desync,
  the exact failure the chain exists to prevent.

  Scope of the guarantee (precise, NOT categorical): with this fix, the
  "at most one unseal in flight per room" invariant holds for unseal calls that SETTLE
  within the chain's 5s per-row timeout, across all three call sites (streamed, reconnect,
  scrollback). It does NOT hold for a >5s unseal: the timeout is a `Promise.race`, which
  ABANDONS (does not cancel) a slow unseal — the abandoned call keeps running detached
  while the task settles as an `unsealError` and the chain starts the next unseal, so two
  can be in flight. That residual is pre-existing across all three call sites and is
  bounded to idempotent double-DELIVERY by sframe-ratchet's static per-(room,sender) key
  (NOT a replay or confidentiality break). A genuine `AbortSignal` cancel — the real
  categorical fix — is a `CryptoProvider.unseal` interface change tracked separately. A
  real >5s timeout now emits a distinct `console.warn` so the abandonment is observable in
  prod instead of silently folded into an unsealError.

  Behavior change (why a bump): when a room has a live subscription (`#decryptChain`
  refCount > 0), `list()`'s unseal for that fetch now serializes onto the room's decrypt
  chain instead of running concurrently. Same items are returned, in the same server
  order; the fetch may resolve slightly later because its unseal queues behind any
  in-flight streamed / replay unseal. A `list()` for a room with NO live subscription is
  unchanged — it still unseals directly off-chain (there is no chain entry to append to,
  and no streamed unseal can race), so one-shot fetches still deliver every row.

  Timeout asymmetry (same `list()` call, different failure semantics by subscription
  state): the on-chain path (refCount > 0) inherits the 5s per-row timeout — a stuck row
  bails with an `unsealError` and the fetch resolves — whereas the off-chain path
  (refCount 0) awaits `provider.unseal` with NO timeout and hangs the fetch indefinitely
  on a stuck row (unchanged from before this fix).

  Chain-latency coupling: because scrollback now shares the room's serial chain, a page
  whose rows each hit the 5s timeout occupies the chain up to page_size × 5s, queuing
  live-stream messages behind it. In practice page size is server-clamped, but a consumer
  paging with a slow/stuck provider will see live delivery for that room stall until the
  page drains.

  No API, signature, or configuration change. Not widget-triggered (the widget never
  paginates with `beforeSeq`); reachable on the SDK's public API surface by a direct-SDK
  consumer or a sibling app's own api layer.

- Updated dependencies [29b5d83]
  - @oxpulse/wire-codec@0.4.0

## 1.6.0

### Minor Changes

- b04592b: client-side named-write mint helper

  Adds `mintNamedWriteToken(opts)` — sibling to `mintAnonReadToken`. POSTs to the
  client's own mint endpoint with `room_id` in the body, returns the raw JWT string.

  Throws `NamedWriteMintError` (with `.code` and `.status`) on non-2xx responses.
  Error codes: `unauthorized` (401), `forbidden` (403), `rate_limited` (429),
  `mint_failed` (other errors or malformed body).

  Both `mintNamedWriteToken` and `NamedWriteMintError` are exported from the package index.

## 1.5.0

### Minor Changes

- 161abae: client-side anon-read: `mintAnonReadToken` + widget `allow-anon-read` mode

  **@oxpulse/chat-sdk**: adds `mintAnonReadToken(opts)` helper that POSTs to
  `/api/sdk/auth/anon-read-mint` and returns a short-lived read-only JWT.
  Throws `AnonReadMintError` (with `.code` and `.status`) on non-2xx responses.
  Both are exported from the package index.

  **@oxpulse/chat-widget**: adds `allow-anon-read` boolean attribute (presence =
  true) and `base-url` attribute to `<oxpulse-chat>`. When `allow-anon-read` is
  present and no `jwt` attribute is set, the widget automatically mints an anon
  token, mounts in read-only mode (composer hidden), and schedules a re-mint 30 s
  before the 300 s token expiry. When `jwt` is provided, the existing authed path
  is unchanged. Includes injectable `_mintAnonReadToken` DI hook for tests.

All notable changes to this package will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-05-27 — Web Push integration

### Added

- **`SDKPushClient` class** — typed wrapper for Web Push subscribe/unsubscribe flow. Server endpoints: `GET /api/sdk/push/vapid-public-key` (unauthenticated), `POST /api/sdk/push/subscribe`, `DELETE /api/sdk/push/unsubscribe`. Scope: `push:write:*`. Methods: `getVapidPublicKey()`, `subscribe(opts?)`, `unsubscribe()`, `currentSubscription()`, `attachSubscriptionChangeListener(opts)`. Static helpers: `isSupported()`, `permission()`, `requestPermission()`.
- **`SDKPushError` class** — typed error with discriminated `code: SDKPushErrorCode`. Codes: `'unsupported' | 'invalid_args' | 'permission_denied' | 'permission_required' | 'no_vapid_key' | 'network' | 'server_4xx' | 'server_5xx' | 'subscription_invalid'`.
- **Types exported**: `SDKPushErrorCode`, `SubscribeResult`, `SubscriptionChangeListenerOpts`.

### Changed

- Push surface previously lived at `web/src/lib/api/sdkPush.ts` (oxpulse-chat-internal). Consumers within oxpulse-chat now import from `@oxpulse/chat-sdk` to align with external integrators.

### Server compat

Push endpoints unchanged (since W3 plan, see `docs/superpowers/plans/2026-05-13-w3-push-notifications.md`). No server-side changes in this release.

## [1.2.0] — 2026-05-27 — Phase 2 plaintext + mass-chat methods + marketplace primitives

Promotes the in-progress 1.1.0 entry to 1.2.0 to include three additional method exports (two
mass-chat methods + the marketplace primitives that were in source but undocumented since
commit `a18d8935`). Non-breaking: all 1.0.1 consumers see zero behavioural change.

### Added

**Phase 2 — plaintext mode (PRs #1683–#1702):**

- **`CryptoMode` type export** — discriminated union `'sframe-static' | 'plaintext'`. Re-exported from package root (`import type { CryptoMode } from '@oxpulse/chat-sdk'`).
- **`SDKChatClientOptions.cryptoMode?: CryptoMode`** — declares the expected server-side crypto mode for the room's app. Omitting it (default) behaves as `'sframe-static'`.
- **`SDKChatClientOptions.aliasSealedAsPlaintext?: boolean`** — wire-compat option for the v2.1 `sealed_b64 → payload_b64` rename followup (P2-F2). Set to `true` when targeting a server that already uses `payload_b64` in list/subscribe responses.
- **Downgrade defense (SEC-CR-1695-02):** when the server-emitted `crypto_mode` (from SSE `event: connected` prelude or list-response envelope) mismatches the client-configured mode, the client is permanently poisoned (`#cryptoModePoisoned`). All subsequent `send` / `sendText` / `list` / `subscribe` calls throw `SDKChatError` with code `crypto_mode_mismatch`. A poisoned client is not recoverable — callers must construct a new instance. Reverse-direction attacks (compromised server flipping an sframe-static client into plaintext) are prevented by this gate.
- **SSE `event: connected` prelude** — server now emits a `connected` event before the first message on any subscribe channel. The event payload includes `crypto_mode` (the room's configured server-side mode). The SDK parses this and validates against the client-configured `cryptoMode`.
- **`ListResponse.crypto_mode` field** — the list envelope now carries `crypto_mode` alongside `items`, `has_more`, and `next_cursor`. The SDK validates it on every `list()` call.
- **`SDKChatErrorCode` gains two new values:** `'crypto_mode_mismatch'` (server mode ≠ client expectation) and `'crypto_mode_poisoned'` (client already poisoned by a prior mismatch; recreate the instance).

**Marketplace primitives (in source since commit `a18d8935`, undocumented in 1.0.1):**

- **`sendProductCard(roomId, opts)`** — send a server-side message with a product card payload. Bundles `product_ref + product_meta + sealedBody?` in one call. Wire: `POST /api/sdk/messages` with `{product_ref, product_meta}` in the body.
- **`searchByProductRef(productRef, opts?)`** — cross-room (or per-room with `opts.roomId`) message search by product reference. Returns `MessageRow[]` sorted by seq. Wire: `GET /api/sdk/messages?product_ref=X[&room_id=Y][&limit=N]`.

**Mass-chat methods (this PR — for 5K+ buyer/seller rooms):**

- **`batchAddMembers(roomId, userIds[], role?)`** — wraps the server's bulk `user_ids` shape of `POST /api/sdk/rooms/{room_id}/members`. Chunks the input array into 500-sized sequential batches (matching server constant `BULK_ADD_MAX=500` in `crates/sdk/src/rooms.rs:78`) and aggregates `{ added, updated }` results. `added` = newly inserted members; `updated` = re-activated or role-updated members (field names mirror server docstrings in `crates/sdk/src/rooms.rs:281-286`). Empty array throws `SDKChatError('invalid_args')` without a network call.
  - For 5K-buyer rooms: 10 chunks of 500 is well below the default burst=15 rate limit; calling `addMember()` in a loop hits 429 after ~15 calls.
  - **Partial-failure contract:** on mid-bulk failure (e.g. 429 on chunk N of M), throws `SDKChatBatchError` carrying `{ partial: { added, updated }, failedAtIndex, failedChunk, remaining }`. The caller can compute the residual to retry from `e.failedChunk + e.remaining`.
- **`SDKChatBatchError` class** (new) — extends `SDKChatError`. Carries partial-success aggregate + `failedAtIndex`, `failedChunk`, `remaining`, `cause`. Exported from package root: `import { SDKChatBatchError } from '@oxpulse/chat-sdk'`.
- **`BATCH_ADD_MEMBERS_CHUNK` constant export** — value `500`, mirrors server `BULK_ADD_MAX`. Callers can inspect this to pre-validate their input without a network call.
- **`deleteRoom(roomId)`** — clears a room's entire message history via `DELETE /api/sdk/messages/{room_id}`. Destructive: use to close out a buyer-seller deal or purge test data. Does NOT delete room metadata or memberships.

### Changed

- No breaking changes. Default crypto mode remains `'sframe-static'`. All 1.0.1 call sites compile unchanged.
- `validateAndResolveCryptoMode()` internal helper introduced (replaces ad-hoc mode checks in `list()` and `subscribe()`).

### Server compat

Requires oxpulse-chat server Phase 2 (Waves 2.1–3.3 of the rev 16 plan). Minimum compatible server commit: `c475b0bf` (dev→main merge of PR #1702, deployed 2026-05-27T20:34Z).

`batchAddMembers` / `deleteRoom` rely on the rooms module introduced earlier (pre-Phase 2). The server constant `BULK_ADD_MAX = 500` is defined in `crates/sdk/src/rooms.rs:78`.

Older servers that do not emit `crypto_mode` in the connected prelude or list envelope will work transparently — the client treats a missing field as "server has not declared mode yet" and skips mismatch validation.

### References

- Plan: [`docs/superpowers/plans/2026-05-19-chat-sdk-v2.0-alt-plaintext-groups.md`](../../docs/superpowers/plans/2026-05-19-chat-sdk-v2.0-alt-plaintext-groups.md) (rev 16)
- PR #1683 — chat mirror migration
- PR #1684 — `SDKClaims` with `crypto_mode`
- PR #1686 — `PgSDKLookup` reads `crypto_mode`
- PR #1687 — `mint_handler` propagates `crypto_mode`
- PR #1691 — `SDKContext` + `CryptoMode` enum (server-side)
- PR #1692 — append + batch dispatch
- PR #1694 — list + subscribe prelude
- PR #1695 — chat-sdk client plaintext mode
- PR #1696 — vitest integration tests
- PR #1698 — Rust E2E integration tests
- PR #1702 — dev→main merge (Phase 2)
- This PR — `batchAddMembers` + `deleteRoom` + marketplace primitive docs (1.2.0)

## [1.0.1] — 2026-05-18 — API consistency

`1.0.0` was published prematurely with a holistic code-quality review surfacing 3 frozen-API issues. Since `1.0.0` cannot be reused (npm tombstones versions), these fixes land as `1.0.1`. **No consumers were on `1.0.0`** — the version was effectively unused.

**Note on semver:** technically `BatchAppendItem` rename is breaking. Released as `1.0.1` patch because 1.0.0 had zero npm consumers. If you somehow installed `1.0.0` between 20:34 PDT and 1.0.1 publish — see Migration below.

### Changed (effectively breaking — see note above)

- `BatchAppendItem` fields renamed to camelCase: `msgId`, `sealed: ArrayBuffer | null`, `threadRootMsgId`, `productRef`, `productMeta`. Wire DTO conversion (base64 encoding, snake_case) now internal to `batchAppend()`. Was previously snake_case (Rust wire shape leaked into TS public API).
- `BatchAppendItemDTO` is now a fully internal type — not exported from `types.ts` or `index.ts`.

### Added

- `SendArgs.productRef?: string` — surface a product reference on a message (marketplace use case)
- `SendArgs.productMeta?: unknown` — opaque metadata associated with `productRef`
- Plumbed through `send()`, `sendText()`, `sendOptimistic()` (via `send()`), and `sendTextOptimistic()`. Matches `batchAppend()` and `MessageRow` capability.

### Not added

- `SendArgs.replyToMsgId` — server `AppendRequest` has no `reply_to_msg_id` field; only `thread_root_msg_id` which is already exposed as `threadRootMsgId`. Server-side work required before this can be added.

### Migration from 1.0.0

- `BatchAppendItem`: `{msg_id, sealed_b64, thread_root_msg_id, product_ref, product_meta}` → `{msgId, sealed (ArrayBuffer | null), threadRootMsgId, productRef, productMeta}`. Pass raw `ArrayBuffer` — no base64 encoding.
- `SendArgs.productRef` / `productMeta` are additive (existing call sites unaffected).

## [1.0.0] — 2026-05-18 (production release)

### Summary

First stable release. All v1.0 API surface is frozen. The `web/` mirror (`$lib/api/sdkChat.ts`)
has been deleted — all production code now imports directly from `@oxpulse/chat-sdk`.

### Added

- **`batchAppend(roomId, items)` method** — sends multiple pre-sealed messages in a single
  `POST /api/sdk/messages/batch` transaction. `room_id` is injected automatically; callers
  must pre-seal each `sealed_b64` field. Does NOT auto-seal (use `sendText` / `sendTextOptimistic`
  for auto-seal). Scope required: `chat:write:<room_id>`.
- **`BatchAppendItem` interface** — exported from the package root. Wire shape for one item in the
  batch endpoint: `{ msg_id, sealed_b64?, thread_root_msg_id?, product_ref?, product_meta? }`.
- **Subscribe reconnect tests** — `subscribe-reconnect.test.ts` covers reconnect-with-backoff and
  `list()`-replay behavior in the canonical SDK test suite (ported from mirror tests #7/#8).

### Changed

- **`web/src/lib/api/sdkChat.ts` deleted** — all `$lib/api/sdkChat` imports in the `web/`
  package have been switched to `@oxpulse/chat-sdk`. The mirror served as a staging area;
  any behavior that lives in production now has a canonical home in the SDK.
- Version bumped `0.7.0` → `1.0.0`.

## [0.7.0] — 2026-05-18 (review fixes)

### Breaking changes (within 0.7.0, pre-release)

- **`E2EEOptions` is now a discriminated union** — `provider: 'sframe'` shape now requires `getKey`
  (was optional before). `provider: CryptoProvider` shape no longer accepts `getKey`. TS will
  catch any misuse at compile time.
- **`E2EEOptions.onKeyRotation` removed** — it was declared but never wired to any provider
  callback. Re-added in a future version when sframe-ratchet rotation hooks are integrated.

### Fixed

- **M1 — Outbox bypass (CRITICAL):** Added `SDKChatClient.sendTextOptimistic()` that seals
  plaintext before enqueue, so the outbox never stores plaintext. `sendOptimistic()` emits a
  one-time `console.warn` when called with e2ee configured — callers should migrate to
  `sendTextOptimistic()`.
- **M2 — list() silent drop on unseal failure:** Failed rows are now preserved in `items` with
  `MessageRow.unsealError: 'replay' | 'auth' | 'unknown'` instead of being silently dropped.
  This keeps pagination counts accurate and surfaces tampered/replayed rows.
- **M3 — Global decrypt chain stall:** `subscribe()` now maintains a per-room decrypt chain
  (`Map<roomId, Promise>`) so a stuck unseal in one room does not stall other rooms. Added a
  5-second timeout per unseal; timed-out messages are delivered with `unsealError: 'unknown'`.
- **M4 — Missing @noble peerDeps:** Added `@noble/curves ^2.2.0` and `@noble/hashes ^2.2.0`
  to `dependencies` so consumers without these in their tree do not get `ERR_MODULE_NOT_FOUND`.
- **M5 — Caret on fresh 0.x dep:** `sframe-ratchet` pinned to exact `0.5.0` (was `^0.5.0`).
- **M7 — Dead `onKeyRotation` field:** Removed from `E2EEOptions` (see Breaking changes above).
- **MINOR — `.buffer` aliasing in `sframe.ts`:** `result.buffer` replaced with
  `result.slice().buffer` in both `seal` and `unseal` to avoid aliasing a pooled/shared
  `ArrayBuffer`.

### Added

- `MessageRow.unsealError?: 'replay' | 'auth' | 'unknown'` — populated on unseal failures.
- `SDKChatClient.sendTextOptimistic()` — E2EE-safe optimistic send (seals before enqueue).
- `ReplayError` re-exported from main index (from `sframe-ratchet/chat`) for consumer error
  inspection.

## [0.7.0] — 2026-05-18

### Added

- **SFrame E2EE provider** (`createSFrameProvider`) via `sframe-ratchet@0.5.0` chat-mode subpath.
  - New types: `CryptoProvider`, `E2EEOptions`, `SealContext` (all re-exported from main index).
  - `SDKChatClientOptions.e2ee` — optional E2EE config (discriminated union: sframe+getKey or custom CryptoProvider).
  - `SDKChatClient.sendText(roomId, {senderUid, text})` — encrypts UTF-8 text via provider and calls `send()`. Throws `SDKChatError('unsupported')` when `e2ee` is not configured.
  - `list()` auto-decrypts rows when `e2ee` is configured; failed unseal → row filtered + `console.warn`.
  - `subscribe()` auto-decrypts on `onMessage`; async decryptions serialised to preserve order.
  - `MessageRow.plaintext?: ArrayBuffer` — populated after successful unseal.

### Dependencies

- Added `sframe-ratchet@^0.5.0` (chat-mode additive subpath, published 2026-05-18).

### ⚠️ Key contract

`E2EEOptions.getKey` MUST return a `CryptoKey` with usages `['deriveKey','deriveBits']` (HKDF base-key), **not** AES-GCM. The library derives its own AES-128-GCM keys via HKDF internally.

### ⚠️ Threat model

No forward secrecy; no post-compromise security; symmetric AEAD (any room member can forge messages from any other member). Document loudly in production integrations. See design doc `docs/superpowers/plans/2026-05-18-sframe-ratchet-chat-api-v0.5.md § C`.

## [0.6.1] — 2026-05-18

### Fixed

- **Declare missing `thumbhash` dependency.** `@oxpulse/chat-sdk/thumbhash` subpath imports `thumbhash@^0.1.1` but the dep was not declared, breaking installs that didn't have it hoisted from a workspace. Now explicitly declared.

### Changed (internal)

- Web app (`web/src/lib/chat/attachments/thumb-hash.ts`) was a byte-identical duplicate; deleted. Consumers (`AttachmentBubble.svelte`, `AttachmentSlot.svelte`) now import from `@oxpulse/chat-sdk/thumbhash`. The 154-line unit test moved to `packages/chat-sdk/src/__tests__/thumbhash.test.ts` (canonical home).

## [0.6.0] — 2026-05-18

### Added

- `sendOptimistic(roomId, args)` — Sendbird-style callback handle (`onPending` / `onSucceeded` / `onFailed`).
  Message is enqueued to idb-keyval before the first network attempt, persisting across page reloads.
- `flushOutbox(roomId)` — retry all queued messages for a room (cold-start on reconnect).
- `outbox.ts` — `enqueue` / `dequeue` / `pending` helpers backed by idb-keyval (`outbox:<roomId>` key).
- `OptimisticHandle` type in `types.ts` with chaining methods and `done: Promise<{seq, msgId}>`.
- Retry policy: MAX_RETRIES (5) with exponential backoff on network errors; non-network errors (4xx) fail immediately.

### Dependencies

- New runtime dep: `idb-keyval@^6.2.1`.
- New dev dep: `fake-indexeddb@^6` (test environment).

## [0.4.1] — 2026-05-17

### Changed

- Bump `@oxpulse/wire-codec` peer range to `^0.3.0` (no behavioral change in
  chat-sdk; wire-codec 0.3.0 adds mesh-bundle API which chat-sdk does not consume).
  External `npm install @oxpulse/chat-sdk@0.4.0` was resolving `wire-codec@0.2.0`
  because the prior `^0.2.0` range did not satisfy 0.3.x.

## [0.5.0] — 2026-05-18

### Added

- `sendFile(roomId, blob, args)` — presign → PUT encrypted blob → send sealed reference in one call.
- `presignAttachment(client, args)` — standalone helper: POST `/api/sdk/attachments/presign`, returns `{ attachmentId, uploadUrl }`.
- `MAX_ATTACHMENT_BYTES` constant (50 MB) — client-side guard enforced before network calls.
- `SendFileArgs` type: `{ senderUid, sealed, mimeType?, sha256, thumbhashB64? }`.
- `AttachmentMeta`, `PresignBody`, `PresignResp` types re-exported from `types.ts`.
- `SDKChatClient.sendFile(roomId, blob, args)` — convenience method wrapping standalone `sendFile`.
- Public getters `client.baseUrl` and `client.jwt` for use by attachment helpers.
- Subpath exports: `@oxpulse/chat-sdk/thumbhash` + `@oxpulse/chat-sdk/attachments`.
- Server: `POST /api/sdk/attachments/presign` — issues HMAC-signed PUT URL (5 min TTL).
- Server: `PUT /api/sdk/attachments/{id}?t=<token>` — stores blob under `$OXPULSE_CHAT_UPLOADS_DIR/chat-sdk/<app_id>/<sha256[0..2]>/<sha256>.bin`.
- Server: `GET /api/sdk/attachments/{id}` — streams blob from disk (JWT-authenticated).
- Migration: `sdk_attachments` metadata table (PK: app_id + attachment_id).
- Prometheus counters: `sdk_attachment_presign_total`, `sdk_attachment_upload_total`, `sdk_attachment_download_total`.

### Storage

- Env var `OXPULSE_CHAT_UPLOADS_DIR` controls upload root (default: `/tmp/oxpulse-uploads` in dev).
  Production deployments must set this to a persistent path.

## [0.4.0] — 2026-05-16

### Added

- `sendReaction(roomId, msgId, type)` — add a reaction emoji (idempotent per user+emoji). Client validates 1-32 chars before network call.
- `removeReaction(roomId, msgId, type)` — remove own reaction. No-op if never added.
- `getReactions(roomId, msgId)` — fetch aggregated `{counts, users}` from `GET /api/sdk/messages/:room/:msg/reactions`.
- `subscribe({onReaction})` — receives `reaction_add`/`reaction_remove` events via existing mutation SSE channel.
- `ReactionEvent` interface: `{ appId, roomId, msgId, op, reaction, userId }`.
- `ReactionsResponse` interface: `{ counts: Record<string, number>, users: Record<string, string[]> }`.
- Server: `POST /api/sdk/messages/{room_id}/{msg_id}/reactions` — add reaction (idempotent, FK-checked).
- Server: `DELETE /api/sdk/messages/{room_id}/{msg_id}/reactions/{reaction}` — remove own reaction.
- Server: `GET /api/sdk/messages/{room_id}/{msg_id}/reactions` — aggregated counts + user lists.
- New event variants on `sdk_message_log_mutation` channel: `op: "reaction_add" | "reaction_remove"` with `{msg_id, user_id, reaction}`.
- Migration: `sdk_message_reactions` table with composite PK + FK → `sdk_message_log` ON DELETE CASCADE.

### Wire

- New event variant on `sdk_message_log_mutation`: `op: "reaction_add" | "reaction_remove"` with `{msg_id, user_id, reaction}`.

## [0.3.0] — 2026-05-16

### Added

- `updateMessage(roomId, msgId, {sealed})` — edit a message (only sender). Bumps `editCount`, sets `editedAt`.
- `deleteMessage(roomId, msgId)` — soft-delete (sender only). Sealed payload cleared, `deletedAt` set.
- `pinMessage(roomId, msgId)` / `unpinMessage(roomId, msgId)` / `listPins(roomId)` — message pinning.
- `MessageRow` gains `editedAt?: string`, `deletedAt?: string`, `editCount?: number` fields.
- `UpdateMessageArgs` interface: `{ sealed: ArrayBuffer }`.
- `PinnedMessage` interface: `{ appId, roomId, msgId, pinnedBy, pinnedAt }`.
- Server: `PATCH /api/sdk/messages/{room_id}/{msg_id}` — edit handler (RLS by sender_uid).
- Server: `DELETE /api/sdk/messages/{room_id}/{msg_id}` — soft-delete handler.
- Server: `POST /api/sdk/rooms/{room_id}/pins/{msg_id}` — pin handler.
- Server: `DELETE /api/sdk/rooms/{room_id}/pins/{msg_id}` — unpin handler.
- Server: `GET /api/sdk/rooms/{room_id}/pins` — list pins handler.
- `GET /api/sdk/messages?include_deleted=true` — opt-in to include soft-deleted tombstones.

## [0.2.0] — 2026-05-16

### Changed (BREAKING)

- **`list()` now returns `ListResult` instead of `MessageRow[]`.**
  Callers must access `result.items` for the message array.
  ```ts
  // Before (0.1.x):
  const rows: MessageRow[] = await client.list(roomId);
  // After (0.2.x):
  const { items, hasNext, next } = await client.list(roomId);
  ```
- Server GET `/api/sdk/messages` response changed from a bare JSON array to
  an envelope `{ items, has_more, next_cursor }`.

### Added

- `ListResult` interface: `{ items: MessageRow[], hasNext: boolean, next?: number }`.
- `ListArgs.beforeSeq` — reverse-paging cursor. Pass a previous `next` value
  as `beforeSeq` to load the preceding page of history.
- `before_seq` query parameter on GET `/api/sdk/messages` (Rust server).
- Rust server: `has_more` sentinel-row detection (limit+1 fetch, no COUNT query).
- Rust server: `next_cursor` = seq of oldest row in the page.

## [0.1.0] — 2026-05-16

### Added

- First public release on npm.
- `SDKChatClient` with `send`, `list`, `subscribe` over the OxPulse SDK HTTP API.
- Optional zstd compression (`'none'` | `'auto'` | `'dict'`) via `@oxpulse/wire-codec`.
- `SDKChatErrorCode` typed error surface for client-side error handling.
- CSP-safe by design: zero `eval` / `new Function` calls in the bundled SDK
  (verified by `csp-cleanliness.test.ts` CI gate).
- Optional `appId` field on `SDKChatClientOptions` for multi-tenant app
  namespace hints — server-side scope check is authoritative.
