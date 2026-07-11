---
"@oxpulse/chat-sdk": minor
"@oxpulse/chat-widget": minor
---

feat: roster role badge (moderator/owner)

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
