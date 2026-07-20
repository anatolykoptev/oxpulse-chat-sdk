# @oxpulse/url-contract

Heterogeneous room URL contract for oxpulse-chat (ADR-0005).

Owns: generators, parsers, brand types, constants for the room-URL
surface used across web/, packages/identity/, packages/chat-widget/,
and future SDKs.

Layered structure (no internal cycles):

```
src/
  constants.ts    # alphabets, lengths, thresholds (no deps)
  brands.ts       # RoomId, ShortId, ShortLinkAlias branded types
  checksum.ts     # Luhn mod-34 codec
  parse.ts        # parseRoomCode + RoomKind + RealKind
  generators.ts   # generateRoomCode + generateOpaqueRoomId
  index.ts        # public re-exports
```

Plan: `docs/superpowers/plans/2026-05-22-url-contract-extract-plan.md`.
ADR: `docs/adr/0005-heterogeneous-room-urls.md`.

## Public surface (flat exports — ADR-003)

All exports are flat from the package root (`@oxpulse/url-contract`);
there are no sub-path exports. See `src/index.ts` for the full re-export
list (constants, brands, checksum, parse, generators, room-ns).

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
