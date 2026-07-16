---
"@oxpulse/chat-widget": patch
---

Fix reaction quick bar appearing higher than the heart button. The bar
was anchored to the message bubble element (spanning the whole message)
instead of the heart button, causing a 75px gap between the bar and the
heart on hover.
