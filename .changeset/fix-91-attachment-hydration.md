---
"@oxpulse/chat-widget": patch
---

Fix attachment image hydration failing permanently on transient 429/401.
The authed fetch now retries up to 3 times with backoff (500ms/1s/2s)
before falling back. On final failure, a data-hydrate-failed attribute
is set for CSS placeholder styling, and the element falls back to the
direct URL as a last resort.
