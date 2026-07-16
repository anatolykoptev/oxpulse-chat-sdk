---
"@oxpulse/chat-widget": minor
---

Add ProductPicker — searchable dropdown for the seller product catalog.

New export: `ProductPicker` class (mirrors EmojiPicker pattern).
- Fetches products via `SDKCatalogClient.listProducts()`
- Search filter by title/productRef
- Arrow key navigation, Escape to close, outside-click dismissal
- Loading / empty / error states
- A11y: role="dialog", aria-modal, focus trap, aria-label

Composer wiring:
- New `catalogClient` option on `ComposerOptions` — when present, shows a
  product picker button in the toolbar
- onSelect → `composer.setProductCard(ref, meta)` → existing product-card
  chip → attached to next outgoing message

Closes #194.
