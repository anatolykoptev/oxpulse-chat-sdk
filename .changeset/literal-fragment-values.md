---
"@oxpulse/url-contract": minor
---

Fragment values are carried literally, end to end.

`buildCall1to1Url` and `buildBurnerChatUrl` no longer `encodeURIComponent` the
fragment payload, and `parseRoomUrl`, `parseCallFragment`, `parseBurnerFragment`
and `parseRoomFragment` no longer decode it. Percent-encoding stays on the path
components (`roomId`, short-link alias), where it belongs.

0.3.0 decoded on parse but encoded on build, which round-tripped — but the
decode step also normalised two distinct fragments onto one value (`a%2Eb.c` and
`a.b.c` both yielded the secret `a.b`), and rejected a whole fragment on a
malformed escape (`k=%` → null). For a fragment carrying a join secret and the
expected host pubkey — the latter compared against the host's actual key — that
normalisation is a property the verification step never asked for. Reported as
#354 with a 12-input differential against the oxpulse-chat implementations these
parsers mirror; those return literal payloads, and now so do these.

The contract narrows accordingly: a fragment value must already be URL-safe.
base64url (RFC 4648 §5) and hex both are, which is what the builders document.
A value containing a space or `/` no longer survives the round-trip, where the
old encode/decode pair carried it.

Also ships the cross-language contract fixtures — `src/__fixtures__/` and
`fixtures/` join `files`, so a consumer can assert against the published artifact
instead of vendoring a copy that silently drifts (#334).
