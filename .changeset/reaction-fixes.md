---
"@oxpulse/chat-widget": minor
---

Fix live reaction updates: `MessageList` now re-fetches `getReactions` when the SSE `reaction` event omits a reliable `totalCount`, instead of trusting `totalCount: 0` and hiding chips. Add a `reactions-enabled` attribute / `reactionsEnabled` config to disable the reaction UI (hides the trigger button, reaction clusters, and live `onReaction` subscription). Route `sendReaction`/`removeReaction` through the `effectiveSendClient` so named-write / allow-write paths use the correct JWT.
