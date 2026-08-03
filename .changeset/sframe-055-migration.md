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

## Why

sframe-ratchet 0.5.5 ships the same `DurableReplayGuard` design (IDB + Web Locks,
read-merge-write, FIFO cache cap, feature-detected degradation) as a first-class
library feature — issue #41 flipped the default to ON when a namespace is provided.
Maintaining a 365-line duplicate in the SDK was pure cost: double CTR tracking, double
IDB stores, divergent bug surfaces. The migration collapses to one owner.

## Breaking changes

None for callers using `SDKChatClient` with `e2ee.durableReplayNamespace` or `e2ee.ctrKeyspace`
— the client already forwarded `durableReplayNamespace: e2ee.durableReplayNamespace ?? opts.appId`.

Callers using `createSFrameProvider` directly without a `durableReplayNamespace` (or
`ctrKeyspace`) will now get a one-time `console.warn` from the library and durable
replay will be DISABLED (the library requires a namespace to isolate IDB stores).
Pass `durableReplayNamespace: 'your-app-id'` to enable cross-reload protection.

## Test plan

- [x] 344 unit tests pass, 0 fail
- [x] TypeScript: 0 errors
- [x] `sframe-unseal-abort.test.ts` — abort-honoring + replay-reject still pass with
      library-owned guard
- [x] Contract tests: 4 skipped (need live server — unchanged)
