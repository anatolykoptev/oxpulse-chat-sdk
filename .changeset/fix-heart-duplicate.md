---
"@oxpulse/chat-widget": patch
---

Hide heart button on hover when caller already has a heart reaction.
Previously both the reaction chip ("heart N") and the heart button SVG
were visible on hover, showing two heart icons stacked vertically.
Now the chip serves as the visible indicator + toggle; the heart button
reappears when the reaction is removed.
