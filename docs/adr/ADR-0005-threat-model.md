# ADR-0005 Threat Model — Room URL Contract

**Status:** Reference
**Date:** 2026-08-13
**Parent:** [ADR-0005: Heterogeneous room URLs](./ADR-0005-heterogeneous-room-urls.md)

## Purpose

Document the threat model for room URLs, the entropy budget for each
generator, and the collision bounds. This is the reference for security
reviewers and for anyone changing the generators or URL formats.

## Threat model

### Assets

1. **Room join capability** — the ability to join a room. For 1:1 calls
   and burner chats, this is the URL fragment (`#<secret>.<pubkey>` or
   `#k=<base64url>`). For group calls, it's server-side membership.
2. **Room ID** — the path component (`/<roomId>`, `/r/<roomId>`, etc.).
   This is NOT secret — it appears in server logs, HTTP referer, and
   partner-edge access logs. It is a routing identifier, not a capability.
3. **Short-link alias** — `/s/<alias>`. This IS a capability — the alias
   IS the join token for group rooms. 4-6 alphanumeric chars.

### Adversary capabilities

- **Network observer** (partner-edge Caddy, ISP, CDN): sees the full URL
  EXCEPT the fragment (RFC 3986 — fragment is never sent to the server).
  Can log paths, query params, timing.
- **Server operator**: sees room IDs, aliases, membership. Does NOT see
  fragments (client-only). Can mint short-link aliases.
- **Messenger link preview** (Telegram, WhatsApp, Signal): fetches the URL
  to generate a preview. Sees the path + query. May apply Markdown
  stripping to the full URL including the fragment — this is why
  `messengerSafeBase64Url16` avoids `-_`/`_-` adjacency.
- **Brute-force attacker**: can attempt to guess room IDs or short-link
  aliases. Bounded by entropy (see below) and server-side rate limiting
  (`crates/signaling/src/rate_limit.rs` — `JoinLimiter`).

### What the fragment protects against

The fragment (`#<secret>.<pubkey>` or `#k=<base64url>`) is the E2EE join
capability. It is never sent to the server, so:
- A network observer cannot join the room (no fragment).
- The server operator cannot join the room (no fragment).
- A messenger link preview bot cannot join the room (fragment not sent
  in the preview HTTP request).

### What the fragment does NOT protect against

- **Link forwarding** — anyone who receives the full URL (including
  fragment) can join. This is by design — the URL IS the capability.
- **Browser history / shoulder surfing** — the fragment appears in the
  URL bar. Users sharing screens should use a fragment-stripped URL.
- **Messenger Markdown stripping** — Telegram/WhatsApp/Signal may strip
  `_` sequences from URLs, corrupting base64url. `messengerSafeBase64Url16`
  mitigates this by avoiding `-_`/`_-` adjacency and leading/trailing
  `-`/`_`. This is a defense-in-depth measure, not a guarantee.

## Entropy budget

### `generateOpaqueRoomId()` / `messengerSafeBase64Url16()`

- **Source:** `crypto.getRandomValues` (CSPRNG)
- **Bytes:** 16 (128 bits)
- **Output:** 22-char base64url
- **Entropy:** 128 bits (minus ~4.13% rejection rate for messenger-safety,
  effectively 128 bits — the rejection is on encoding, not on entropy)
- **Collision probability:** Birthday bound — 2^64 IDs for 50% collision.
  At 1M IDs/day, 2^64 / 1M ≈ 1.8×10^13 days ≈ 50 billion years.
- **Brute-force:** 2^128 attempts. At 1M attempts/sec, 2^128 / 1M ≈
  5.4×10^24 seconds ≈ 1.7×10^17 years.

### `generateRoomCode('group')`

- **Source:** CSPRNG with rejection sampling
- **Output:** 10-char `G<3 letters>-<4 digits><checksum>`
- **Entropy:** 3 letters (21 usable: A-HJ-NP-Z, no I/O) + 4 digits = 
  21^3 × 10^4 = 9,261 × 10,000 = 92,610,000 ≈ 2^26.5
- **Collision probability:** Birthday bound — 2^13.25 codes for 50%.
  At 1000 group rooms/day, 2^13.25 / 1000 ≈ 9 days. **Group codes are NOT
  unguessable — they are typed codes for human sharing, not capability URLs.**
  The server enforces membership separately.
- **Brute-force:** 2^26.5 attempts. At 100 attempts/sec (rate-limited),
  2^26.5 / 100 ≈ 1.1M seconds ≈ 12.7 days. Rate limiting makes this
  infeasible.

### `generateShortLinkAlias()`

- **Source:** CSPRNG with rejection sampling
- **Output:** 4-6 alphanumeric chars (default 5)
- **Entropy (5-char default):** 62^5 = 916,132,832 ≈ 2^29.8
- **Collision probability:** Birthday bound — 2^14.9 aliases for 50%.
  At 1000 aliases/day, 2^14.9 / 1000 ≈ 58 days. **The server MUST check
  for collisions on mint** (`crates/server/src/short_links/mint.rs` does
  this — retry on collision).
- **Brute-force:** 2^29.8 attempts. At 100 attempts/sec (rate-limited),
  2^29.8 / 100 ≈ 9.6M seconds ≈ 111 days. Rate limiting makes this
  infeasible. The alias IS the capability — 30 bits is sufficient under
  rate limiting.

### `generateShortId()` (default 12 chars)

- **Source:** CSPRNG with rejection sampling
- **Output:** 12 alphanumeric chars
- **Entropy:** 62^12 ≈ 2^71.4
- **Collision probability:** Birthday bound — 2^35.7 IDs for 50%.
  Negligible for any reasonable usage.
- **Brute-force:** 2^71.4 attempts. Infeasible.

## Messenger-safety invariant

`messengerSafeBase64Url16()` guarantees:
1. No `-_` or `_-` adjacency (Telegram/WhatsApp/Signal Markdown stripping)
2. No leading `-` or `_` (some clients strip leading special chars)
3. No trailing `-` or `_` (some clients strip trailing special chars)

**Fail-closed:** If 8 consecutive draws are unsafe (≈8.5e-12 probability),
the function THROWS rather than returning an unsafe value. This is the
correct behavior — an unsafe URL would silently break when shared via
messenger, which is worse than a retryable error.

## References

- ADR-0005: [Heterogeneous room URLs](./ADR-0005-heterogeneous-room-urls.md)
- ADR-0002: URL fragment secrets (oxpulse-chat repo)
- `crates/signaling/src/rate_limit.rs` — `JoinLimiter` (brute-force defense)
- `crates/server/src/short_links/mint.rs` — collision check on alias mint
