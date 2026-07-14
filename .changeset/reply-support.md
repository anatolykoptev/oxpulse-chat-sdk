---
"@oxpulse/chat-widget": minor
---

Add thread reply support to the chat widget. The `MessageList` now renders a reply button on each message and a compact quote preview for messages with `threadRootMsgId`. The `Composer` exposes `setReplyTarget()` to preview the message being replied to and sends with `threadRootMsgId` populated. Includes i18n (`en`/`ru`) and theme styles for touch and desktop.
