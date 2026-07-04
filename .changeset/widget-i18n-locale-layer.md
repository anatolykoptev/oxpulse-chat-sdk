---
"@oxpulse/chat-widget": minor
---

feat(chat-widget): add a real i18n layer — wire the `lang` option through a locale table (en + ru)

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
