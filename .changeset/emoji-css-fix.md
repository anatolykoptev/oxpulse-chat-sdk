---
"@oxpulse/chat-widget": patch
---

Fix CSS parsing bug: .oxp-composer-emoji-btn:hover had no closing brace, causing all subsequent CSS to be nested inside it. Add missing --oxp-surface and --oxp-tint tokens.
