---
"@oxpulse/chat-widget": patch
---

Refactor: deduplicate floating-element positioning logic into shared
computeFloatingPosition utility. EmojiPicker and ReactionQuickBar both
had identical fixed-vs-absolute + viewport-clamp code; now both use the
single utility. Fixes quick bar positioning jump when selecting a heart
reaction — the bar now anchors consistently to the heart button, not
the bubble.
