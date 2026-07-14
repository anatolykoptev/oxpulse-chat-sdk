---
"@oxpulse/chat-widget": patch
---

reaction quick-bar Escape no longer leaks to the host page; heart/quick-bar buttons hit 44px on more coarse-pointer devices

- `ReactionQuickBar`'s Escape handler called `preventDefault()` but the
  event still propagated to `window` — a host page's own global Escape
  listener (e.g. an embedder that unmounts the whole chat on window keydown
  Escape) fired even though the user only meant to close the bar. The
  document-level keydown listener (live only while the bar is open) now
  also calls `stopPropagation()`. A closed bar still lets Escape through to
  the host normally.
- `.oxp-reaction-heart-btn` / `.oxp-reaction-quick-bar-button` touch
  targets measured 26x22px live on a touch device despite the existing
  `@media (hover: none)` 44px rule — some touch/hybrid devices report
  `hover: hover` while still being `pointer: coarse`. Widened the same
  media condition to `@media (hover: none), (pointer: coarse)` instead of
  adding a duplicate block.

Found in live design review of widget 0.8.0 on the starthey demo.
