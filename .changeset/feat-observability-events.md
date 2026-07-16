---
"@oxpulse/chat-widget": minor
---

Host-visible observability events from the review council (observability lens):

- new `oxpulse-chat:decrypt-error` CustomEvent (deduped once per msgId per
  widget lifetime) fires when a row carrying an `unsealError` is rendered,
  with detail `{roomId, msgId, seq, reason}` where reason is chat-sdk's
  classifyUnsealError class `'replay' | 'auth' | 'unknown'` — a
  replay-attack signature and a benign timeout are no longer
  indistinguishable to the host;
- new `oxpulse-chat:reconnect-exhausted` CustomEvent fires when the
  Reconnector gives up after MAX_ATTEMPTS (10) retries, with detail
  `{roomId, attempts}` — a permanently-dead room is no longer invisible to
  host monitoring (contrast `oxpulse-chat:token-expired` which fires on
  auth expiry; this is the network-exhaustion counterpart);
- README Events section backfilled with the previously-undocumented
  `oxpulse-chat:write-error` and `oxpulse-chat:message-sent` events plus
  the two new events, and an events reference table.
