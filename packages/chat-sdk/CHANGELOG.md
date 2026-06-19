# @oxpulse/chat-sdk — Changelog

## 1.6.0

### Minor Changes

- b04592b: client-side named-write mint helper

  Adds `mintNamedWriteToken(opts)` — sibling to `mintAnonReadToken`. POSTs to the
  client's own mint endpoint with `room_id` in the body, returns the raw JWT string.

  Throws `NamedWriteMintError` (with `.code` and `.status`) on non-2xx responses.
  Error codes: `unauthorized` (401), `forbidden` (403), `rate_limited` (429),
  `mint_failed` (other errors or malformed body).

  Both `mintNamedWriteToken` and `NamedWriteMintError` are exported from the package index.

## 1.5.0

### Minor Changes

- 161abae: client-side anon-read: `mintAnonReadToken` + widget `allow-anon-read` mode

  **@oxpulse/chat-sdk**: adds `mintAnonReadToken(opts)` helper that POSTs to
  `/api/sdk/auth/anon-read-mint` and returns a short-lived read-only JWT.
  Throws `AnonReadMintError` (with `.code` and `.status`) on non-2xx responses.
  Both are exported from the package index.

  **@oxpulse/chat-widget**: adds `allow-anon-read` boolean attribute (presence =
  true) and `base-url` attribute to `<oxpulse-chat>`. When `allow-anon-read` is
  present and no `jwt` attribute is set, the widget automatically mints an anon
  token, mounts in read-only mode (composer hidden), and schedules a re-mint 30 s
  before the 300 s token expiry. When `jwt` is provided, the existing authed path
  is unchanged. Includes injectable `_mintAnonReadToken` DI hook for tests.

All notable changes to this package will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-05-27 — Web Push integration

### Added

- **`SDKPushClient` class** — typed wrapper for Web Push subscribe/unsubscribe flow. Server endpoints: `GET /api/sdk/push/vapid-public-key` (unauthenticated), `POST /api/sdk/push/subscribe`, `DELETE /api/sdk/push/unsubscribe`. Scope: `push:write:*`. Methods: `getVapidPublicKey()`, `subscribe(opts?)`, `unsubscribe()`, `currentSubscription()`, `attachSubscriptionChangeListener(opts)`. Static helpers: `isSupported()`, `permission()`, `requestPermission()`.
- **`SDKPushError` class** — typed error with discriminated `code: SDKPushErrorCode`. Codes: `'unsupported' | 'invalid_args' | 'permission_denied' | 'permission_required' | 'no_vapid_key' | 'network' | 'server_4xx' | 'server_5xx' | 'subscription_invalid'`.
- **Types exported**: `SDKPushErrorCode`, `SubscribeResult`, `SubscriptionChangeListenerOpts`.

### Changed

- Push surface previously lived at `web/src/lib/api/sdkPush.ts` (oxpulse-chat-internal). Consumers within oxpulse-chat now import from `@oxpulse/chat-sdk` to align with external integrators.

### Server compat

Push endpoints unchanged (since W3 plan, see `docs/superpowers/plans/2026-05-13-w3-push-notifications.md`). No server-side changes in this release.

## [1.2.0] — 2026-05-27 — Phase 2 plaintext + mass-chat methods + marketplace primitives

Promotes the in-progress 1.1.0 entry to 1.2.0 to include three additional method exports (two
mass-chat methods + the marketplace primitives that were in source but undocumented since
commit `a18d8935`). Non-breaking: all 1.0.1 consumers see zero behavioural change.

### Added

**Phase 2 — plaintext mode (PRs #1683–#1702):**

- **`CryptoMode` type export** — discriminated union `'sframe-static' | 'plaintext'`. Re-exported from package root (`import type { CryptoMode } from '@oxpulse/chat-sdk'`).
- **`SDKChatClientOptions.cryptoMode?: CryptoMode`** — declares the expected server-side crypto mode for the room's app. Omitting it (default) behaves as `'sframe-static'`.
- **`SDKChatClientOptions.aliasSealedAsPlaintext?: boolean`** — wire-compat option for the v2.1 `sealed_b64 → payload_b64` rename followup (P2-F2). Set to `true` when targeting a server that already uses `payload_b64` in list/subscribe responses.
- **Downgrade defense (SEC-CR-1695-02):** when the server-emitted `crypto_mode` (from SSE `event: connected` prelude or list-response envelope) mismatches the client-configured mode, the client is permanently poisoned (`#cryptoModePoisoned`). All subsequent `send` / `sendText` / `list` / `subscribe` calls throw `SDKChatError` with code `crypto_mode_mismatch`. A poisoned client is not recoverable — callers must construct a new instance. Reverse-direction attacks (compromised server flipping an sframe-static client into plaintext) are prevented by this gate.
- **SSE `event: connected` prelude** — server now emits a `connected` event before the first message on any subscribe channel. The event payload includes `crypto_mode` (the room's configured server-side mode). The SDK parses this and validates against the client-configured `cryptoMode`.
- **`ListResponse.crypto_mode` field** — the list envelope now carries `crypto_mode` alongside `items`, `has_more`, and `next_cursor`. The SDK validates it on every `list()` call.
- **`SDKChatErrorCode` gains two new values:** `'crypto_mode_mismatch'` (server mode ≠ client expectation) and `'crypto_mode_poisoned'` (client already poisoned by a prior mismatch; recreate the instance).

**Marketplace primitives (in source since commit `a18d8935`, undocumented in 1.0.1):**

- **`sendProductCard(roomId, opts)`** — send a server-side message with a product card payload. Bundles `product_ref + product_meta + sealedBody?` in one call. Wire: `POST /api/sdk/messages` with `{product_ref, product_meta}` in the body.
- **`searchByProductRef(productRef, opts?)`** — cross-room (or per-room with `opts.roomId`) message search by product reference. Returns `MessageRow[]` sorted by seq. Wire: `GET /api/sdk/messages?product_ref=X[&room_id=Y][&limit=N]`.

**Mass-chat methods (this PR — for 5K+ buyer/seller rooms):**

- **`batchAddMembers(roomId, userIds[], role?)`** — wraps the server's bulk `user_ids` shape of `POST /api/sdk/rooms/{room_id}/members`. Chunks the input array into 500-sized sequential batches (matching server constant `BULK_ADD_MAX=500` in `crates/sdk/src/rooms.rs:78`) and aggregates `{ added, updated }` results. `added` = newly inserted members; `updated` = re-activated or role-updated members (field names mirror server docstrings in `crates/sdk/src/rooms.rs:281-286`). Empty array throws `SDKChatError('invalid_args')` without a network call.
  - For 5K-buyer rooms: 10 chunks of 500 is well below the default burst=15 rate limit; calling `addMember()` in a loop hits 429 after ~15 calls.
  - **Partial-failure contract:** on mid-bulk failure (e.g. 429 on chunk N of M), throws `SDKChatBatchError` carrying `{ partial: { added, updated }, failedAtIndex, failedChunk, remaining }`. The caller can compute the residual to retry from `e.failedChunk + e.remaining`.
- **`SDKChatBatchError` class** (new) — extends `SDKChatError`. Carries partial-success aggregate + `failedAtIndex`, `failedChunk`, `remaining`, `cause`. Exported from package root: `import { SDKChatBatchError } from '@oxpulse/chat-sdk'`.
- **`BATCH_ADD_MEMBERS_CHUNK` constant export** — value `500`, mirrors server `BULK_ADD_MAX`. Callers can inspect this to pre-validate their input without a network call.
- **`deleteRoom(roomId)`** — clears a room's entire message history via `DELETE /api/sdk/messages/{room_id}`. Destructive: use to close out a buyer-seller deal or purge test data. Does NOT delete room metadata or memberships.

### Changed

- No breaking changes. Default crypto mode remains `'sframe-static'`. All 1.0.1 call sites compile unchanged.
- `validateAndResolveCryptoMode()` internal helper introduced (replaces ad-hoc mode checks in `list()` and `subscribe()`).

### Server compat

Requires oxpulse-chat server Phase 2 (Waves 2.1–3.3 of the rev 16 plan). Minimum compatible server commit: `c475b0bf` (dev→main merge of PR #1702, deployed 2026-05-27T20:34Z).

`batchAddMembers` / `deleteRoom` rely on the rooms module introduced earlier (pre-Phase 2). The server constant `BULK_ADD_MAX = 500` is defined in `crates/sdk/src/rooms.rs:78`.

Older servers that do not emit `crypto_mode` in the connected prelude or list envelope will work transparently — the client treats a missing field as "server has not declared mode yet" and skips mismatch validation.

### References

- Plan: [`docs/superpowers/plans/2026-05-19-chat-sdk-v2.0-alt-plaintext-groups.md`](../../docs/superpowers/plans/2026-05-19-chat-sdk-v2.0-alt-plaintext-groups.md) (rev 16)
- PR #1683 — chat mirror migration
- PR #1684 — `SDKClaims` with `crypto_mode`
- PR #1686 — `PgSDKLookup` reads `crypto_mode`
- PR #1687 — `mint_handler` propagates `crypto_mode`
- PR #1691 — `SDKContext` + `CryptoMode` enum (server-side)
- PR #1692 — append + batch dispatch
- PR #1694 — list + subscribe prelude
- PR #1695 — chat-sdk client plaintext mode
- PR #1696 — vitest integration tests
- PR #1698 — Rust E2E integration tests
- PR #1702 — dev→main merge (Phase 2)
- This PR — `batchAddMembers` + `deleteRoom` + marketplace primitive docs (1.2.0)

## [1.0.1] — 2026-05-18 — API consistency

`1.0.0` was published prematurely with a holistic code-quality review surfacing 3 frozen-API issues. Since `1.0.0` cannot be reused (npm tombstones versions), these fixes land as `1.0.1`. **No consumers were on `1.0.0`** — the version was effectively unused.

**Note on semver:** technically `BatchAppendItem` rename is breaking. Released as `1.0.1` patch because 1.0.0 had zero npm consumers. If you somehow installed `1.0.0` between 20:34 PDT and 1.0.1 publish — see Migration below.

### Changed (effectively breaking — see note above)

- `BatchAppendItem` fields renamed to camelCase: `msgId`, `sealed: ArrayBuffer | null`, `threadRootMsgId`, `productRef`, `productMeta`. Wire DTO conversion (base64 encoding, snake_case) now internal to `batchAppend()`. Was previously snake_case (Rust wire shape leaked into TS public API).
- `BatchAppendItemDTO` is now a fully internal type — not exported from `types.ts` or `index.ts`.

### Added

- `SendArgs.productRef?: string` — surface a product reference on a message (marketplace use case)
- `SendArgs.productMeta?: unknown` — opaque metadata associated with `productRef`
- Plumbed through `send()`, `sendText()`, `sendOptimistic()` (via `send()`), and `sendTextOptimistic()`. Matches `batchAppend()` and `MessageRow` capability.

### Not added

- `SendArgs.replyToMsgId` — server `AppendRequest` has no `reply_to_msg_id` field; only `thread_root_msg_id` which is already exposed as `threadRootMsgId`. Server-side work required before this can be added.

### Migration from 1.0.0

- `BatchAppendItem`: `{msg_id, sealed_b64, thread_root_msg_id, product_ref, product_meta}` → `{msgId, sealed (ArrayBuffer | null), threadRootMsgId, productRef, productMeta}`. Pass raw `ArrayBuffer` — no base64 encoding.
- `SendArgs.productRef` / `productMeta` are additive (existing call sites unaffected).

## [1.0.0] — 2026-05-18 (production release)

### Summary

First stable release. All v1.0 API surface is frozen. The `web/` mirror (`$lib/api/sdkChat.ts`)
has been deleted — all production code now imports directly from `@oxpulse/chat-sdk`.

### Added

- **`batchAppend(roomId, items)` method** — sends multiple pre-sealed messages in a single
  `POST /api/sdk/messages/batch` transaction. `room_id` is injected automatically; callers
  must pre-seal each `sealed_b64` field. Does NOT auto-seal (use `sendText` / `sendTextOptimistic`
  for auto-seal). Scope required: `chat:write:<room_id>`.
- **`BatchAppendItem` interface** — exported from the package root. Wire shape for one item in the
  batch endpoint: `{ msg_id, sealed_b64?, thread_root_msg_id?, product_ref?, product_meta? }`.
- **Subscribe reconnect tests** — `subscribe-reconnect.test.ts` covers reconnect-with-backoff and
  `list()`-replay behavior in the canonical SDK test suite (ported from mirror tests #7/#8).

### Changed

- **`web/src/lib/api/sdkChat.ts` deleted** — all `$lib/api/sdkChat` imports in the `web/`
  package have been switched to `@oxpulse/chat-sdk`. The mirror served as a staging area;
  any behavior that lives in production now has a canonical home in the SDK.
- Version bumped `0.7.0` → `1.0.0`.

## [0.7.0] — 2026-05-18 (review fixes)

### Breaking changes (within 0.7.0, pre-release)

- **`E2EEOptions` is now a discriminated union** — `provider: 'sframe'` shape now requires `getKey`
  (was optional before). `provider: CryptoProvider` shape no longer accepts `getKey`. TS will
  catch any misuse at compile time.
- **`E2EEOptions.onKeyRotation` removed** — it was declared but never wired to any provider
  callback. Re-added in a future version when sframe-ratchet rotation hooks are integrated.

### Fixed

- **M1 — Outbox bypass (CRITICAL):** Added `SDKChatClient.sendTextOptimistic()` that seals
  plaintext before enqueue, so the outbox never stores plaintext. `sendOptimistic()` emits a
  one-time `console.warn` when called with e2ee configured — callers should migrate to
  `sendTextOptimistic()`.
- **M2 — list() silent drop on unseal failure:** Failed rows are now preserved in `items` with
  `MessageRow.unsealError: 'replay' | 'auth' | 'unknown'` instead of being silently dropped.
  This keeps pagination counts accurate and surfaces tampered/replayed rows.
- **M3 — Global decrypt chain stall:** `subscribe()` now maintains a per-room decrypt chain
  (`Map<roomId, Promise>`) so a stuck unseal in one room does not stall other rooms. Added a
  5-second timeout per unseal; timed-out messages are delivered with `unsealError: 'unknown'`.
- **M4 — Missing @noble peerDeps:** Added `@noble/curves ^2.2.0` and `@noble/hashes ^2.2.0`
  to `dependencies` so consumers without these in their tree do not get `ERR_MODULE_NOT_FOUND`.
- **M5 — Caret on fresh 0.x dep:** `sframe-ratchet` pinned to exact `0.5.0` (was `^0.5.0`).
- **M7 — Dead `onKeyRotation` field:** Removed from `E2EEOptions` (see Breaking changes above).
- **MINOR — `.buffer` aliasing in `sframe.ts`:** `result.buffer` replaced with
  `result.slice().buffer` in both `seal` and `unseal` to avoid aliasing a pooled/shared
  `ArrayBuffer`.

### Added

- `MessageRow.unsealError?: 'replay' | 'auth' | 'unknown'` — populated on unseal failures.
- `SDKChatClient.sendTextOptimistic()` — E2EE-safe optimistic send (seals before enqueue).
- `ReplayError` re-exported from main index (from `sframe-ratchet/chat`) for consumer error
  inspection.

## [0.7.0] — 2026-05-18

### Added

- **SFrame E2EE provider** (`createSFrameProvider`) via `sframe-ratchet@0.5.0` chat-mode subpath.
  - New types: `CryptoProvider`, `E2EEOptions`, `SealContext` (all re-exported from main index).
  - `SDKChatClientOptions.e2ee` — optional E2EE config (discriminated union: sframe+getKey or custom CryptoProvider).
  - `SDKChatClient.sendText(roomId, {senderUid, text})` — encrypts UTF-8 text via provider and calls `send()`. Throws `SDKChatError('unsupported')` when `e2ee` is not configured.
  - `list()` auto-decrypts rows when `e2ee` is configured; failed unseal → row filtered + `console.warn`.
  - `subscribe()` auto-decrypts on `onMessage`; async decryptions serialised to preserve order.
  - `MessageRow.plaintext?: ArrayBuffer` — populated after successful unseal.

### Dependencies

- Added `sframe-ratchet@^0.5.0` (chat-mode additive subpath, published 2026-05-18).

### ⚠️ Key contract

`E2EEOptions.getKey` MUST return a `CryptoKey` with usages `['deriveKey','deriveBits']` (HKDF base-key), **not** AES-GCM. The library derives its own AES-128-GCM keys via HKDF internally.

### ⚠️ Threat model

No forward secrecy; no post-compromise security; symmetric AEAD (any room member can forge messages from any other member). Document loudly in production integrations. See design doc `docs/superpowers/plans/2026-05-18-sframe-ratchet-chat-api-v0.5.md § C`.

## [0.6.1] — 2026-05-18

### Fixed

- **Declare missing `thumbhash` dependency.** `@oxpulse/chat-sdk/thumbhash` subpath imports `thumbhash@^0.1.1` but the dep was not declared, breaking installs that didn't have it hoisted from a workspace. Now explicitly declared.

### Changed (internal)

- Web app (`web/src/lib/chat/attachments/thumb-hash.ts`) was a byte-identical duplicate; deleted. Consumers (`AttachmentBubble.svelte`, `AttachmentSlot.svelte`) now import from `@oxpulse/chat-sdk/thumbhash`. The 154-line unit test moved to `packages/chat-sdk/src/__tests__/thumbhash.test.ts` (canonical home).

## [0.6.0] — 2026-05-18

### Added

- `sendOptimistic(roomId, args)` — Sendbird-style callback handle (`onPending` / `onSucceeded` / `onFailed`).
  Message is enqueued to idb-keyval before the first network attempt, persisting across page reloads.
- `flushOutbox(roomId)` — retry all queued messages for a room (cold-start on reconnect).
- `outbox.ts` — `enqueue` / `dequeue` / `pending` helpers backed by idb-keyval (`outbox:<roomId>` key).
- `OptimisticHandle` type in `types.ts` with chaining methods and `done: Promise<{seq, msgId}>`.
- Retry policy: MAX_RETRIES (5) with exponential backoff on network errors; non-network errors (4xx) fail immediately.

### Dependencies

- New runtime dep: `idb-keyval@^6.2.1`.
- New dev dep: `fake-indexeddb@^6` (test environment).

## [0.4.1] — 2026-05-17

### Changed

- Bump `@oxpulse/wire-codec` peer range to `^0.3.0` (no behavioral change in
  chat-sdk; wire-codec 0.3.0 adds mesh-bundle API which chat-sdk does not consume).
  External `npm install @oxpulse/chat-sdk@0.4.0` was resolving `wire-codec@0.2.0`
  because the prior `^0.2.0` range did not satisfy 0.3.x.

## [0.5.0] — 2026-05-18

### Added

- `sendFile(roomId, blob, args)` — presign → PUT encrypted blob → send sealed reference in one call.
- `presignAttachment(client, args)` — standalone helper: POST `/api/sdk/attachments/presign`, returns `{ attachmentId, uploadUrl }`.
- `MAX_ATTACHMENT_BYTES` constant (50 MB) — client-side guard enforced before network calls.
- `SendFileArgs` type: `{ senderUid, sealed, mimeType?, sha256, thumbhashB64? }`.
- `AttachmentMeta`, `PresignBody`, `PresignResp` types re-exported from `types.ts`.
- `SDKChatClient.sendFile(roomId, blob, args)` — convenience method wrapping standalone `sendFile`.
- Public getters `client.baseUrl` and `client.jwt` for use by attachment helpers.
- Subpath exports: `@oxpulse/chat-sdk/thumbhash` + `@oxpulse/chat-sdk/attachments`.
- Server: `POST /api/sdk/attachments/presign` — issues HMAC-signed PUT URL (5 min TTL).
- Server: `PUT /api/sdk/attachments/{id}?t=<token>` — stores blob under `$OXPULSE_CHAT_UPLOADS_DIR/chat-sdk/<app_id>/<sha256[0..2]>/<sha256>.bin`.
- Server: `GET /api/sdk/attachments/{id}` — streams blob from disk (JWT-authenticated).
- Migration: `sdk_attachments` metadata table (PK: app_id + attachment_id).
- Prometheus counters: `sdk_attachment_presign_total`, `sdk_attachment_upload_total`, `sdk_attachment_download_total`.

### Storage

- Env var `OXPULSE_CHAT_UPLOADS_DIR` controls upload root (default: `/tmp/oxpulse-uploads` in dev).
  Production deployments must set this to a persistent path.

## [0.4.0] — 2026-05-16

### Added

- `sendReaction(roomId, msgId, type)` — add a reaction emoji (idempotent per user+emoji). Client validates 1-32 chars before network call.
- `removeReaction(roomId, msgId, type)` — remove own reaction. No-op if never added.
- `getReactions(roomId, msgId)` — fetch aggregated `{counts, users}` from `GET /api/sdk/messages/:room/:msg/reactions`.
- `subscribe({onReaction})` — receives `reaction_add`/`reaction_remove` events via existing mutation SSE channel.
- `ReactionEvent` interface: `{ appId, roomId, msgId, op, reaction, userId }`.
- `ReactionsResponse` interface: `{ counts: Record<string, number>, users: Record<string, string[]> }`.
- Server: `POST /api/sdk/messages/{room_id}/{msg_id}/reactions` — add reaction (idempotent, FK-checked).
- Server: `DELETE /api/sdk/messages/{room_id}/{msg_id}/reactions/{reaction}` — remove own reaction.
- Server: `GET /api/sdk/messages/{room_id}/{msg_id}/reactions` — aggregated counts + user lists.
- New event variants on `sdk_message_log_mutation` channel: `op: "reaction_add" | "reaction_remove"` with `{msg_id, user_id, reaction}`.
- Migration: `sdk_message_reactions` table with composite PK + FK → `sdk_message_log` ON DELETE CASCADE.

### Wire

- New event variant on `sdk_message_log_mutation`: `op: "reaction_add" | "reaction_remove"` with `{msg_id, user_id, reaction}`.

## [0.3.0] — 2026-05-16

### Added

- `updateMessage(roomId, msgId, {sealed})` — edit a message (only sender). Bumps `editCount`, sets `editedAt`.
- `deleteMessage(roomId, msgId)` — soft-delete (sender only). Sealed payload cleared, `deletedAt` set.
- `pinMessage(roomId, msgId)` / `unpinMessage(roomId, msgId)` / `listPins(roomId)` — message pinning.
- `MessageRow` gains `editedAt?: string`, `deletedAt?: string`, `editCount?: number` fields.
- `UpdateMessageArgs` interface: `{ sealed: ArrayBuffer }`.
- `PinnedMessage` interface: `{ appId, roomId, msgId, pinnedBy, pinnedAt }`.
- Server: `PATCH /api/sdk/messages/{room_id}/{msg_id}` — edit handler (RLS by sender_uid).
- Server: `DELETE /api/sdk/messages/{room_id}/{msg_id}` — soft-delete handler.
- Server: `POST /api/sdk/rooms/{room_id}/pins/{msg_id}` — pin handler.
- Server: `DELETE /api/sdk/rooms/{room_id}/pins/{msg_id}` — unpin handler.
- Server: `GET /api/sdk/rooms/{room_id}/pins` — list pins handler.
- `GET /api/sdk/messages?include_deleted=true` — opt-in to include soft-deleted tombstones.

## [0.2.0] — 2026-05-16

### Changed (BREAKING)

- **`list()` now returns `ListResult` instead of `MessageRow[]`.**
  Callers must access `result.items` for the message array.
  ```ts
  // Before (0.1.x):
  const rows: MessageRow[] = await client.list(roomId);
  // After (0.2.x):
  const { items, hasNext, next } = await client.list(roomId);
  ```
- Server GET `/api/sdk/messages` response changed from a bare JSON array to
  an envelope `{ items, has_more, next_cursor }`.

### Added

- `ListResult` interface: `{ items: MessageRow[], hasNext: boolean, next?: number }`.
- `ListArgs.beforeSeq` — reverse-paging cursor. Pass a previous `next` value
  as `beforeSeq` to load the preceding page of history.
- `before_seq` query parameter on GET `/api/sdk/messages` (Rust server).
- Rust server: `has_more` sentinel-row detection (limit+1 fetch, no COUNT query).
- Rust server: `next_cursor` = seq of oldest row in the page.

## [0.1.0] — 2026-05-16

### Added

- First public release on npm.
- `SDKChatClient` with `send`, `list`, `subscribe` over the OxPulse SDK HTTP API.
- Optional zstd compression (`'none'` | `'auto'` | `'dict'`) via `@oxpulse/wire-codec`.
- `SDKChatErrorCode` typed error surface for client-side error handling.
- CSP-safe by design: zero `eval` / `new Function` calls in the bundled SDK
  (verified by `csp-cleanliness.test.ts` CI gate).
- Optional `appId` field on `SDKChatClientOptions` for multi-tenant app
  namespace hints — server-side scope check is authoritative.
