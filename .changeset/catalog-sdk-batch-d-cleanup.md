---
"@oxpulse/chat-sdk": patch
"@oxpulse/chat-widget": patch
---

Seller-catalog SDK — Batch D (final cleanup): shared picker-dismiss helper
(#203) + LOW-severity hardening batch (#206).

- #203 (reuse): extract `useFloatingDismiss(pickerEl, anchorEl, { onHide,
  getRestoreFocusEl, signal })` into `utils/floating-dismiss.ts`. EmojiPicker
  and ProductPicker shared ~60 byte-identical lines of outside-pointerdown
  dismiss + Escape/Tab focus-trap (same `'input, button:not([disabled])'`
  selector + shift-tab wrap) + abort-signal wiring, alongside the
  already-shared `computeFloatingPosition`. Both pickers now call the single
  helper. Behavior is identical — every existing emoji-picker AND
  product-picker test (dismiss / focus-trap / escape / outside-click / abort)
  stays green.
- #206a: `catalog.ts` error switch adds an explicit `422 → validation_error`
  case (a 422 validation error previously fell to `default → server_4xx`,
  mislabeling it); and `resp.json()` on a 2xx body is guarded so an empty
  2xx body returns `null` instead of throwing a raw `SyntaxError` that
  escapes the `SDKCatalogError` wrapper.
- #206b: `SDKCatalogClient` constructor warns (defense-in-depth,
  non-breaking) when an absolute `baseUrl`'s scheme is not `https:` — the
  JWT rides as `Authorization: Bearer <jwt>` and an `http://` absolute
  baseUrl leaks it in cleartext (passive MITM). Empty / relative / localhost
  / 127.0.0.1 baseUrls are allowed (dev + same-origin).
- #206c: `product-picker.ts` sets `aria-selected="false"` on each rendered
  `role="option"` item and flips the keyboard-focused item to `"true"`
  (listbox APG expectation).

Skipped (out of this batch, tracked separately in #206): authoring
DESIGN.md; the repo-wide `assertRawJwt` bearer-prefix dedup (11th copy —
systemic); the `httpStatusToCode` generalization (deferred until a 3rd
`SDK*Client` mapper appears).
