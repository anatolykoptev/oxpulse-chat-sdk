---
"@oxpulse/chat-widget": patch
---

Fix reply preview bar visibility when hidden.

The `[hidden]` attribute on `.oxp-composer-reply` was being overridden by the
class's `display: flex` style, so the empty reply preview was visible even when
no reply target was set. Added a shadow-DOM `[hidden] { display: none !important; }`
rule so `hidden` always wins over component display styles.
