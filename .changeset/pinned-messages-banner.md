---
'@oxpulse/chat-widget': minor
---

feat(chat-widget): pinned messages banner with carousel, pin/unpin action, and tap-to-scroll

Implements the UI layer for pinned messages on top of the existing SDK
pinMessage/unpinMessage/listPins API and the op:"pin"|"unpin" SSE
mutation events:

- PinnedBanner (ui/pinned-banner.ts): a new zero-dependency UI module
  mounted above the message list. Shows the current pinned message with
  preview text + "Pinned by {name}" meta. Carousel navigation when >1
  pin. Close button dismisses; a new pin re-shows. Preview text is
  resolved from the already-decrypted MessageList.#rows store
  (E2EE-consistent; off-window pins show a "Message not loaded"
  placeholder).

- SSE pin/unpin handling (#229): MessageList.#handleMutation now handles
  op:"pin"/op:"unpin" (was silently dropped). The pinnedBy field is
  forwarded through the element.ts SDK-to-widget bridge. The reconnect
  subscribeFn now wires onMutation (was undefined).

- Initial load (#230): listPins() is called on room mount to hydrate
  the banner with pre-existing pins.

- Pin/unpin action (#231): a pin button is added to each bubble footer,
  feature-detected on client.pinMessage/client.unpinMessage. Optimistic
  update + rollback on error.

- Tap-to-scroll (#232): clicking a pinned message preview scrolls to
  the source message and briefly highlights it.

- i18n (#235): 10 new keys for en + ru.

Closes #228, #229, #230, #231, #232, #233, #235.
