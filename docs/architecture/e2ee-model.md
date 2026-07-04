---
topic: architecture
audience: agent-first
last_updated: 2026-07-03
status: live
related:
  - ./threat-model.md
  - ../quickstart.md
  - ../server-contract.md
---

# oxpulse-chat-sdk — E2EE architecture

> Internal design of `@oxpulse/chat-sdk`'s end-to-end encryption path: the
> per-room decrypt ordering, the downgrade/poison defenses, the durable
> replay guard, and the wire-codec type boundary that keeps two
> binary-incompatible protocols from being cross-fed. Distilled from code
> header comments, `.changeset/e2ee-*.md`, and the crypto-security /
> repo-council review reports so a future agent doesn't have to re-read the
> whole codebase to find these invariants again.

---

## 1. Threat model (SDK-scoped)

The chat-sdk's E2EE exists because **the server is the adversary** — the same
premise the SEC-CR-001 downgrade-defense changeset states directly:

> "A malicious or compromised app-server could make any consumer that
> enabled `e2ee` ... transmit cleartext the server reads — TLS does not help,
> the server is the endpoint."
> — `.changeset/e2ee-downgrade-default-on.md`

With `sframe-ratchet`'s AEAD in place (`packages/chat-sdk/src/sframe.ts`), the
server:

- **Cannot forge** a message (AEAD integrity/authenticity).
- **Cannot read** message content (AEAD confidentiality).
- **CAN downgrade** — emit `crypto_mode: 'plaintext'` to an e2ee-configured
  client and hope it silently complies (§4).
- **CAN replay** an old, genuinely-authentic sealed frame under a fresh
  `msg_id` (§6).
- **CAN drop / withhold** messages — availability is out of cryptographic
  scope for any store-and-forward system; nothing in AEAD stops a server
  from simply not delivering a row.

TLS secures the client↔server transport (network observers, MITM), but the
server *terminates* that TLS connection — it is the trusted transport
endpoint and the untrusted content adversary simultaneously. See
[`threat-model.md`](./threat-model.md) for the full framing and how this
relates to the parent repo's tiered adversary model.

`sframe.ts`'s own header is explicit about what this design does **not**
defend: forward secrecy, post-compromise security, or sender deniability
("symmetric key — any room member can forge messages from any other
member)". That is a property of the underlying `sframe-ratchet` key scheme,
not something the invariants below can fix.

---

## 2. Per-room serial decrypt chain (`RoomDecryptChain`)

`packages/chat-sdk/src/room-decrypt-chain.ts` — header comment states the
core reason this class exists:

> "A ratcheting AEAD (SFrame replay window / ratchet state) hard-fails or
> silently desyncs on out-of-order unseal, so every inbound decrypt for a
> room is appended onto that room's single promise chain and runs only
> after the prior link settles."

Mechanics:

- **One promise chain per room.** `RoomDecryptChain.append(roomId, task)`
  chains `task` onto `ChainEntry.chain` via `.then(...)`. Rooms are
  independent `Map` entries — a stuck unseal in room A never stalls room B.
  This is a **non-re-entrant serial queue**, not a mutex.
- **Subscriber refcount.** More than one `subscribe()` can share a `roomId`
  on one client (widget remount, visibility re-subscribe without awaiting
  teardown, reconnect race). `acquire()`/`release()` balance a shared
  refcount; the entry is removed only when the **last** subscriber releases.
  A prior version deleted the entry on ANY teardown — a surviving
  co-subscriber's next frame, or a same-room resubscribe, then started a
  FRESH chain from `Promise.resolve()` that ran **concurrently** with the
  orphaned chain's in-flight unseal, desyncing the ratchet. This was
  BUG #1 (HIGH) in the whole-repo audit
  (`~/deploy/krolik-server/reports/oxpulse-chat-sdk/reviews/repo-council/2026-07-02.md`).
- **Generation counter fixes the deferred-delete race.** `release()` doesn't
  delete synchronously at refcount 0 — it schedules a delete that fires only
  after the captured chain tail (`draining`) settles, so an in-flight unseal
  isn't orphaned mid-flight. But a *second* release-to-zero's shorter tail
  could resolve while a *later* release's newer work is still queued, so
  `ChainEntry.generation` is bumped on every `acquire()`/`append()`; the
  deferred delete only fires if `current.generation === generationAtRelease`
  — any activity after a release cancels its own stale delete.

---

## 3. The "one unseal in flight per room" invariant

Named directly in `room-decrypt-chain.ts`'s header:

> "Guarantee: at most ONE unseal task per room is in flight at any time,
> across every subscribe / teardown / resubscribe / reconnect-replay
> interleaving — the property a ratcheting AEAD needs."

This holds across **all three** inbound-frame producers, unified onto the
same chain:

1. **Streamed (live SSE)** — `subscribe()`'s `onmessage` handler appends via
   `#appendDecryptTask`.
2. **Reconnect-replay** (missed rows fetched on SSE error / graceful
   shutdown) — `replayMissed`, routed onto the chain per SEC-CR-14-01.
3. **Scrollback** (`list()` when the room has a live subscription) —
   `SDKChatClient#unsealRowsOnChain`, routed onto the chain per SEC-CR-14-02
   (`.changeset/e2ee-scrollback-onchain.md`).

A `list()` call for a room with **no** live subscription still unseals
directly, off-chain — there is no chain entry to append to and no streamed
unseal can race it, so a one-shot fetch still delivers every row (and has no
timeout, unlike the on-chain path's 5s-per-row bound).

**Residual — now closed for the concurrent-unseal class
(`fix/e2ee-unseal-cancel`, `.changeset/e2ee-unseal-cancel.md`).** The 5s per-row
deadline WAS a `Promise.race` that **abandoned** (did not cancel) a slow unseal:
the abandoned call kept running detached while the task settled as an
`unsealError` and the chain started the next unseal, so two unseals COULD be in
flight for a >5s row. That is fixed. `#appendDecryptTask` now fires an
`AbortController` at the deadline — passed through the new **optional**
`CryptoProvider.unseal(sealed, ctx, signal?)` parameter — AND **awaits the
unseal's real settle** (it no longer races the timeout and abandons the loser).
The chain therefore never advances to the next unseal until the current one has
actually settled: **at most one unseal is in flight per room, categorically**,
across all three producers (streamed / reconnect-replay / scrollback), which all
funnel through the single `#appendDecryptTask`.

**Honest claim scope (what the `AbortSignal` does and does NOT do).** The built-in
sframe / WebCrypto provider's decrypt bottoms out at `crypto.subtle.decrypt`
(AES-GCM), which takes **no** `AbortSignal` and is **atomic — it cannot be
cancelled mid-flight**. So for the built-in provider the signal is advisory: the
provider honors it only at its `await` boundaries (before the decrypt, see
`sframe.ts` `throwIfAborted`), and the one-in-flight guarantee holds not because
the decrypt is cancelled but because the chain *awaits the real settle* and that
decrypt is sub-millisecond for chat payloads. A **cancel-capable** provider (a
future worker / streaming / KMS-with-abort backend) gets a genuine prompt cancel.
The `signal?` parameter is **optional and backward-compatible** — a custom
`CryptoProvider` that ignores it (or predates it, a 2-arg `unseal`) still
typechecks and works, just non-cancelling.

**The new, narrower residual (a deliberate trade-off).** Because the chain now
awaits the real settle, a provider that **both** ignores the `AbortSignal` **and**
hangs forever will stall **that one room's** decrypt chain (and defer its
`RoomDecryptChain` entry cleanup) — a *stalled room*, not a concurrent unseal or a
double-delivery. It is contained per-room (rooms are independent — a stall in room
A never touches room B) and **observable**: `#appendDecryptTask` emits a distinct
`deadline` `console.warn` when the 5s bound is crossed. The built-in providers
never trigger it (sub-ms decrypt, fast durable steps). The trade is intentional: a
genuinely-one-in-flight room that can occasionally stall is safer than a room that
silently runs two unseals against a ratcheting AEAD. A **late-but-successful**
unseal (a non-cancelling provider that finishes *after* the deadline) delivers its
**real plaintext in order** — never re-delivered, never discarded. The **off-chain**
`list()` path (a room with no live subscription) is unchanged: it has no chain to
violate and, by design, no deadline.

---

## 4. `crypto_mode` downgrade defense

`packages/chat-sdk/src/client.ts` — `validateAndResolveCryptoMode` +
`SDKChatClient` constructor.

- **Default-ON, not opt-in.** When an `e2ee` provider is configured, `
  #cryptoMode` defaults to `'sframe-static'` (never `null`):
  `this.#cryptoMode = opts.cryptoMode ?? (hasE2ee ? 'sframe-static' : null)`.
  Without an e2ee provider, `plaintext` remains a valid auto-detected mode
  (no behavior change for non-e2ee consumers).
- **Anchored on an immutable field.** `#cryptoMode` (the *configured*
  expectation) is `readonly`, set once at construct, and stays
  **client-level**. The *discovered* per-room mode
  (`#activeCryptoModeByRoom`) is a separate, evictable cache
  (`#boundActiveCryptoModeMap`, SEC-CR-17-01) — bounding or evicting that
  cache can never weaken the configured expectation, because
  `validateAndResolveCryptoMode` always re-validates a fresh server signal
  against `#cryptoMode`, not against the cache.
- **A server downgrade becomes a poison-mismatch, not an accepted
  downgrade.** If the client is configured `sframe-static` and the server
  emits `crypto_mode: 'plaintext'` (or any value other than the configured
  one, or an unrecognized value), `validateAndResolveCryptoMode` throws
  `crypto_mode_mismatch` instead of silently adopting the server's value.
- **Poison-before-throw.** `onPoison()` runs BEFORE the throw
  (SEC-CR-1695-02) — the room is marked poisoned even if a caller's
  try/catch swallows the exception, so no subsequent send can slip through
  on that room.
- **Contradictory config fails closed at construct.** `e2ee` configured
  together with `cryptoMode: 'plaintext'` throws `invalid_args` at
  construct time — the SDK refuses to build a client whose config already
  contradicts itself, rather than honoring what would otherwise be a silent
  opt-out.

Standards this is grounded in (per the crypto-security reviews):
**RFC 8446 §4.1.3** (TLS 1.3 downgrade protection — the analogous principle
that the client's own policy view must be authoritative over a
server-supplied signal), **OWASP ASVS v5 V11** (cryptography verification
requirements), **CWE-757** (protocol downgrade — the vulnerability class
SEC-CR-001 closed).

---

## 5. Poison-gate / fail-closed class

`SDKChatClient#assertRoomNotPoisoned` (`client.ts`) documents its own gate
class directly in its doc-comment — read it there for the authoritative
list. Summary:

- **Gate class = message-content reads/writes** (anything carrying or
  returning `sealed_b64`, whose interpretation `crypto_mode` governs):
  `send` / `sendText` / `sendFile` / `updateMessage` / `batchAppend` /
  `sendProductCard` / `#fetchRows` (used by `list()`) / `subscribe` /
  `getThread`. A proven downgrade fails all of these closed.
- **Exempt tier = interaction-metadata**, cleartext by wire contract and
  NOT governed by `crypto_mode`: `sendReaction` / `removeReaction` /
  `sendTyping` / `sendPresence` / `markRead` / `pinMessage` /
  `unpinMessage` / `listPins`. A poisoned room's sealed content is refused;
  its cleartext metadata channel is not message content and is intentionally
  left reachable.
- **Per-room isolation.** `#poisonedRooms` is a `Set<string>` keyed by
  `roomId` — one room's downgrade/mismatch poisons only that room. This is a
  DoS-amplification defense: the pre-fix design used a single client-wide
  boolean, so the FIRST legitimately-plaintext room bricked EVERY sibling
  room on the same `SDKChatClient` — the exact defect that gated PR #16
  BLOCKED in `pr-council/pr-16-2026-07-01.md` before the per-room scoping
  fix landed (independently re-verified in
  `reviews/crypto-security/16-30c9a0d1-2026-07-03.md`, findings (a)-(d)).
- **Recovery contract.** `#assertRoomNotPoisoned`'s thrown error says it
  outright: "recreate the client instance to retry this room" — there is no
  in-process un-poison path by design.
- **Documented residual: cross-room `searchByProductRef`.** The gate is
  applied only `if (opts?.roomId)` — the cross-room variant (no `roomId`)
  is not filtered per-row against `#poisonedRooms`. Today this is inert:
  the server rejects cross-room product-ref search with a 400 (cross-room
  search needs a `platform:search:*` scope that hasn't shipped), so no rows
  ever reach this gap. If cross-room search ships later, this needs a
  per-row `#poisonedRooms` filter — see the inline comment on
  `searchByProductRef` and `reviews/crypto-security/22-6792eb1e-2026-07-03.md`
  Finding 1 (rated LOW: even without the filter, a tampered/poisoned row
  still fails AEAD on the caller's own unseal — a completeness gap, not a
  plaintext leak).

---

## 6. `DurableReplayGuard`

`packages/chat-sdk/src/sframe-replay.ts` — header comment states the "why"
directly (SEC-CR-003, CWE-294):

> "sframe-ratchet's receiver-side replay window is an in-memory bounded Set
> that is WIPED on page reload ... a malicious/compromised app-server can
> re-serve an OLD authentic sealed frame under a fresh msg_id and it
> verifies (the ciphertext is genuinely authentic, just old)."

- **Durable persistence via IndexedDB** (`idb-keyval`, the same store the
  outbox uses), keyed per `(namespace, roomId, senderUid)`. The CTR is read
  from the RFC 9605 §4.3 header — which is the AEAD AAD, hence authenticated
  — via the library's own `parseHeader`.
- **Cross-tab Web-Locks read-merge-write.** `persistMerged()` always runs
  under `navigator.locks.request(..., { mode: 'exclusive' }, write)` — a
  second tab's accepted CTRs are unioned in (`dedupKeepLast`), not
  clobbered by a "last tab wins" write.
- **Gated OFF entirely when Web Locks is absent (CR17-02).** `available`
  requires BOTH `idbAvailable()` AND `locksAvailable()` (probing
  `navigator.locks.request` is actually callable, not just truthy). Without
  Web Locks the unlocked read-merge-write could silently drop a CTR on a
  legacy engine (Safari <15.4) — instead the guard degrades to a no-op
  (one-time `console.warn`), falling back to the library's session-scoped
  in-memory window. "No durable claim without Web Locks" is the deliberate,
  honest posture over a silently-droppable window.
- **Advance-window-only-after-successful-unseal.** `sframe.ts`'s `unseal()`
  calls `durable.accept(...)` only AFTER `inner.unseal()` succeeds (AEAD
  verified) — a forged frame with a novel CTR can never poison the durable
  window, because `accept()` is unreachable on an AEAD failure.
- **Documented residual: bounded-window eviction.** The durable window
  tracks the 1024 most-recent CTRs per (room, sender); a replay of a frame
  whose CTR has since been evicted by ≥1024 later accepts can still pass.
  Deliberately NOT closed with a monotonic high-watermark: the receiver
  cannot know a REMOTE sender's CTR strategy from the frame alone, so
  assuming monotonicity would false-reject every legitimate message from a
  `random-64` peer in a mixed-strategy room. See
  `.changeset/e2ee-durable-antireplay.md` for the full residual writeup.

---

## 7. wire-codec brand split as a security boundary

`packages/wire-codec/src/brands.ts` defines three phantom brands (a
`unique symbol`, zero runtime cost — `tsc` strips the annotation):

- **`WireBytes`** — peer protocol: CBOR + 1-byte dict-id. Produced by
  `encode()`, consumed by `decode()`.
- **`HttpWireBytes`** — SDK-HTTP protocol: JSON + u16-BE dict-id. Produced
  by `encodeHttpBody()`, consumed by `decodeHttpBody()`.
- **`SealedBytes`** — post-AEAD-seal, on the network.

**Why the split exists:** both protocols shared the SAME `0xC7` magic byte
and, before this fix, the SAME `WireBytes` brand — nothing at compile time
stopped feeding one protocol's output into the other's decoder. The
repo-council audit flagged this as BUG #2 (LOW, latent, not live-reachable
in this repo — `chat-sdk/client.ts` always pairs `decodeHttpBody()` with
`encodeHttpBody()` — but a real footgun for an external npm consumer or a
future internal refactor). The fix
(`.changeset/wire-codec-http-wire-bytes-brand.md`) retypes
`encodeHttpBody`/`decodeHttpBody` onto the new `HttpWireBytes` brand, so a
cross-feed is now a **compile error**, not a silent misparse.

**The general compress-then-seal design.** `brands.ts`'s own comment states
the intended pipeline: `WireBytes` is "compressed (cbor+zstd), **not yet
sealed**"; `SealedBytes` is "post-AEAD-seal, on the network." A relay/server
that only ever sees `SealedBytes` is architecturally blind to the
compression underneath — dict choice, ratio, scheme — because all of it is
inside the ciphertext.

**Nuance for chat-sdk's own HTTP send path** (don't over-generalize this):
`SDKChatClient#sendText`/`#send` actually **seal the plaintext content
first** — `#cryptoProvider.seal(plainBytes, ctx)` — then wrap the resulting
`sealed_b64` into a JSON envelope that `#encodeBody`/`encodeHttpBody`
compresses as `HttpWireBytes`. So for this specific SDK-HTTP flow, what gets
compressed is the **envelope** (small metadata fields plus an
already-opaque `sealed_b64` blob), not raw plaintext-before-seal. Both
orderings converge on the same end property the server needs to see
(nothing plaintext ever reaches it) — they are just two different pipeline
shapes for the two protocols this package serves, kept apart precisely by
the brand split above.

---

## 8. Invariants checklist

The load-bearing properties a future change to this subsystem must
preserve:

- [ ] **Serial decrypt order per room.** No two unseal calls for the same
  room run concurrently for any producer (streamed / reconnect-replay /
  scrollback) unless the room has no live subscription at all
  (`RoomDecryptChain`, §2-§3).
- [ ] **Refcounted chain lifecycle.** A chain entry is deleted only at
  refcount 0 AND after its chain drains, guarded by the generation counter
  — never delete synchronously on teardown (§2).
- [ ] **`#cryptoMode` (configured expectation) is set once, at construct,
  and never mutated** — only the per-room discovered-mode cache is
  evictable (§4).
- [ ] **A server-signaled downgrade always poisons before it throws**
  (`onPoison()` runs before `throw`) — never let an exception path leave a
  room un-poisoned (§4-§5).
- [ ] **`#poisonedRooms` is per-room, never a client-wide flag** — a
  downgrade in one room must never brick a sibling room (§5).
- [ ] **The poison gate covers every message-content read/write path**;
  the interaction-metadata tier stays intentionally exempt — don't gate
  reactions/typing/presence/markRead/pins, and don't forget to gate a NEW
  content-carrying method (§5).
- [ ] **`DurableReplayGuard.accept()` is called only after a successful
  AEAD unseal** — never record a CTR before verification (§6).
- [ ] **Durable replay persistence requires both IndexedDB AND Web Locks**
  — never run the cross-tab read-merge-write unlocked (§6).
- [ ] **Never let `WireBytes`, `HttpWireBytes`, and `SealedBytes` collapse
  onto one brand** — the type split is the whole point; don't add an
  `as` cast that silently bridges them (§7).
