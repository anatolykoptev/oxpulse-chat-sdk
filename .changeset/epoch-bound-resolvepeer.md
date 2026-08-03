---
"@oxpulse/wire-codec": minor
---

Add epoch binding to DecodeOpts.resolvePeer — crypto-critical UKS fix

DecodeOpts gains an `epoch?: number` field. `resolvePeer` signature
changed from `(peerIndex) => string | undefined` to
`(epoch, peerIndex) => string | undefined`. The SDK threads `epoch`
from DecodeOpts to `resolvePeer`, ensuring the peer-index is resolved
against the correct epoch's peer_index_map — not the current one.

This prevents a cross-epoch sender misattribution (UKS) attack: a
delayed frame from epoch N was previously resolved against the current
epoch N+1's map, potentially attributing Alice's message to Charlie.
See RFC 9420 §4.1.1: each epoch has a distinct ratchet tree, and the
sender's leaf index is bound to that epoch's tree.

If `epoch` is missing in DecodeOpts, v3 frames get `from=undefined`
(safe drop) — the SDK refuses to call resolvePeer without an epoch.
Pre-v3 frames (JSON/CBOR/0xC6/0xC7/0xC8) ignore both `epoch` and
`resolvePeer` entirely.

Migration: callers using `resolvePeer` must add `epoch` to their
DecodeOpts, passing the AEAD-authenticated epoch from the SFrame header.
