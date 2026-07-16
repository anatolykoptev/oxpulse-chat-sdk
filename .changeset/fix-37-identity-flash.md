---
"@oxpulse/chat-widget": patch
---

Fix pre-resolution identity flash — raw epids + grey initials for ~1-2s
until /roster resolves. Roster is now fetched in parallel with list()
and the first render waits for roster (or a 300ms timeout fallback)
before painting, so initial messages show display names immediately.
