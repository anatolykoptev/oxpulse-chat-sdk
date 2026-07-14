---
"@oxpulse/chat-widget": patch
---

a11y: timestamp + product-price on-bubble contrast token; keep scroll pinned when composer resizes (reply bar toggle).

- Fix WCAG 1.4.3 contrast failure on `.oxp-bubble-time` (message timestamp, every
  message, both themes — measured live 3.99:1 light / 4.27:1 dark at 11.2px, needs
  4.5:1) and `.oxp-product-price` (same latent `--oxp-muted`-on-tinted-bg issue inside
  the in-bubble product card). Both now use `--oxp-fg-secondary`, this file's own
  designated on-bubble text token (already ≥4.5:1 on all four self/other ×
  light/dark bubble backgrounds).
- Fix a scroll-desync bug: toggling the reply-preview bar resizes the composer (a
  sibling of the message list in the widgetRoot flex column), shrinking the list's
  own clientHeight without moving `scrollTop` — the newest message clipped by the
  resize delta and only self-healed on the next appended message. `MessageList` now
  observes its own scroll container's resize and re-pins to bottom when the reader
  was pinned before the resize; a reader scrolled up to read history is left alone.
