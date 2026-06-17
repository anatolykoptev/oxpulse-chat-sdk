# Releasing oxpulse-chat-sdk

Releases use [Changesets](https://github.com/changesets/changesets) for
versioning and CHANGELOG generation, and npm's OIDC Trusted Publishing for
the actual publish step (no npm token required in CI).

---

## Contributor flow (every feature PR)

1. In your feature branch, run:

   ```sh
   pnpm changeset
   ```

   The interactive prompt asks which packages changed and whether the bump is
   `patch`, `minor`, or `major`. It writes a Markdown file under `.changeset/`.

2. Commit the generated `.changeset/<slug>.md` file together with your code
   changes and open a pull request.

3. Merge the PR into `main`.

That is all a contributor needs to do. Versioning and publishing happen
automatically.

---

## Automated two-phase release

### Phase 1 — Version PR

Every push to `main` triggers `.github/workflows/release.yml`. If there are
pending changesets, `changesets/action` opens (or force-updates) a
**"Version Packages"** pull request. That PR:

- bumps the `version` field in each affected `package.json`,
- generates `CHANGELOG.md` entries from the changeset descriptions,
- deletes the consumed `.changeset/*.md` files.

Versions and CHANGELOGs are generated automatically — do not edit them by
hand.

### Phase 2 — Publish

Merge the "Version Packages" PR. The workflow runs again; this time there
are no pending changesets, so `changesets/action` runs the publish command:

```sh
pnpm build && node scripts/release-npm-packages.mjs
```

The build step is required because `pnpm pack` (used in OIDC mode) does not
run `prepublishOnly`, so `dist/` must already exist before publishing.

The publish script:

- reads each package's local version from `package.json`,
- compares it against the npm registry version,
- publishes only packages where local > registry (safe to re-run),
- publishes in dependency order: `wire-codec` → `chat-sdk` → `chat-widget`.

---

## OIDC Trusted Publishing model

No `NPM_TOKEN` secret is stored anywhere. Instead:

- The GitHub Actions workflow holds `permissions.id-token: write`.
- `npm publish` exchanges the GitHub OIDC token with npm's trusted-publisher
  endpoint, which verifies that the publish comes from THIS workflow file in
  THIS repository.
- npm refuses OIDC publishes from forks or arbitrary workflows — the
  trusted-publisher configuration on npmjs.com names the exact repo + workflow.

Trusted publishers currently configured on npmjs.com (package → Publishing):

| Package | Repository | Workflow |
|---------|-----------|---------|
| `@oxpulse/wire-codec` | `anatolykoptev/oxpulse-chat-sdk` | `release.yml` |
| `@oxpulse/chat-sdk` | `anatolykoptev/oxpulse-chat-sdk` | `release.yml` |
| `@oxpulse/chat-widget` | not configured yet — see bootstrap step below |

---

## One-time manual step: bootstrap `@oxpulse/chat-widget`

> **Operator action required before `@oxpulse/chat-widget` can publish via CI.**

npm's trusted-publisher UI requires the package to already exist on the
registry before a trusted publisher can be added. `@oxpulse/chat-widget` has
never been published, so OIDC publishing will soft-skip it until this is done.

Steps (run once from a machine with an npm token):

```sh
# 1. Build first — prepublishOnly runs here for local publish
cd packages/chat-widget
npm run build

# 2. Publish manually with an npm token
NPM_TOKEN=<your-token> npm publish --access public
```

Then on npmjs.com:
- Go to package `@oxpulse/chat-widget` → Publishing → Trusted Publishers.
- Add: Repository `anatolykoptev/oxpulse-chat-sdk`, Workflow `release.yml`,
  Environment `release` (or leave blank).

After that, remove `@oxpulse/chat-widget` from `SOFT_PACKAGES_OIDC` in
`scripts/release-npm-packages.mjs` so failures are no longer soft-skipped.

---

## Manual publish (bypass changesets, e.g. after npm outage)

Trigger the workflow manually via GitHub Actions → Release → Run workflow,
or run locally in token mode:

```sh
NPM_TOKEN=<your-token> node scripts/release-npm-packages.mjs
```

The script is idempotent: it skips packages where local version equals the
registry version.

---

## Notes

- **GitHub Releases** are not auto-created by this pipeline. The custom OIDC
  publisher does not emit the `New tag: <name>@<version>` lines that
  `changesets/action` parses to create releases. npm publishes work correctly.
  GitHub Releases are a future follow-up.
- **Provenance attestation** (`--provenance`) requires a public source repo.
  Set `NPM_PROVENANCE=1` in the workflow after this repo goes public.
- **Do not run `changeset version` manually** unless you are debugging. Let
  the Version Packages PR do it — manual runs consume the changeset files and
  can produce duplicate or mis-ordered bumps.
