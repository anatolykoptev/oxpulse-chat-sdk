---
"@oxpulse/chat-widget": patch
---

Routine bug-hunt batch: theme resolution dedup, dedup-Set eviction sweep, iframe experimental notice

- **theme.ts (F8):** `applyTheme()` now calls `resolveTheme()` instead of
  duplicating the auto/light/dark branch logic inline. `resolveTheme()` was
  previously dead (zero callers) while `applyTheme()` hand-copied the identical
  resolution — collapsed to a single `host.setAttribute('data-theme',
  resolveTheme(themeAttr))` call. Behavior-identical (existing 56 theme tests
  pass).
- **message-list.ts (F12):** `#firedAttachmentErrors` and `#firedDecryptErrors`
  Sets are now swept in `#evictOldMessages()` (delete entries for evicted
  msgIds), matching how every sibling per-msgId Map is pruned. Previously these
  Sets accumulated one entry per failed msgId for the widget's entire lifetime
  (only cleared in `destroy()`), unbounded in a long-lived busy room, and a
  msgId recycled after eviction was wrongly suppressed by the stale dedup
  entry. Two new eviction tests verify the sweep + dedup-contract preservation.
- **README + element.ts (F3/F5 INTERIM):** `mode='iframe'` is now marked
  EXPERIMENTAL / not-production-ready in the README mode documentation, and
  selecting `mode='iframe'` emits a one-time `console.warn` per page load.
  The iframe mode is half-built (creates the iframe but constructs no real
  chat client; in-place JWT refresh writes `liveConfig.jwt` with no consumer —
  W2.2 TODO). Interim safety notice only; the full build is tracked separately.
- **publish-widget-cdn.mjs (F6, ops script — no package bump):** the CDN
  publish soft-skip (when `CDN_DEPLOY_KEY` is absent) now emits a `::warning::`
  GHA annotation via the existing `ghaWarning()` helper AND writes a
  step-summary line to `$GITHUB_STEP_SUMMARY`, so a skipped/misconfigured CDN
  deploy is visible in the Actions UI instead of indistinguishable from
  success on a green job. `exit(0)` is preserved (soft-skip is intentional).
