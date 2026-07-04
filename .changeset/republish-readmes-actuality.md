---
"@oxpulse/chat-sdk": patch
"@oxpulse/wire-codec": patch
"@oxpulse/chat-widget": patch
---

docs: republish so npm-displayed READMEs match shipped reality

npm serves a package's README from the tarball snapshot taken at publish time, so
the source-tree doc fixes do not reach npmjs.com until the next published version.
This patch bump republishes all three packages so their npm pages show current docs:

- chat-sdk: version badge 1.0.0 → 2.0.0; document the SEC-CR-001 downgrade-defense
  default-on behaviour + cryptoMode option; correct the batchAppend example (was
  documenting the internal snake_case wire DTO, not the exported camelCase
  BatchAppendItem — old example would not type-check); fix the error-code table
  (server_5xx → server_error, add the crypto-mode/unsupported codes); add the
  edited/deleted MessageRow fields; fix a dangling ../../LICENSE link.
- wire-codec: drop the stale "private: true / no publish pipeline" claims (the
  package is public on npm via the changesets+OIDC pipeline); document the 0xC9
  mesh-bundle-v1 API + magic byte.
- chat-widget: carry the CDN version/SRI/npm-install README fixes (already in the
  source tree) onto npm.
