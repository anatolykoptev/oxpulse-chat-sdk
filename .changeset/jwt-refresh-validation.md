---
'@oxpulse/chat-widget': patch
---

fix(chat-widget): validate refreshed JWT aud_origins in iframe mode (W2.2)

applyRefreshedToken in iframe.ts now re-validates the refreshed JWT
against the live session before swapping:

1. Decodes the new JWT (rejects malformed / expired tokens).
2. Compares aud_origins set against the original token's set
   (order-insensitive). Rejects if they differ — prevents a crafted
   refresh-token from silently re-scoping the session.

On validation failure, the live session is left untouched and an error
is relayed to the parent via postMessage.
