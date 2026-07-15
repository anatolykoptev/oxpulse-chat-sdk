---
"@oxpulse/chat-widget": minor
"@oxpulse/chat-sdk": patch
---

Product-card followups (#113, #114, #116, #117):

- **chat-widget**: Composer now renders a dismissible "product card attached" chip
  when a card is staged via `setProductCard`, mirroring the reply-preview bar
  pattern. The chip's × dismiss calls `clearProductCard()`; the chip is hidden on
  clear and after a successful send. i18n: `productCardAttached` + `removeProductCard`
  in en and ru. Theme CSS mirrors the reply-preview classes.
- **chat-widget**: New end-to-end test mounts `OxpulseChatElement` with a real
  `SDKChatClient` + fetch mock, calls `setProductCard` + sends, and asserts the
  outgoing POST body carries `product_ref` + `product_meta` through the full
  adapter → SDK → wire path.
- **chat-sdk**: `rowToMessageRow` now normalizes `product_meta` at the receive
  boundary — requires title/price/currency non-empty strings, caps lengths
  (title 200, price 40, currency 16, urls 2048), coerces bad URLs to '', returns
  null for non-object or invalid payloads. `MessageRow.productMeta` is now honest
  for all SDK consumers.
- **chat-sdk**: `sendProductCard()` doc-comment documents its role as the public
  external-integrator convenience API and explains why the in-house widget routes
  cards through `sendText()` instead. No behavior change.
