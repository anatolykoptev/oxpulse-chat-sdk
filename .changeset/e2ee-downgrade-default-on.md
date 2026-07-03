---
"@oxpulse/chat-sdk": major
---

fix(chat-sdk): SEC-CR-001 — default-on E2EE downgrade defense, scoped per-room

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
many distinct rooms accumulates a small (~100 B) per-room entry until it is recreated.
