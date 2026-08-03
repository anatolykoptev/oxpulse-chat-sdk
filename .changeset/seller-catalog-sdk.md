---
"@oxpulse/chat-sdk": minor
---

Add SDKCatalogClient — typed wrapper for seller product catalog CRUD.

New export: `SDKCatalogClient`, `SDKCatalogError`, `CatalogProduct` type.
Methods: `createProduct`, `listProducts`, `getProduct`, `updateProduct`,
`deleteProduct` (soft-delete/archive). Separate class (mirrors SDKPushClient
pattern) — SDKChatClient is already ~2900 lines.

Server API: POST/GET/PATCH/DELETE /api/sdk/catalog/products[/:ref].
Auth: SDK JWT with scope catalog:read:* / catalog:write:*.

Closes #193.
