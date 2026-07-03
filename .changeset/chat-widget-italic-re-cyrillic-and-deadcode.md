---
"@oxpulse/chat-widget": patch
---

fix(chat-widget): Unicode-aware ITALIC_RE word-boundary (Cyrillic snake_case) + drop dead postMessage helper

`renderMarkdown`'s italic regex used a doubled-backslash character class `[\\w]` (= the literal set
`{backslash, 'w'}`) instead of the `\w` word-char escape, disabling the word-boundary guard entirely —
any snake_case-flanked underscore, e.g. `a_hi_b`, was wrongly wrapped in `<em>`. Fixed to a proper `\w`
lookaround, then found that `\w` (no `/u` flag) only matches `[A-Za-z0-9_]` — Cyrillic letters aren't
word chars to JS regex, so a plain-`\w` fix is a no-op for Cyrillic snake_case (this SDK's primary
userbase is Russian-speaking): `тестовый_юзер_профиль` still wrongly italicized. Final fix uses
`\p{L}\p{N}_` with the `/u` flag — Unicode-aware, verified for both ASCII and Cyrillic snake_case,
still italicizes a normal whitespace-bounded `_word_`.

Also deletes the dead `sendInitToIframe` postMessage helper (zero callers repo-wide, not re-exported,
defaulted `targetOrigin` to `'*'` — contradicted the file's own M1 "never send with `*`" invariant).
`element.ts` already hand-rolls its own safe inline init postMessage; this helper was stranded.
`sendRefreshTokenToIframe` is untouched (rebuilt with an explicit origin in the upcoming U1 task).
