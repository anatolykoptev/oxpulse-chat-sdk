---
"@oxpulse/url-contract": patch
"@oxpulse/intro-protocol": patch
---

Remove `publishConfig.directory` from package manifests.

`publishConfig.directory: "dist"` causes `pnpm pack` to fail with
`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`. The `files` field already includes
`dist/`, so `publishConfig` only needs `access: public`. Shipped in 46b16fd
without a changeset — this one ensures the fix reaches npm on its own.
