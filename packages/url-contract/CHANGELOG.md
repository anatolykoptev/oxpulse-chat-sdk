# @oxpulse/url-contract

## 0.4.0

### Minor Changes

- 0b62c5c: Fragment values are carried literally, end to end.

  `buildCall1to1Url` and `buildBurnerChatUrl` no longer `encodeURIComponent` the
  fragment payload, and `parseRoomUrl`, `parseCallFragment`, `parseBurnerFragment`
  and `parseRoomFragment` no longer decode it. Percent-encoding stays on the path
  components (`roomId`, short-link alias), where it belongs.

  0.3.0 decoded on parse but encoded on build, which round-tripped — but the
  decode step also normalised two distinct fragments onto one value (`a%2Eb.c` and
  `a.b.c` both yielded the secret `a.b`), and rejected a whole fragment on a
  malformed escape (`k=%` → null). For a fragment carrying a join secret and the
  expected host pubkey — the latter compared against the host's actual key — that
  normalisation is a property the verification step never asked for. Reported as
  #354 with a 12-input differential against the oxpulse-chat implementations these
  parsers mirror; those return literal payloads, and now so do these.

  The contract narrows accordingly: a fragment value must already be URL-safe.
  base64url (RFC 4648 §5) and hex both are, which is what the builders document.
  A value containing a space or `/` no longer survives the round-trip, where the
  old encode/decode pair carried it.

  Also ships the cross-language contract fixtures — `src/__fixtures__/` and
  `fixtures/` join `files`, so a consumer can assert against the published artifact
  instead of vendoring a copy that silently drifts (#334).

## 0.3.0

### Minor Changes

- 66ea61f: Bug-hunt fixes: decode fragments in standalone parsers, /s/ short-link support in parseRoomUrl, fragment-route validation per ADR-0005, implement stripChecksum.

  - **#341 (HIGH):** `parseCallFragment`/`parseBurnerFragment`/`parseRoomFragment` now `decodeURIComponent` their output, matching `parseRoomUrl`. Invalid percent-sequences return null.
  - **#342 (MEDIUM):** `parseRoomUrl` now supports `/s/<alias>` short-link URLs — returns `{ alias, routePrefix: '/s/' }`.
  - **#343 (MEDIUM):** `parseRoomUrl` validates fragment type matches route prefix per ADR-0005: call fragment on bare-root only, burner fragment on `/c/` only, no fragments on `/r/` or `/m/`.
  - **#344 (MEDIUM):** Implemented `stripChecksum` — inverse of `appendChecksum`, returns 9-char payload from 10-char code without verifying.

### Patch Changes

- 8dcc77d: Remove `publishConfig.directory` from package manifests.

  `publishConfig.directory: "dist"` causes `pnpm pack` to fail with
  `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`. The `files` field already includes
  `dist/`, so `publishConfig` only needs `access: public`. Shipped in 46b16fd
  without a changeset — this one ensures the fix reaches npm on its own.

## 0.2.0

### Minor Changes

- 263e5bc: Promote @oxpulse/url-contract to SDK repo as publishable package.
