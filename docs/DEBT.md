# DEBT.md — Tech Debt Registry

Tracks stuck migrations, unfinished cutovers, and strangler-fig entries.
Add a row when shipping a partial cutover; close when fully retired.

## Active entries

### D8 — `r:` SFU namespace prefix retirement (client-side)

**Status:** Active (strangler-fig, client-side retired, server-side pending)
**Added:** 2026-05-22
**Owner:** Anatoly Koptev
**Tracking:** `packages/url-contract/src/room-ns.ts`

**Context.** The SFU (Selective Forwarding Unit) room namespace used a `r:`
prefix on room segments to disambiguate SFU rooms from other keyspace
entries. This prefix is no longer needed client-side — typed group codes
(10-char, G-first letter + Luhn checksum) and opaque IDs (22-char
base64url) are structurally disjoint from SFU namespace keyspace by
construction.

**What was retired.** `packages/url-contract/src/room-ns.ts` —
`namespaceRoomSegment()` is now a no-op passthrough on the client side.
It accepts any room segment and returns it unmodified. The `r:` prefix is
never added client-side.

**What is NOT retired.** The server still accepts `r:`-prefixed segments
for backward compatibility with older clients that may still send them.
The server-side strip logic remains active.

**Sunset criterion.** The `prefixed_r` server metric
(`crates/signaling/src/room_state.rs`) must drain to zero sustained
(rolling 7-day window with zero observations) before the server-side
strip logic can be removed. Until then, `room-ns.ts` remains as the
documented seam — a no-op client-side, but the single authority for where
the prefix WOULD be added if it were still needed.

**Why the no-op is kept (not deleted).** Deleting `room-ns.ts` would
remove the documented boundary and make a future re-introduction of
client-side namespacing ad-hoc. Keeping the no-op with a sunset criterion
makes the strangler-fig explicit: the seam exists, it does nothing, and
it has a clear retirement condition.

**Resolution steps.**
1. Monitor `prefixed_r` metric until sustained zero (7-day window).
2. Remove server-side `r:` strip logic in `crates/signaling/src/room_state.rs`.
3. Delete `packages/url-contract/src/room-ns.ts` and its exports.
4. Move this entry to "Resolved" with date and PR reference.

## Resolved entries

_None yet._
