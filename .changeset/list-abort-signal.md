---
"@oxpulse/chat-sdk": minor
---

Add `ListArgs.signal` — an `AbortSignal` that reaches inside `list()`.

The signal is handed to the HTTP fetch and to the per-row unseal, and
`ListResult.next` carries it forward, so one signal cancels a whole paged walk.
On abort `list()` rejects with `signal.reason` as soon as the abort fires,
rather than after the page's remaining rows drain — previously a caller with a
hanging crypto provider waited out the decrypt chain's per-row force-drain for
every row on the page. A row whose unseal had not started is never handed to
`provider.unseal`, so no ratchet or replay state advances for a cancelled row;
a row already in flight has its provider signalled and, if that provider
ignores the signal, is force-drained in the background on the existing bound.
An abort during the fetch now surfaces as `AbortError` instead of being
rewrapped as `SDKChatError('network')`.

`exportRoom()` forwards its signal into `list()`, so an export is cancellable
during a page and not only between pages.

Corrects the `export.ts`, `ListArgs`/`ExportRoomOptions` and
`SDKChatClient#exportRoom` docstrings, which described an unbounded off-chain
unseal loop that had already been removed.
