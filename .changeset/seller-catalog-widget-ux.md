---
"@oxpulse/chat-widget": minor
---

ProductPicker UX polish + numeric-price display (Batch C).

- #207: the picker item price span and the W9 product-card message now format
  the numeric `price` via `Intl.NumberFormat(locale, { style: 'currency',
  currency })` (new `formatPrice` helper in utils/i18n.ts) instead of the raw
  `${price} ${currency}` string coercion ("19.99 USD"). Graceful fallback to
  the raw number when `currency` is not a valid ISO-4217 code.
- #199: `ProductPicker.#loadProducts` no longer short-circuits on
  `#allProducts.length > 0` — the Composer reuses one picker instance across
  opens, so the cached first page froze the list for the widget lifetime
  (stale after add/edit/delete). Products are refetched on every `show()`;
  only the in-flight `#loading` guard remains.
- #200: `aria-live="polite"` is now set once on the stable list container in
  `#buildPicker` (not per-branch on fresh child nodes), so loading / error /
  empty / result-count transitions all announce to assistive tech (WCAG 2.2
  SC 4.1.3).
- #205: missing `productMeta.title` falls back to a localized
  `productPickerUntitled` key (en/ru) instead of rendering the literal string
  "undefined"; the price span is omitted entirely when price/currency are
  absent. The search filter guards against a missing title.
- #204: ArrowDown/ArrowUp keydown handler on the search input (where focus
  lands on open) forwards to the first / last item button — arrow-key nav is
  no longer dead until an item is focused.
- #201: verified already fixed — `aria-label='Product list'` is routed
  through `t('productPickerList', lang)` (landed in a prior commit).

Closes #199. Closes #200. Closes #202. Closes #204. Closes #205. Closes #207.
