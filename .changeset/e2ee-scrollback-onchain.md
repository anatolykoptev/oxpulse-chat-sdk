---
"@oxpulse/chat-sdk": patch
---

fix(chat-sdk): SEC-CR-14-02 — route scrollback unseal through the per-room decrypt chain when a subscription exists

Closes the LAST off-chain unseal path of the concurrent-unseal class (same class as
#14, which serialized the streamed unseal, and #15/SEC-CR-14-01, which serialized the
reconnect/replay unseal). After this, the "at most one unseal in flight per room"
invariant holds categorically.

The public `list()` pagination / scrollback path (backward paging via `beforeSeq`, and
any `list()` of a room that also has a live subscription) unsealed rows directly via
`provider.unseal()` — OFF the per-room serial `#decryptChain`. A direct-SDK consumer
that `subscribe()`d a room AND `list()`d that same e2ee room's scrollback concurrently
ran two unseals at once on the room's SFrame ratchet → ratchet / replay-window desync,
the exact failure the chain exists to prevent.

Behavior change (why a bump): when a room has a live subscription (`#decryptChain`
refCount > 0), `list()`'s unseal for that fetch now serializes onto the room's decrypt
chain instead of running concurrently. Same items are returned, in the same server
order; the fetch may resolve slightly later because its unseal queues behind any
in-flight streamed / replay unseal. A `list()` for a room with NO live subscription is
unchanged — it still unseals directly off-chain (there is no chain entry to append to,
and no streamed unseal can race), so one-shot fetches still deliver every row.

No API, signature, or configuration change. Not widget-triggered (the widget never
paginates with `beforeSeq`); reachable on the SDK's public API surface by a direct-SDK
consumer or a sibling app's own api layer.
