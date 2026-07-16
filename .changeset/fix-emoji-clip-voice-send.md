---
"@oxpulse/chat-widget": patch
---

Fix emoji picker clipped by widget root overflow:hidden — picker now mounts
to the shadow root host (position:fixed) when a shadowHost is passed, mirroring
the ReactionQuickBar MAJOR-5 pattern. Grid with emojis is no longer cut off.

Fix voice preview send button showing localized text (\"Отправить\"/\"Send\")
instead of the paper-plane SVG icon — now matches the main composer send button.
