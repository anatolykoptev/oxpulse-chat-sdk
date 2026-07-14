# @oxpulse/chat-widget — Changelog

## 0.5.0

### Minor Changes

- 779bf9f: feat: roster avatar_url + display name end-to-end

  `GET /api/sdk/roster` now returns an additive `avatars` map alongside `roster`.
  `fetchRoster` parses it and returns `Map<epid, RosterEntry>` (`{ displayName,
avatarUrl }`) instead of `Map<epid, string>`. `rosterDisplayName(map, epid)` is
  unchanged; new `rosterAvatar(map, epid): string | null`. The widget renders a
  leading avatar (image with an initials-circle fallback, deterministic color per
  epid) beside other writers' messages; own messages are unchanged.

  BREAKING (@oxpulse/chat-sdk): code reading the raw roster map value as a string
  must switch to `rosterDisplayName(map, epid)` / `rosterAvatar(map, epid)` (or read
  `.displayName` / `.avatarUrl`). The HTTP response is backward-compatible — the
  `roster` name map is unchanged and `avatars` is purely additive, so a widget
  built against the old response keeps working.

- 6c59dcb: feat: roster role badge (moderator/owner)

  `GET /api/sdk/roster` now returns an additive, sparse `roles` map alongside
  `roster`/`avatars` (only privileged members appear; a plain `member` is
  implied by absence). `fetchRoster` parses it into `RosterEntry.role?:
"moderator" | "owner"`; new `rosterRole(map, epid): PrivilegedRole |
undefined`. An unrecognised role string fails closed (no role, no badge).

  The widget renders a small badge ("mod" / "owner" by default) next to a
  privileged member's name for other writers' messages (own messages are
  unchanged, mirroring the avatar convention). New widget config option
  `roleLabels?: Record<string, string>` lets partners rebrand the badge text
  (e.g. `{ moderator: "Seller" }`) — presentation only, never client-side
  authorization.

  Fully additive and backward-compatible: a server response with no `roles`
  key (old engine) parses with `role` `undefined` on every entry, and the
  badge simply does not render.

- 601f154: W9: render product cards in the widget and wire them through the Composer.

  - Add `ProductMeta` type and `OxpulseChatElement.setProductCard(ref, meta)` API.
  - `Composer` forwards `productRef`/`productMeta` to `sendText`/`sendTextOptimistic`.
  - `MessageList` renders a clickable product card preview (image, title, price, link) when a row has `productRef` + `productMeta`.
  - Add i18n key `productViewAria` and theme CSS for `.oxp-bubble-product`.

### Patch Changes

- 98df8ff: Fix unbounded DOM/memory growth in the live message stream: `MessageList` now caps the live-streamed window at `MAX_LIVE_MESSAGES` (300), evicting the oldest messages — from internal bookkeeping and the DOM — once a live append crosses the cap. Previously every live message was appended with no eviction, so a visitor keeping a product-page tab open through a busy period (e.g. a high-traffic central chat room) accumulated unbounded DOM nodes.

  Eviction is two-tiered. While the user is pinned to the bottom, every live append trims to the 300-message soft cap — invisible to them, since they're not looking at the top. While scrolled up reading history, eviction is skipped up to a much higher hard ceiling (600) so an actively-reading visitor never gets content yanked out from under them mid-read; only a session that piles up 600+ messages while permanently scrolled away (the "walk away and never come back to bottom" case) gets trimmed down to that ceiling. Without the hard ceiling, that walk-away session was still genuinely unbounded — caught in review before merge.

  This is a safety cap on the live window only — full scroll-back virtualization (for paging through evicted history) is a separate future feature once "load older" pagination UI exists.

- 2597744: Fix self/other bubble alignment when no `self-uid` attribute is set: the widget now falls back to the JWT `sub` claim, so the visitor's own messages align right (messenger-standard) out of the box. An explicit `self-uid` attribute still wins. Display-side only — the server never trusts this value.
- Updated dependencies [779bf9f]
- Updated dependencies [6c59dcb]
  - @oxpulse/chat-sdk@3.0.0

## 0.4.1

### Patch Changes

- ddbab29: docs: republish so npm-displayed READMEs match shipped reality

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

- Updated dependencies [ddbab29]
  - @oxpulse/chat-sdk@2.0.1

## 0.4.0

### Minor Changes

- def28fc: feat(T18): widget roster consumption — display names for other writers

  - SDK: new `fetchRoster()` helper fetches `GET /api/sdk/roster` with SDK JWT
  - SDK: new `rosterDisplayName(roster, epid)` with 8-char short-form fallback
  - SDK: `SubscribeArgs.onRosterSignal` callback — fires on `type:"roster"` SSE signal
  - SDK: `mintNamedWriteToken` alg-pin guard — rejects tokens with alg≠EdDSA returned by the mint endpoint (defense-in-depth; server enforces EdDSA at exchange, client now enforces at receipt)
  - Widget: MessageList fetches roster on mount and re-fetches on `type:"roster"` SSE invalidation signals (100ms debounce)
  - Widget: element adapter now forwards `onRosterSignal` to `sdkClient.subscribe` (was silently dropped — the re-fetch end-to-end path was broken)
  - Widget: bubbles show roster display names for other writers; own messages show "You"
  - Widget: XSS-safe — roster names use textContent only, never innerHTML (SEC-CR-003 / FF3)
  - CI: FF6 alg-pin — `mintNamedWriteToken` rejects alg:none and alg:HS256 tokens (real production guard, red-on-revert)
  - CI: issuer-disjointness (FF5) — server-enforced invariant; client-side tautology removed; server tests own it

- 8d2d10f: feat(chat-widget): add a real i18n layer — wire the `lang` option through a locale table (en + ru)

  `lang` (constructor option / `lang` attribute, BCP-47) has been accepted since W2.1 but was
  never read for strings — every user-facing string was hardcoded English regardless of `lang`
  (`MessageList` even hardcoded `lang: config.lang ?? 'en'` internally, dropping the option's
  own value). oxpulse's userbase is heavily Russian-speaking (see the ITALIC_RE Cyrillic fix
  in this same package), so RU users saw an all-English widget.

  Adds `src/utils/i18n.ts`: a plain `Record<Locale, Record<LocaleKey, string>>` table (`en`
  source-of-truth + a fully-translated `ru`) + a `t(key, lang, params?)` lookup with `{name}`
  placeholder substitution and a `resolveLocale(lang?)` helper (`lang` → `navigator.language`
  prefix → `'en'`). No new dependency — the widget is zero-dependency by design and the CDN
  bundle is size-budgeted (`esbuild.cdn.mjs` FF-1 gate, 250 KB gzip); this adds ~2 KB gzip
  (52.4 KB → 54.4 KB), nowhere near the ceiling.

  Every hardcoded string across the widget's UI surface is now routed through `t()` /
  `resolveLocale()`, each class storing its own resolved `#lang` at construction (`lang?`
  optional everywhere, defaulting via `resolveLocale()`, so no existing construction call site
  breaks):

  - `MessageList` — tombstone, unseal-error (visible + aria, U2's screen-reader-only variant
    kept glyph-free), the bubble's composed `aria-label`, "You" sender label, "Add reaction" /
    "Reactions" group / reaction-count aria (RU gets correct 1/2-4/5+ grammatical plural forms,
    not just an English-style singular/plural split), attachment aria-labels (Image/Audio/
    File/Attachment-unavailable), and the list-error Retry button.
  - `Composer` — placeholder default (an explicit `placeholder:` option still wins), all
    aria-labels, Send button text, the empty/sending/over-limit hints, the character counter,
    and the error-chip Retry button.
  - `AttachmentPicker` — both aria-labels, the upload-progress `aria-valuetext`, the live-region
    announcements (uploading/uploaded/failed), the queue summary, and the retry/cancel controls.
  - `ReactionPicker` / `reaction-types.ts` — "Choose reaction" and the per-emoji aria-label map.
  - `Reconnector` — every banner state (session-expired, reconnecting w/ attempt count,
    connected, gave-up) and its action button + aria-label.
  - The element's "Chat loading…" placeholder.

  Left deliberately English: dynamic runtime error text (`Composer`'s error chip,
  `MessageList`'s list-error banner, the element's `#renderError`) — these render an
  `Error.message` from a thrown exception (network/SDK/server text), not authored UI copy we
  control; localizing them would mean translating arbitrary upstream error strings. Emoji
  glyphs, byte-size units (`KB`), and `HH:MM` time formatting are also left as-is — not prose.

  Regression: 465 pre-existing tests stay green (every EN string is byte-identical to what
  shipped before); default (no `lang`) behavior is unchanged. 51 new tests added: a RED→GREEN
  proof (`list-helpers.test.ts` fails against pre-wire-in `main` for every `lang:'ru'`
  assertion, passes after), `i18n.test.ts` (lookup/fallback/interpolation unit tests), and RU
  integration coverage across `MessageList`/`Composer`/`Reconnector`/`AttachmentPicker`/
  `reaction-types`.

- f06ed8b: feat(chat-widget): in-place token refresh via origin-pinned postMessage (no remount)

  `element.refreshToken(jwt)` no longer tears the widget down and rebuilds it to apply a
  fresh JWT. In **iframe mode** it now posts the new token to the LIVE iframe over an
  origin-pinned `postMessage` (`{ type: 'refresh-token', jwt }`) and the iframe swaps the
  session token IN PLACE — the SSE stream, scroll position and decrypt state survive, so
  there is no flicker, reconnect or lost scroll on a routine token rotation. When there is
  no live iframe to post to (inline mode, or the iframe is not yet ready) it gracefully
  falls back to the existing re-bootstrap path, so a refresh never silently no-ops. Inline
  mode still re-bootstraps by design: its `SDKChatClient` holds its JWT in a `readonly`
  field and can only be re-authed by reconstruction.

  **Security hardening (behavior change):** `sendRefreshTokenToIframe` no longer falls back
  to the `'*'` wildcard target origin. It now requires an EXPLICIT target origin (the
  resolved widget `baseUrl`, the same concrete origin the init path posts to); if none is
  available the bearer JWT is dropped with a `console.warn` rather than broadcast to any
  origin — mirroring `sendToParent`'s "never send with '\*'" (M1) discipline. The iframe-side
  receiver applies a `refresh-token` only from inside the existing fail-closed
  `onParentMessage` origin gate (M2), so a refresh-token from an unexpected origin is dropped.

  Bumped `minor` (→ `0.4.0`) rather than `patch`: this changes the refresh behavior consumers
  observe (no remount) and the `sendRefreshTokenToIframe` signature (an explicit origin is now
  required, no `'*'` default), so it sits outside the `^0.3.1` caret range and requires an
  explicit consumer opt-in.

### Patch Changes

- 29b5d83: fix(chat-widget): Unicode-aware ITALIC_RE word-boundary (Cyrillic snake_case) + drop dead postMessage helper

  `renderMarkdown`'s italic regex used a doubled-backslash character class `[\\w]` (= the literal set
  `{backslash, 'w'}`) instead of the `\w` word-char escape, disabling the word-boundary guard entirely —
  any snake*case-flanked underscore, e.g. `a_hi_b`, was wrongly wrapped in `<em>`. Fixed to a proper `\w`
  lookaround, then found that `\w` (no `/u` flag) only matches `[A-Za-z0-9*]` — Cyrillic letters aren't
word chars to JS regex, so a plain-`\w`fix is a no-op for Cyrillic snake_case (this SDK's primary
userbase is Russian-speaking):`тестовый*юзер*профиль`still wrongly italicized. Final fix uses`\p{L}\p{N}_`with the`/u`flag — Unicode-aware, verified for both ASCII and Cyrillic snake_case,
still italicizes a normal whitespace-bounded`\_word_`.

  Also deletes the dead `sendInitToIframe` postMessage helper (zero callers repo-wide, not re-exported,
  defaulted `targetOrigin` to `'*'` — contradicted the file's own M1 "never send with `*`" invariant).
  `element.ts` already hand-rolls its own safe inline init postMessage; this helper was stranded.
  `sendRefreshTokenToIframe` is untouched (rebuilt with an explicit origin in the upcoming U1 task).

- 85e5fdc: fix(chat-widget): render failed-decrypt messages with a distinct state (unsealError)

  `@oxpulse/chat-sdk`'s decrypt path already PRESERVES a message row whose `unseal()` call
  fails (`MessageRow.unsealError: 'replay' | 'auth' | 'unknown'`) instead of dropping it —
  but `MessageList` never read that marker, so a failed-decrypt row rendered as an empty
  message bubble, visually indistinguishable from a real one.

  `MessageList` now renders a distinct `.oxp-unseal-error` placeholder (a lock glyph + "This
  message couldn't be decrypted") in place of the empty body whenever `unsealError` is set,
  and the bubble's `aria-label` announces the same text instead of an empty string. A row
  with both `deletedAt` and `unsealError` set renders as the tombstone in both the visible
  body and the `aria-label` (priority matches the existing deleted-message precedent) so a
  screen reader never announces a different state than what's shown.

  Render-side only — does not touch `chat-sdk`'s unseal/decrypt logic.

- Updated dependencies [917c97a]
- Updated dependencies [ce7863f]
- Updated dependencies [78d7327]
- Updated dependencies [f3e9c7f]
- Updated dependencies [e3a31ed]
- Updated dependencies [def28fc]
  - @oxpulse/chat-sdk@2.0.0

## 0.3.1

### Patch Changes

- fix(ui): pin the composer to the bottom of the widget. The flex rule
  targeted `.oxp-message-list` (the inner list element) but the growing
  child is the `.oxp-message-list-wrapper` div (element.ts), which stayed
  at `flex-grow:0` and collapsed to content height — so the composer rode
  up under the last message, leaving dead space below on tall / mobile
  fullscreen hosts (e.g. /biz/demo at 390px). Added `flex:1` + column to
  the wrapper. CDN hotfix published as `widget/0.3.1/`; the pending T18
  roster changeset still lands the next minor (0.4.0).

## 0.3.0

### Minor Changes

- 8663ace: add allow-write (named-write) mode to chat widget (inline mode only)

  Adds `allowWrite` / `allow-write` config to `<oxpulse-chat>` and `mount()`. When
  enabled, the widget mints a named-write JWT from the host page's own backend
  (`writeMintEndpoint`) and renders a compose UI (input + send button) for
  `mode:'inline'` (shadow DOM). Without `allowWrite` the widget stays read-only
  (no behaviour change from previous releases).

  Note: `mode:'iframe'` named-write support is not yet implemented (W5). Setting
  `allowWrite:true` with `mode:'iframe'` logs a console warning and the compose UI
  is not shown.

  New `WidgetConfig` fields:

  - `allowWrite?: boolean` — enable named-write compose UI (default: false)
  - `writeMintEndpoint?: string` — URL of the host's named-write mint endpoint
  - `_mintNamedWriteToken?` — test-only injectable mint override

  New HTML attributes on `<oxpulse-chat>`:

  - `allow-write` (boolean)
  - `write-mint-endpoint` (string)

  New events on `<oxpulse-chat>`:

  - `oxpulse-chat:message-sent` — fires after a successful send `{ roomId, msgId }`
  - `oxpulse-chat:write-error` — fires on non-recoverable write failures

  New `WidgetErrorCode` values:

  - `WRITE_MINT_FAILED` — emitted when the write-token mint request fails
  - `WRITE_SEND_FAILED` — emitted via `oxpulse-chat:write-error` when a named-write send fails

  The write token is kept separate from the read JWT (different capability level).
  `allow-write` can be combined with `allow-anon-read` — the widget creates two SDK
  clients: one for reading (anon or authed JWT), one for writing (named-write JWT).

  Minimal host integration:

  ```html
  <oxpulse-chat
    app-id="YOUR_APP_ID"
    room-id="event-room-slug"
    allow-anon-read
    allow-write
    write-mint-endpoint="/api/oxpulse-write-token"
  >
  </oxpulse-chat>
  ```

  Backend mint endpoint shape:

  ```
  POST /api/oxpulse-write-token
  Body:    { room_id: string }
  Returns: { token: string }   // named-write SDK JWT from OxPulse group-grant-mint
  ```

### Patch Changes

- Updated dependencies [b04592b]
  - @oxpulse/chat-sdk@1.6.0

## 0.2.0

### Minor Changes

- 161abae: client-side anon-read: `mintAnonReadToken` + widget `allow-anon-read` mode

  **@oxpulse/chat-sdk**: adds `mintAnonReadToken(opts)` helper that POSTs to
  `/api/sdk/auth/anon-read-mint` and returns a short-lived read-only JWT.
  Throws `AnonReadMintError` (with `.code` and `.status`) on non-2xx responses.
  Both are exported from the package index.

  **@oxpulse/chat-widget**: adds `allow-anon-read` boolean attribute (presence =
  true) and `base-url` attribute to `<oxpulse-chat>`. When `allow-anon-read` is
  present and no `jwt` attribute is set, the widget automatically mints an anon
  token, mounts in read-only mode (composer hidden), and schedules a re-mint 30 s
  before the 300 s token expiry. When `jwt` is provided, the existing authed path
  is unchanged. Includes injectable `_mintAnonReadToken` DI hook for tests.

### Patch Changes

- Updated dependencies [161abae]
  - @oxpulse/chat-sdk@1.5.0

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
