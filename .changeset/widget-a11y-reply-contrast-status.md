---
"@oxpulse/chat-widget": patch
---

a11y: reply-preview contrast token + role=status; product-card contract docs + sendText type parity.

- Fix WCAG 1.4.3 contrast failure on reply-body preview text: `.oxp-composer-reply-body`
  and `.oxp-bubble-reply-body` now use `--oxp-fg-secondary` instead of `--oxp-muted`
  (light ≈4.2:1, dark ≈2.95:1 — both below the 4.5:1 AA floor). Matches the sibling
  `-label`/`-sender` selectors already on this token.
- Change the reply-preview bar from `role="region"` to `role="status"` (implicit polite
  live region) so it no longer announces as a persistent landmark that flickers in and
  out with every reply.
- Document `ProductMeta.price` as host-pre-formatted display text (the widget renders
  `${price} ${currency}` verbatim, no `Intl.NumberFormat`).
- Document that `setProductCard()` metadata travels unsealed on the wire and is
  server-visible even in E2EE rooms (by design, mirrors `sendProductCard`).
- Add `productRef`/`productMeta` to `WidgetConfig.client.sendText` for type parity with
  `element.ts`'s `composerClient`.
- Add an element-level test exercising the public `el.setProductCard()` wrapper end to
  end (previously only the inner `Composer.setProductCard()` was covered).
