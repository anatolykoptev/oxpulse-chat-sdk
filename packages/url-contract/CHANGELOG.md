# @oxpulse/url-contract

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
