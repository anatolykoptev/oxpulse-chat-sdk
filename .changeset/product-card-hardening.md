---
'@oxpulse/chat-widget': patch
---

Harden the W9 product card (marketplace) feature — review follow-ups to #52.

- **Bare-card send:** a staged product card now enables the send button and
  rides an empty-text send (the "drop the product in, no caption" marketplace
  flow). Previously `setProductCard` left the send button disabled with an
  empty textarea and `#send` early-returned, so a card could not be sent on
  its own. `setProductCard`/`clearProductCard` now refresh the send state.
- **Server `product_meta` validation:** `product_meta` is unsealed opaque JSON
  any room peer can POST; the widget now validates + caps it before render.
  A partial (missing title/price/currency), non-object, or oversized value
  degrades to "no card" instead of rendering "undefined" or a multi-MB title
  (layout DoS-lite). Core display fields are required; URLs are length-capped.
- **Image privacy:** the product-card image now carries
  `referrerPolicy="no-referrer"`, so a peer-controlled `imageUrl` can no longer
  leak the viewer's page URL as a referrer on load.
