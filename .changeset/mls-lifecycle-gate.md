---
"@oxpulse/chat-sdk": patch
---

Narrow the `ts-mls` peer range from `^2.0.0-rc.16` to `2.0.0-rc.16 || ^2.0.0`.

The caret form admits `2.0.0-rc.17`, `2.0.0-rc.99` and every later candidate —
measured, not assumed. Installing `@oxpulse/chat-sdk@3.5.0` therefore resolves
whichever release candidate happens to be newest at install time, for the
library that implements the MLS key schedule, while ts-mls 2.0.0 has been in RC
since 2026-01-15 across seventeen candidates with no stable release. The new
range admits exactly the candidate this SDK was tested against, plus the real
2.x once it ships, and nothing in between.

Consumers pinned to a later `2.0.0-rc.*` will need to move to `2.0.0-rc.16`.

One consequence worth stating rather than discovering: `^2.0.0` does not admit
`2.1.0-rc.1` either, because semver excludes pre-releases of a higher minor
unless the range names them. So "the real 2.x once it ships" means stable 2.x
only — a future `2.1.0-rc.*` will need this range widened deliberately, which
is the intended behaviour for a library implementing the key schedule.

Also adds `mls-provider-gate.test.ts`: a mutation-verified gate for the MLS
group lifecycle. Tests only — no runtime change.
