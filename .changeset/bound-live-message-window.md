---
'@oxpulse/chat-widget': patch
---

Fix unbounded DOM/memory growth in the live message stream: `MessageList` now caps the live-streamed window at `MAX_LIVE_MESSAGES` (300), evicting the oldest messages — from internal bookkeeping and the DOM — once a live append crosses the cap. Previously every live message was appended with no eviction, so a visitor keeping a product-page tab open through a busy period (e.g. a high-traffic central chat room) accumulated unbounded DOM nodes.

Eviction is two-tiered. While the user is pinned to the bottom, every live append trims to the 300-message soft cap — invisible to them, since they're not looking at the top. While scrolled up reading history, eviction is skipped up to a much higher hard ceiling (600) so an actively-reading visitor never gets content yanked out from under them mid-read; only a session that piles up 600+ messages while permanently scrolled away (the "walk away and never come back to bottom" case) gets trimmed down to that ceiling. Without the hard ceiling, that walk-away session was still genuinely unbounded — caught in review before merge.

This is a safety cap on the live window only — full scroll-back virtualization (for paging through evicted history) is a separate future feature once "load older" pagination UI exists.
