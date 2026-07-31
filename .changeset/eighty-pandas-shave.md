---
'@oxpulse/chat-widget': patch
---

fix(chat-widget): drop the regex lookbehind that made the bundle unparseable on WebKit

`ITALIC_RE` used a negative lookbehind for its Unicode word-boundary guard. A
regex literal is parsed when the module is parsed, before any of its code runs,
so on an engine without lookbehind support this was not a degraded markdown
renderer — it was a `SyntaxError` that aborted evaluation of the entire bundle.
The custom element never registered and every embed silently rendered nothing.

Lookbehind reached WebKit only in Safari 16.4, and every browser on iOS is
WebKit whatever its name, so this took the widget off all older iPhones and
older macOS Safari at once, with no console output beyond the parse error.

The guard is now a captured group re-emitted by the replacement, which keeps the
original behaviour: `_italic_` still renders, and Latin or Cyrillic
`snake_case` identifiers are still left alone.

Adds `src/__tests__/browser-syntax.test.ts`, which fails if a lookbehind appears
anywhere under `src/` — verified to go red against the previous regex.
