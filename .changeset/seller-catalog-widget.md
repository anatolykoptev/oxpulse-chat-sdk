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

Widget wiring (#196 — was dead code end-to-end):
- New opt-in `seller-catalog` attribute / `sellerCatalog` config option
  (boolean, default OFF — backward compatible). When ON, the widget
  constructs an `SDKCatalogClient` from the SAME `jwt` + `base-url` it
  already uses for its main SDK client and passes it as `catalogClient` to
  the `Composer`, so the product-picker toolbar button renders. Without the
  flag, no catalog client is constructed and behaviour is unchanged.

ProductPicker + button styles (#197 — previously zero CSS):
- `.oxp-product-picker` block in theme.ts mirroring `.oxp-emoji-picker`
  (container surface/border/radius/shadow, search input, flex list items
  with `justify-content: space-between` + `text-overflow: ellipsis` so the
  title and price don't collide, `:hover`/`:focus-visible` rings, styled
  loading/error/empty states).
- `.oxp-composer-product-btn` mirroring `.oxp-composer-emoji-btn`.

Closes #194. Closes #196. Closes #197.
