---
"@oxpulse/chat-sdk": major
"@oxpulse/chat-widget": minor
---

feat: roster avatar_url + display name end-to-end

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
