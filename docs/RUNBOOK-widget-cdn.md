# Runbook: Widget CDN Operations

CDN root: `https://cdn.oxpulse.chat/widget/`
Served dir on host: `/home/krolik/deploy/krolik-server/files/cdn-oxpulse/widget/`
Caddy site config: `~/deploy/krolik-server/config/caddy/cdn.oxpulse.chat.caddy`

---

## 1. Re-run the manual publish (upgrade or patch)

Run from the `oxpulse-chat-sdk` repo root (requires Node >= 22 + pnpm):

```bash
# Build the CDN bundle (outputs to packages/chat-widget/dist-cdn/)
cd ~/src/oxpulse-chat-sdk
pnpm -F @oxpulse/chat-widget build:cdn

# Compute the SRI hash of the built file
openssl dgst -sha384 -binary packages/chat-widget/dist-cdn/index.js \
  | openssl base64 -A \
  | sed 's/^/sha384-/'

# Publish to the CDN host directory
VER=$(node -p "require('./packages/chat-widget/package.json').version")
DEST="/home/krolik/deploy/krolik-server/files/cdn-oxpulse/widget/${VER}"
mkdir -p "$DEST"
cp packages/chat-widget/dist-cdn/index.js "$DEST/"
cp packages/chat-widget/dist-cdn/zstd.wasm "$DEST/"

# Update the 'latest' convenience symlink
ln -sfn "${VER}" \
  /home/krolik/deploy/krolik-server/files/cdn-oxpulse/widget/latest

# Smoke-check
curl -sI "https://cdn.oxpulse.chat/widget/${VER}/index.js" \
  | grep -E "HTTP|content-type|cache-control|access-control"
```

Update the SRI hash in documentation after every publish:
- `packages/chat-widget/README.md`
- `docs/embedding.md` (two occurrences in the CDN section and the allow-write example)

---

## 2. Restore a version directory from the build artifact

If a version directory is accidentally deleted or corrupted, the built artifact
lives in the GitHub Actions build run or can be rebuilt from the tagged commit:

```bash
# Check out the release tag
git -C ~/src/oxpulse-chat-sdk checkout "v${VER}"

# Rebuild
pnpm -F @oxpulse/chat-widget build:cdn

# Copy (same steps as §1 above, skip the latest symlink update)
DEST="/home/krolik/deploy/krolik-server/files/cdn-oxpulse/widget/${VER}"
mkdir -p "$DEST"
cp packages/chat-widget/dist-cdn/index.js "$DEST/"
cp packages/chat-widget/dist-cdn/zstd.wasm "$DEST/"

# Return to main
git -C ~/src/oxpulse-chat-sdk checkout main
```

Verify the SRI hash matches the published documentation before announcing restore.

---

## 3. CSP → inline-wasm fallback

`zstd.wasm` is fetched by the bundle as a CORS sub-resource from the same
versioned CDN path. If the consumer page's CSP blocks the wasm fetch, the
widget falls back silently to uncompressed message framing — no error is
surfaced to the user, but bandwidth efficiency decreases.

To confirm whether the wasm loaded: open browser devtools → Network tab,
filter on `zstd.wasm`. Status 200 = compression active; blocked/missing =
fallback mode.

To force the fallback in tests (e.g. for a strict CSP environment):

```js
// Block the wasm fetch at the service worker or test intercept layer
// The widget detects the load failure and continues without zstd.
```

---

## 4. Incident class: Caddy admin-port collision kills CDN

**Symptom:** `cdn.oxpulse.chat` returns 502 or connection refused; Caddy
process exits or restarts in a crash loop.

**Root cause class:** Running `caddy run` (or `caddy start`) without
explicitly disabling the admin API causes it to bind `:2019` on localhost.
On the krolik box, another process or a prior Caddy instance may already
hold that port. The second `caddy run` will crash on startup.

**Prevention:** NEVER run `caddy run` with the default admin-listen on this
box. The production Caddy is managed via the systemd user unit
`caddy-cdn.service`. Do not start Caddy processes ad-hoc.

```bash
# Correct: operate via systemd
systemctl --user status caddy-cdn
systemctl --user restart caddy-cdn
journalctl --user -u caddy-cdn -n 50

# Check what holds :2019 before any manual caddy run
ss -tlnp | grep 2019

# If you must run caddy ad-hoc (e.g. config test), disable admin:
caddy run --config /path/to/caddy.json \
  --adapter caddyfile \
  --envfile /path/to/.env \
  2>/dev/null &
# or add to the Caddyfile: { admin off }
```

**Recovery if CDN is down:**
1. `systemctl --user status caddy-cdn` — check if unit crashed.
2. `journalctl --user -u caddy-cdn -n 100` — find the error.
3. Kill any rogue `caddy` process: `pkill -u krolik caddy`.
4. `systemctl --user start caddy-cdn`.
5. Smoke-check: `curl -sI https://cdn.oxpulse.chat/widget/latest/index.js`.
