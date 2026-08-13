# @oxpulse/url-contract

Heterogeneous room URL contract for oxpulse-chat (ADR-0005).

Owns: generators, parsers, brand types, URL builders, and checksums for the
room-URL surface used across `web/`, `packages/chat-sdk/`, `packages/chat-widget/`,
and future SDKs.

## Install

```bash
npm install @oxpulse/url-contract
# or
pnpm add @oxpulse/url-contract
```

## Quickstart

```typescript
import {
  // Generators
  generateRoomCode,
  generateOpaqueRoomId,
  generateShortId,
  generateShortLinkAlias,
  // Parsers
  parseRoomCode,
  // Brands
  asRoomId,
  asShortLinkAlias,
  // URL builders
  buildCall1to1Url,
  buildGroupCallUrl,
  buildBurnerChatUrl,
  buildSealedChatUrl,
  buildShortLinkUrl,
  // URL parser
  parseRoomUrl,
  // Fragment helpers
  buildRoomFragment,
  parseRoomFragment,
} from '@oxpulse/url-contract';

// Generate a group room code (10-char, G-first, Luhn checksummed)
const groupCode = generateRoomCode('group'); // e.g. "GHJK-1234T"

// Generate an opaque room ID (22-char base64url, messenger-safe)
const opaqueId = generateOpaqueRoomId(); // e.g. "aBcDeFgHiJkLmNoPqRsTuV"

// Build a 1:1 call share URL with E2EE join secret in the fragment
const callUrl = buildCall1to1Url('https://app.oxpulse.chat', asRoomId(opaqueId), {
  fragment: { joinSecret: 'secretB64', expectedHostPubkey: 'pubkeyHex' },
  query: { audioOnly: true },
});
// → "https://app.oxpulse.chat/aBcDeFgHiJkLmNoPqRsTuV?audio=1#secretB64.pubkeyHex"

// Build a group call share URL
const groupUrl = buildGroupCallUrl('https://app.oxpulse.chat', asRoomId(groupCode));
// → "https://app.oxpulse.chat/r/GHJK-1234T"

// Build a burner chat URL with fragment-carried key
const burnerUrl = buildBurnerChatUrl('https://app.oxpulse.chat', asRoomId(opaqueId), 'keyB64');
// → "https://app.oxpulse.chat/c/aBcDeFgHiJkLmNoPqRsTuV#k=keyB64"

// Parse a room URL back to components
const parsed = parseRoomUrl(callUrl);
// → { roomId: "...", kind: "opaque", routePrefix: "", callFragment: { ... }, query: { audioOnly: true } }

// Generate a short-link alias (4-6 alphanumeric chars)
const alias = generateShortLinkAlias(); // e.g. "xA3kP"
const shortUrl = buildShortLinkUrl('https://app.oxpulse.chat', alias);
// → "https://app.oxpulse.chat/s/xA3kP"
```

## URL shapes

| Room type    | Path              | Fragment                  | Query       |
|--------------|-------------------|---------------------------|-------------|
| 1:1 call     | `/<roomId>`       | `#<secret>.<pubkey>`      | `?audio=1`  |
| Group call   | `/r/<roomId>`     | —                         | —           |
| Burner chat  | `/c/<roomId>`     | `#k=<base64url>`          | —           |
| Sealed 1:1   | `/m/<roomId>`     | —                         | —           |
| Short link   | `/s/<alias>`      | —                         | —           |

**Query vs fragment contract (ADR-0002):** Query params are server-visible
(logged by partner-edge, in HTTP referer). Only non-sensitive flags go in the
query. The fragment is client-only per RFC 3986 — E2EE secrets go here and
nowhere else.

## API reference

### Generators

| Function                    | Returns         | Description                                        |
|-----------------------------|-----------------|----------------------------------------------------|
| `generateRoomCode(kind)`    | `string`        | Typed 10-char group code or 22-char opaque ID      |
| `generateOpaqueRoomId()`    | `string`        | 22-char base64url (128-bit CSPRNG, messenger-safe) |
| `generateShortId(len?)`     | `ShortId`       | CSPRNG alphanumeric (default 12 chars, min 4)      |
| `generateShortLinkAlias(l?)`| `ShortLinkAlias`| CSPRNG alphanumeric (4-6 chars, default 5)         |
| `messengerSafeBase64Url16()`| `string`        | 16-byte messenger-safe base64url (fail-closed)     |

### Parsers

| Function              | Returns                              | Description                          |
|-----------------------|--------------------------------------|--------------------------------------|
| `parseRoomCode(code)` | `{ roomId, kind } \| null`           | Parse + validate a room code         |
| `parseRoomUrl(url)`   | `ParsedRoomUrl \| null`              | Parse a full room URL                |
| `parseCallFragment(f)`| `{ joinSecret, expectedHostPubkey } \| null` | Parse `#secret.pubkey` fragment |
| `parseBurnerFragment(f)` | `{ fragB64 } \| null`             | Parse `#k=<base64url>` fragment      |
| `parseRoomFragment(f)`| `{ secret, hostPubkey } \| null`     | Parse `<secret>.<pubkey>` fragment   |

### URL builders

| Function                    | Returns   | Description                          |
|-----------------------------|-----------|--------------------------------------|
| `buildCall1to1Url(o, r, opts)` | `string` | 1:1 call URL with optional fragment |
| `buildGroupCallUrl(o, r)`    | `string`  | Group call URL (`/r/<roomId>`)       |
| `buildBurnerChatUrl(o, r, k)`| `string`  | Burner chat URL (`/c/<roomId>#k=`)   |
| `buildSealedChatUrl(o, r)`   | `string`  | Sealed 1:1 chat URL (`/m/<roomId>`)  |
| `buildShortLinkUrl(o, a)`    | `string`  | Short-link URL (`/s/<alias>`)        |
| `buildRoomFragment(s, p)`    | `string`  | `<secret>.<pubkey>` fragment string  |

### Brands

| Function              | Returns              | Description                          |
|-----------------------|----------------------|--------------------------------------|
| `asRoomId(s)`         | `RoomId`             | Brand + validate (throws on invalid) |
| `tryAsRoomId(s)`      | `RoomId \| null`     | Brand + validate (null on invalid)   |
| `asShortId(s)`        | `ShortId`            | Brand + validate                     |
| `tryAsShortId(s)`     | `ShortId \| null`    | Brand + validate                     |
| `asShortLinkAlias(s)` | `ShortLinkAlias`     | Brand + validate                     |
| `tryAsShortLinkAlias(s)` | `ShortLinkAlias \| null` | Brand + validate               |

### Checksum

| Function              | Returns   | Description                          |
|-----------------------|-----------|--------------------------------------|
| `appendChecksum(id)`  | `RoomId`  | Append Luhn checksum char to 9-char  |
| `verifyChecksum(id)`  | `boolean` | Verify Luhn checksum on 10-char code |
| `stripChecksum(id)`   | `string`  | Strip checksum char from 10-char     |

## Layered structure (no internal cycles)

```
src/
  constants.ts    # alphabets, lengths, thresholds (no deps)
  brands.ts       # RoomId, ShortId, ShortLinkAlias branded types
  checksum.ts     # Luhn mod-34 codec
  parse.ts        # parseRoomCode + RoomKind + RealKind
  generators.ts   # generateRoomCode + generateOpaqueRoomId + ShortId/ShortLinkAlias
  url.ts          # URL builders + parsers (buildCall1to1Url, parseRoomUrl, etc.)
  room-ns.ts      # SFU namespace seam (no-op, D8 sunset pending)
  index.ts        # public re-exports
```

## Public surface (flat exports — ADR-003)

All exports are flat from the package root (`@oxpulse/url-contract`);
there are no sub-path exports. See `src/index.ts` for the full re-export
list (constants, brands, checksum, parse, generators, url, room-ns).

## Tree-shaking

`sideEffects: false` in `package.json` — safe to tree-shake. Only the
functions you import end up in your bundle.

## Documentation

- [ADR-0005: Heterogeneous room URLs](../../docs/adr/ADR-0005-heterogeneous-room-urls.md)
- [DEBT.md D8: `r:` SFU namespace prefix retirement](../../docs/DEBT.md)
- [ADR-0002: URL fragment secrets](https://github.com/anatolykoptev/oxpulse-chat/blob/main/docs/adr/0002-url-fragment-secrets.md) (oxpulse-chat repo)

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
