---
"@oxpulse/chat-widget": minor
---

Full threads — thread panel with replies (#126)

Add a full thread view side panel. Users click a "N replies" indicator on any
message with thread replies to open a panel showing the root message, all
replies, and an inline composer for sending new replies. Uses existing SDK
getThread + sendText(threadRootMsgId) methods.
