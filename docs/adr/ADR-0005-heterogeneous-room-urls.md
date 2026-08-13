# ADR-0005: Heterogeneous room URLs

**Status:** Accepted
**Date:** 2026-05-22
**Deciders:** Anatoly Koptev

## Context

oxpulse-chat supports multiple room types with different persistence,
access, and sharing semantics:

- **1:1 calls** — ephemeral, bare-root URL (`/<roomId>`), fragment-carried
  join secret + host pubkey (`#<secret>.<pubkey>`).
- **Group calls** — server-side membership, `/r/<roomId>` path, no fragment
  secret.
- **Burner chats** — sealed ephemeral, `/c/<roomId>` path, fragment-carried
  key (`#k=<base64url>`).
- **Sealed 1:1 chats** — server-side key exchange, `/m/<roomId>` path.
- **Short links** — `/s/<alias>` redirect to any of the above.

Room IDs come in two forms:
- **Typed group codes**: 10-char `G<letters>-<digits><checksum>`,
  Luhn-checksummed, G-first letter.
- **Opaque IDs**: 22-char base64url (128-bit CSPRNG), messenger-safe
  (no `-_`/`_-` adjacency, no leading/trailing `-`/`_`).

## Decision

The `@oxpulse/url-contract` package is the single authority for:

1. **Generators** — `generateRoomCode(kind)`, `generateOpaqueRoomId()`,
   `generateShortId()`, `generateShortLinkAlias()`.
2. **Parsers** — `parseRoomCode(code)` → `{ roomId, kind }`.
3. **Brands** — `RoomId`, `ShortId`, `ShortLinkAlias` branded newtypes.
4. **Checksums** — Luhn-based group code checksum.
5. **URL helpers** — `buildCall1to1Url()`, `buildGroupCallUrl()`,
   `buildBurnerChatUrl()`, `buildSealedChatUrl()`, `buildShortLinkUrl()`,
   `parseRoomUrl()`, fragment parsers.

All entropy comes from `crypto.getRandomValues` (CSPRNG) with rejection
sampling to avoid modulo bias.

## URL shapes

| Room type    | Path              | Fragment                  | Query       |
|--------------|-------------------|---------------------------|-------------|
| 1:1 call     | `/<roomId>`       | `#<secret>.<pubkey>`      | `?audio=1`  |
| Group call   | `/r/<roomId>`     | —                         | —           |
| Burner chat  | `/c/<roomId>`     | `#k=<base64url>`          | —           |
| Sealed 1:1   | `/m/<roomId>`     | —                         | —           |
| Short link   | `/s/<alias>`      | —                         | —           |

## Query vs fragment contract (ADR-0002)

Query params are **server-visible** (logged by partner-edge, in HTTP referer).
Only non-sensitive flags (`audioOnly`) go in the query.

Fragment is **client-only** per RFC 3986 — E2EE secrets go here and nowhere
else. See `docs/adr/0002-url-fragment-secrets.md` (oxpulse-chat repo).

## Consequences

- Room ID shapes are validated at the brand boundary (`asRoomId`,
  `tryAsRoomId`), preventing invalid IDs from reaching downstream code.
- Group codes carry a Luhn checksum for typo detection.
- Opaque IDs are messenger-safe — no `-_`/`_-` adjacency that Telegram/
  WhatsApp/Signal Markdown-stripping would corrupt.
- `messengerSafeBase64Url16` is fail-closed: throws after 8 unsafe draws
  (≈8.5e-12 probability) rather than silently returning an unsafe value.

## References

- Plan: `docs/superpowers/plans/2026-05-22-url-contract-extract-plan.md`
  (not yet created in this repo — tracked in #322)
- ADR-0002: `docs/adr/0002-url-fragment-secrets.md` (oxpulse-chat repo)
- DEBT D8: `docs/DEBT.md` — `r:` SFU namespace prefix retirement
