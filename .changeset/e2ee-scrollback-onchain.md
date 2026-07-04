---
"@oxpulse/chat-sdk": patch
---

fix(chat-sdk): SEC-CR-14-02 — route scrollback unseal through the per-room decrypt chain when a subscription exists

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
