---
"@oxpulse/chat-widget": minor
---

Read receipts — checkmarks on own messages (#122)

Add WhatsApp-style read receipt checkmarks on own message bubbles, driven by
SSE read_receipt events. Delivered (double ✓ gray) → Read (double ✓ accent).
Auto-marks incoming messages from others as read. i18n support for en + ru.
