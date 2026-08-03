---
"@oxpulse/chat-sdk": minor
---

Migrate to sframe-ratchet 0.5.5 — remove custom DurableReplayGuard, delegate to library.

## What changed

- **Bumped** `sframe-ratchet` from `0.5.0` to `0.5.5`.
- **Deleted** the SDK's custom 365-line `DurableReplayGuard` (`sframe-replay.ts`) and its
  test suite (`sframe-replay.test.ts`). The guard is now built and owned by
  `createChatProvider` inside sframe-ratchet 0.5.5+ — the SDK delegates entirely.
- **Simplified** `createSFrameProvider` (`sframe.ts`): the manual `parseHeader` →
  `durable.check` → `inner.unseal` → `durable.accept` dance is gone. The wrapper now
  forwards `namespace` / `durableReplay` / `durableReplayWindow` to `createChatProvider`
  and the library runs the check→decrypt→accept sequence internally.
- **Updated** `sframe-unseal-abort.test.ts` to pass `durableReplayNamespace` (required
  by the library's default-on-when-namespaced behavior).
- **Added** `sframe-durable-integration.test.ts` — integration tests verifying the
  library-owned guard in the SDK's context (cross-reload replay, anti-poison, default
  namespace, opt-out, in-session replay).

## Why

sframe-ratchet 0.5.5 ships the same `DurableReplayGuard` design (IDB + Web Locks,
read-merge-write, FIFO cache cap, feature-detected degradation) as a first-class
library feature — issue #41 flipped the default to ON when a namespace is provided.
Maintaining a 365-line duplicate in the SDK was pure cost: double CTR tracking, double
IDB stores, divergent bug surfaces. The migration collapses to one owner.

## Breaking changes

None. The SDK defaults `durableReplayNamespace` to `'default'` when neither
`durableReplayNamespace` nor `ctrKeyspace` is provided, preserving the pre-0.5.5
behavior where the SDK's own DurableReplayGuard defaulted to `'default'`.

Callers using `SDKChatClient` with `e2ee.durableReplayNamespace` or `e2ee.ctrKeyspace`
are unaffected — the client already forwarded `durableReplayNamespace: e2ee.durableReplayNamespace ?? opts.appId`.

## Test plan

- [x] Unit tests pass, 0 fail
- [x] TypeScript: 0 errors
- [x] `sframe-unseal-abort.test.ts` — abort-honoring + replay-reject still pass with
      library-owned guard
- [x] `sframe-durable-integration.test.ts` — cross-reload replay, anti-poison, default
      namespace, opt-out, in-session replay all pass with library-owned guard
- [x] Contract tests: 4 skipped (need live server — unchanged)
