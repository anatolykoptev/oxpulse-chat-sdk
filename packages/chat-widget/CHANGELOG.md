# @oxpulse/chat-widget — Changelog

## [0.1.1] — 2026-05-19 — Security hardening (PR #1142 code review fixes)

### Security fixes (MAJOR)

- **M1** postMessage: `sendToParent()` no longer targets `'*'` — requires explicit parent
  origin via `setParentOrigin()`, set from `?origin=` query param on iframe load.
  Messages are dropped with a warning if origin is not initialised.
- **M2** postMessage: `onParentMessage()` now reads `?origin=` from iframe URL and
  rejects `MessageEvent` whose `event.origin` does not match — prevents adversarial
  init from untrusted frames.
- **M3** Callbacks wired: `onTokenExpired` and `onError` config callbacks now fire.
  `oxpulse-chat:token-expired` dispatched on JWT_EXPIRED; `oxpulse-chat:error` on all
  other errors (ORIGIN_NOT_ALLOWED, JWT_MALFORMED, etc.).
- **M4** Origin-match parity with `crates/sdk/src/origin_match.rs` (W1.1):
  - Case-insensitive matching
  - Subdomain wildcard (`*.example.com` bare or `https://*.example.com`) is https-only,
    single-level only
  - Port wildcard (`http://localhost:*`) requires actual port — no-port does NOT match
  - Malformed allowlist entries warn + deny (deny-loud)
- **M5** `aud_origins` missing → **default DENY** (was silent pass-through).
  Set `allowLegacyToken: true` on `WidgetConfig` to opt-in to pre-W1.1 token compat.
- **M6** iframe mode now creates a real sandboxed `<iframe>` inside the shadow root.
  `sandbox="allow-scripts allow-same-origin"` is enforced. `?origin=` query param
  included in iframe src for M1/M2 handshake.

### Minor improvements

- `decodeJwtPayload()` now checks the `exp` claim and throws `JWT_EXPIRED` if past.
- `refreshToken()` forces re-bootstrap even when JWT value is unchanged.
- `WidgetConfig.allowLegacyToken` (boolean, default false) added for legacy token compat.

---

## [0.1.0] — 2026-05-19 — Skeleton release

Skeleton для `<oxpulse-chat>` Custom Element + iframe embed mode.

### Added

- `<oxpulse-chat>` Custom Element (attributes: app-id, jwt, room-id, mode, theme, lang)
- Programmatic `mount(target, config)` API
- `defineElement()` для explicit registration
- iframe-mode + postMessage protocol (typed)
- Bootstrap origin check via JWT `aud_origins` claim
- `WidgetError` + `OriginNotAllowedError` typed error classes
- Type guards: `isParentMessage()` / `isIframeMessage()` — reject malformed payloads

### Not yet (planned W2.2)

- UI components (message list, composer, reactions)
- Theme system (CSS custom properties)
- Mobile-responsive layout
- a11y / keyboard nav
- Token refresh reconnect logic

### Threat model

- Origin allowlist enforced at bootstrap before any network call
- iframe sandbox attribute mandatory in iframe-mode (implemented in 0.1.1)
- JWT not client-side verified (relies on server enforcement)
- Port wildcard `http://localhost:*` allows all localhost ports in dev mode
