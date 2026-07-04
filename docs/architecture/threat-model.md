---
topic: reference
audience: agent-first
last_updated: 2026-07-03
status: live
related:
  - ./e2ee-model.md
  - ../quickstart.md
---

# oxpulse-chat-sdk — threat model (SDK-scoped)

> This is the `@oxpulse/chat-sdk` / `@oxpulse/wire-codec` / `@oxpulse/chat-widget`
> **narrow** threat model — the store-and-forward message path (HTTP POST +
> SSE subscribe against an app-server-controlled data store), not the
> WebRTC/SFU real-time media path.
>
> The full, tiered adversary model (passive network observer / nation-state
> active adversary / compromised partner-edge relay operator) lives in the
> parent `oxpulse-chat` repo:
> [`/home/krolik/src/oxpulse-chat/docs/strategy/THREAT-MODEL.md`](/home/krolik/src/oxpulse-chat/docs/strategy/THREAT-MODEL.md).
> Read that document first for the general framing (adversary tiers,
> capabilities, non-capabilities). This document does not repeat it — it
> adds only the SDK-specific framing that doc's Tier 1-3 model doesn't
> directly cover.

---

## Why the chat-sdk needs its own framing

The parent threat model's Tier 3 adversary is a **compromised partner-edge
relay operator** — a third party running TURN/SFU infrastructure that
forwards already-SRTP-encrypted real-time media it cannot read. That is not
the adversary this SDK's E2EE defends against.

`@oxpulse/chat-sdk` talks to an **application server** (`api.oxpulse.chat`,
or a self-hosted app backend embedding the SDK) over plain HTTP POST +
Server-Sent Events — a persistence and delivery layer, not a media relay.
The server here is not a third-party relay operator forwarding opaque
bytes; it is the first-party owner of the data store, the SSE stream, and
the wire protocol both sides speak. **The chat-sdk's threat model is: this
server itself may be malicious or compromised**, and E2EE is the SDK's
answer to that — not TLS (which the server terminates, and therefore
cannot defend against), not access control (which the server also
enforces).

This is the same threat class as the parent doc's general framing that
"operators forwarding only ciphertext" is the load-bearing privacy claim —
just applied to the message-store server instead of the media relay.

---

## What the SDK defends against a malicious/compromised server

| Server capability | SDK defense | Residual |
|---|---|---|
| Read message content | AEAD confidentiality (`sframe.ts`) | None — content is opaque ciphertext to the server by construction. |
| Forge a message | AEAD authenticity (`sframe.ts`) | None for forgery from an outsider. Sender deniability is explicitly NOT defended — see below. |
| Silently downgrade to plaintext (`crypto_mode: 'plaintext'`) | Default-on downgrade defense — poisons the room and fails closed instead of accepting the signal (`e2ee-model.md` §4) | None while `e2ee` is configured; a caller that never configures `e2ee` has no downgrade to defend (plaintext was the intended mode). |
| Replay an old, genuinely-authentic sealed frame under a fresh `msg_id` | `DurableReplayGuard`, cross-reload receiver-side replay window (`e2ee-model.md` §6) | Bounded 1024-CTR window per (room, sender) — a replay older than the last 1024 accepted frames for that sender can still pass. |
| Drop / withhold a message entirely | **None.** Availability is out of cryptographic scope for any store-and-forward system — a server can always choose not to deliver a row. | Full — this is a fundamental limit, not a gap to close. |
| Serve one room's downgrade/poison as a way to brick sibling rooms (DoS amplification) | Per-room poison scoping (`#poisonedRooms` keyed by `roomId`) (`e2ee-model.md` §5) | None for content paths; `#poisonedRooms` itself is unbounded for the client's lifetime (tracked, not fixed — see `e2ee-model.md` §5 and `reviews/crypto-security/22-6792eb1e-2026-07-03.md` Finding 2). |

## Why TLS does not help here

TLS 1.3 between the browser and `api.oxpulse.chat` secures the transport
against the parent doc's Tier 1/Tier 2 network-observer adversaries — it
prevents a passive or active network attacker from reading or tampering
with traffic in flight. It does **nothing** against the adversary this
document is about, because the server is the TLS session's own endpoint:
by the time a request or SSE frame is being constructed or interpreted,
TLS has already been terminated. This is stated directly in the SEC-CR-001
changeset motivating the downgrade defense: "TLS does not help, the server
is the endpoint" (`.changeset/e2ee-downgrade-default-on.md`).

## What this SDK's E2EE explicitly does not attempt

Per `sframe.ts`'s own header comment:

- **No forward secrecy** — compromise of the current key material can
  decrypt past messages sealed under it (bounded by `sframe-ratchet`'s
  ratchet advance for future messages, not past ones).
- **No post-compromise security** guarantee beyond what the ratchet
  provides.
- **No sender deniability** — the scheme uses a symmetric key shared by
  room members, so any room member can forge a message that appears to
  come from any other member. This is a property of the key-derivation
  scheme (HKDF-derived per-sender AES-128-GCM keys from one shared HKDF
  base key), not a bug.

See [`e2ee-model.md`](./e2ee-model.md) for how each defended property is
actually implemented (the decrypt-chain ordering, the downgrade/poison gate,
the durable replay guard, and the wire-codec type boundary).
