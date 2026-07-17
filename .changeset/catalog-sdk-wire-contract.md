---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

Fix SDKCatalogClient wire contract to match the finalized server DTOs (#195),
rebuild the synthetic-green catalog tests against real server shapes (#198),
and make `ProductMeta.price` a JSON number (#207, SDK half).

- #195: request bodies are now snake_case (`{ product_ref, product_meta }` for
  create, `{ product_meta }` for update) — the server rejects camelCase keys.
  Responses are mapped snake→camel via a `dtoToCatalogProduct` mapper that
  reuses the rooms-boundary `normalizeProductMeta` (client.ts) instead of blind
  `as unknown as CatalogProduct` casts that left `productRef` / `createdAt` /
  `archivedAt` undefined.
- `listProducts` now accepts `{ limit?, cursor?, signal? }` and returns
  `{ products, hasMore, nextCursor }` mapped from the `{ products, has_more,
  next_cursor }` envelope (cursor-based pagination). A malformed-cursor 400
  maps to `validation_error`.
- #207: `ProductMeta.price` is now `number` (non-negative JSON number), not a
  host-pre-formatted display string. Callers own locale-aware formatting at
  render time.
- #198: `catalog.test.ts` rewritten to real snake_case mock payloads with
  numeric `price`, asserting the request body is snake_case and the response
  mapping populates camelCase fields.

**Breaking (@oxpulse/chat-widget):** `ProductMeta.price` is now `number`, not a
host-pre-formatted string. This also changes the shared render-boundary
`normalizeProductMeta`, which now rejects a string `price` — so a product-card
message from an older client that sends a string price is dropped on receive.
See the wire-compat note tracked separately.

Note: `price: string → number` and the `listProducts` return-shape change are
breaking for consumers of the catalog API; they land within the same unreleased
minor as the original `SDKCatalogClient` export (#193), which never shipped a
correct form.

Closes #195. Closes #198. Closes #207.
