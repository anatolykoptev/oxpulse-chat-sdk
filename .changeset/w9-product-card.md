---
'@oxpulse/chat-widget': minor
---

W9: render product cards in the widget and wire them through the Composer.

- Add `ProductMeta` type and `OxpulseChatElement.setProductCard(ref, meta)` API.
- `Composer` forwards `productRef`/`productMeta` to `sendText`/`sendTextOptimistic`.
- `MessageList` renders a clickable product card preview (image, title, price, link) when a row has `productRef` + `productMeta`.
- Add i18n key `productViewAria` and theme CSS for `.oxp-bubble-product`.
