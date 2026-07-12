---
'@oxpulse/chat-widget': patch
---

Fix unbounded DOM/memory growth in the live message stream: `MessageList` now caps the live-streamed window at `MAX_LIVE_MESSAGES` (300), evicting the oldest messages — from internal bookkeeping and the DOM — once a live append crosses the cap. Previously every live message was appended with no eviction, so a visitor keeping a product-page tab open through a busy period (e.g. a high-traffic central chat room) accumulated unbounded DOM nodes.

Eviction is skipped while the user has scrolled up reading history, so it never yanks content out from under an actively-reading visitor; growth resumes being bounded on the next live message once they're back at the bottom. This is a safety cap on the live window only — full scroll-back virtualization (for paging through evicted history) is a separate future feature once "load older" pagination UI exists.
