---
"@oxpulse/chat-widget": patch
---

Fix attachment download link and open-in-new-tab hitting JWT-gated GET
unauthenticated. Both the generic file download link and the image
open-in-new-tab click handler now intercept the click, do an authed
fetch via the hydrate bridge, and trigger download/open via a blob URL.
Falls back to direct URL when no hydrate bridge is wired.
