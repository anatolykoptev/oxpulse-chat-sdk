---
"@oxpulse/chat-widget": minor
---

Presence overlay — avatar online dots + heartbeat (#121)

Add green presence dot on avatars for online users, driven by SSE presence
events. Includes 30s heartbeat interval, initial presence snapshot fetch,
and 120s freshness window (matches server SDK_PRESENCE_FRESHNESS_SECS).
i18n support for en + ru.
