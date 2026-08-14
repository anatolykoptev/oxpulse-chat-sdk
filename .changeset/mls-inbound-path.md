---
"@oxpulse/chat-sdk": minor
---

MLS inbound path: fetchAndProcessWelcomes + fetchAndProcessMessage.

The MLS provider could send (createGroup, addMember, removeMember) but could
not receive — processWelcome and processMessage had no production callers.
Two new public methods on MLSGroupManager close the gap:

- fetchAndProcessWelcomes(roomId): GETs pending Welcomes, processes each in
  order, acks on success or on "no matching secret" (consumed KeyPackage),
  retries on transient failure via server re-notification. Returns count
  applied.
- fetchAndProcessMessage(roomId, messageId): GETs a single protocol message
  by id and feeds it to processMessage.

Both GETs retry 429 with bounded exponential backoff (Retry-After honoured,
otherwise 250ms doubling, max 3 retries, jittered). A new `mls_rate_limited`
error code distinguishes rate-limit exhaustion from other failures.

Also fixes #368: the base-URL derivation used
`keyPackageDirectoryUrl.replace('/keys', '')` which replaces the FIRST
occurrence anywhere — silently mangling URLs with `/keys` earlier in the
path. Now strips only a trailing `/keys` segment.

New `onWarning` callback on MlsProviderOptions / MLSGroupManager surfaces
non-fatal warnings (e.g. a Welcome whose KeyPackage was already consumed)
so SDK consumers can inform the user without the error being thrown.
