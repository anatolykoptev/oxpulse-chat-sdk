---
'@oxpulse/chat-widget': patch
---

Fix self/other bubble alignment when no `self-uid` attribute is set: the widget now falls back to the JWT `sub` claim, so the visitor's own messages align right (messenger-standard) out of the box. An explicit `self-uid` attribute still wins. Display-side only — the server never trusts this value.
