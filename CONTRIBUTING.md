# Contributing

Bug reports, fixes and focused features are welcome. For a larger change, open an issue first so the
approach can be agreed before you write it. Report a vulnerability privately, as described in
[SECURITY.md](SECURITY.md), not in an issue.

## Development

Node 24 and pnpm (the version in the root `packageManager` field). The published packages run on
Node 18 or newer, but the workspace tests need Web Locks, which CI asserts exist.

```sh
git clone https://github.com/anatolykoptev/oxpulse-chat-sdk.git
cd oxpulse-chat-sdk
pnpm install --frozen-lockfile
pnpm lint:manifests
pnpm build
pnpm --filter @oxpulse/chat-widget build:cdn
pnpm typecheck
pnpm test
```

These are the steps of `.github/workflows/preflight.yml` (arm64 runner); if they pass locally they
pass there. A pull request that changes only documents skips that job. `pnpm test:contract` runs the
SDK/server contract test in `e2e/`, and `pnpm --filter <package> stryker` runs mutation testing for
one package; neither is part of the gate.

## Changesets and commits

Every pull request that changes a package adds a changeset:

```sh
pnpm changeset
```

Choose the packages and the bump (`patch`, `minor`, `major`), commit the generated
`.changeset/*.md` with your change. Versions and each package's `CHANGELOG.md` are produced by the
"Version Packages" pull request; do not edit them or tag by hand. The full flow is in
[RELEASING.md](RELEASING.md).

Commit subjects follow Conventional Commits with the package as the scope, as in the history:
`fix(chat-sdk): ...`, `feat(url-contract): ...`, `docs: ...`, `ci: ...`.

## Pull requests

One concern per pull request. State what changed and how you tested it. A bug fix needs a test that
fails without it; a change to cryptographic, downgrade or replay-protection code must keep the
invariants in [docs/architecture/e2ee-model.md](docs/architecture/e2ee-model.md) and say which it
touches. Do not commit credentials, operator hostnames or personal data. Add new documents to
[docs/INDEX.md](docs/INDEX.md).
