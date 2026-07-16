---
"@oxpulse/chat-widget": patch
---

Restore the `offsetHeight || viewportHeight` fallback in
`computeFloatingPosition` that the floating-position dedup (PR #157)
dropped: with a zero-height (not-yet-laid-out or collapsed) container the
below-flip clamp collapsed popover placement to the margin. Real rendered
containers are unaffected.
