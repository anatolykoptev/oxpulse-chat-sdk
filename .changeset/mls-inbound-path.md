---
"@oxpulse/chat-sdk": minor
---

MLS inbound path: fetchAndProcessWelcomes + fetchAndProcessMessage.

The MLS provider could send (createGroup, addMember, removeMember) but could
not receive — processWelcome and processMessage had no production callers.
Two new public methods on MLSGroupManager close the gap:

- fetchAndProcessWelcomes(roomId): GETs pending Welcomes, processes each in
  order, acks on success only, retries on failure via server re-notification.
  Returns count applied.
- fetchAndProcessMessage(roomId, messageId): GETs a single protocol message
  by id and feeds it to processMessage.

Both GETs retry 429 and transient 5xx (502/503/504) with bounded exponential
backoff (Retry-After honoured and capped at 30s, otherwise 250ms doubling,
max 3 retries, jittered). A `mls_rate_limited` error code distinguishes
429 exhaustion from 5xx exhaustion (`server_error`).

Behaviour changes from the initial inbound-path implementation:

- **Ack only on success.** A Welcome that fails processing is no longer
  acked — the server re-delivers it and the next attempt may succeed (the
  KeyPackage may be sealed to a different pending one, or the private half
  has not been restored yet). A wrongly acked invite is silent and
  permanent; a stream of warnings is visible and bounded by the 7-day TTL.
  The `mls_welcome_no_matching_secret` warning code is replaced by
  `mls_welcome_processing_failed` (the error classification that coupled to
  an upstream ts-mls message string is removed).
- **processWelcome tries every pending KeyPackage.** The group creator
  picks key_packages[0] from the server's response, whose ordering is
  unspecified; if the directory returns newest-first while the local list
  is oldest-first, the creator seals to a key the client never tried. Now
  each pending KP is tried until one decrypts, and only the one that worked
  is consumed. This is a pre-existing bug, not something the inbound path
  introduced.
- **Retry-After capped at 30s.** An unbounded server-supplied sleep
  (Retry-After: 999999999) would park the room's inbound path in a
  setTimeout for ~31 years with nothing to cancel it — a denial-of-service
  on the client. The server is the adversary in this product's threat
  model; the cap prevents the abuse.
- **5xx retried.** A transient 502/503/504 on fetchAndProcessMessage is a
  permanently lost commit if not retried (the row expires after an hour,
  no catch-up endpoint). Now retried with the same bounded schedule as 429.

Also fixes #368: the base-URL derivation used
`keyPackageDirectoryUrl.replace('/keys', '')` which replaces the FIRST
occurrence anywhere — silently mangling URLs with `/keys` earlier in the
path. Now strips only a trailing `/keys` segment.

New `onWarning` callback on MlsProviderOptions / MLSGroupManager surfaces
non-fatal warnings (e.g. a Welcome that could not be processed) so SDK
consumers can inform the user. The error is also rethrown so the caller
can react.
