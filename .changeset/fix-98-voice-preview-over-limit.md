---
"@oxpulse/chat-widget": patch
---

Fix voice preview Send button not showing disabled state when caption
exceeds the character limit. The button is now disabled (visual feedback)
instead of silently blocking the send on click.
