---
"@oxpulse/chat-sdk": patch
---

Fix concurrent off-chain vs on-chain unseal (F7, #185)

ALWAYS route fetched-row unseal through the room's serial #decryptChain,
even when there is no live subscription (refCount 0). When refCount === 0,
temporarily acquire the chain entry so append() doesn't no-op, then release
after the page drains. Closes both residual concurrency windows:

1. A subscription appearing AFTER a refCount-0 list() dispatch — its first
   streamed unseal now queues behind the in-flight fetch unseal.
2. A list() during release()'s deferred-delete drain window — now appends
   behind the draining unseal instead of running off-chain concurrently.

Also removes the timeout asymmetry: the off-chain path previously awaited
provider.unseal with NO bound (could hang indefinitely on a stuck row). Now
ALL fetched-row unseals inherit #appendDecryptTask's abort-deadline +
force-drain bound.
