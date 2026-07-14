---
"@oxpulse/chat-widget": minor
---

reactions: heart-first quick-bar replaces the '+😀' button + two-step popover.

- Each bubble gets a heart button (outline/filled SVG) — hover-revealed on
  desktop, always visible on touch, focusable for keyboard/SR. A plain
  tap/click/Enter/Space instantly toggles ❤️ (add / remove / replace-to-heart
  via `#selectReaction`, reusing the existing optimistic-mutation +
  rollback-to-snapshot pattern). A ≥400ms press-and-hold (touch/pen) or a
  ≥400ms hover-intent on the button itself (mouse) or ArrowUp opens the full
  6-emoji `ReactionQuickBar` (renamed from `ReactionPicker`), which keeps its
  keyboard nav, per-emoji stagger-in / select-burst animation (reduced-motion
  gated), outside-dismissal, and shadow-host mount.
- Telegram/WhatsApp-style single-reaction replace, client-enforced against a
  Slack-model idempotent per-(user,emoji) server: selecting a second emoji
  while already owning one removes the old reaction then adds the new one
  (one pre-mutation snapshot, rollback on either leg's failure).
- Own-emoji marked in the bar (aria-pressed + accent ring); the heart button
  mirrors the same own/❤️ state and gets a one-shot pulse on a successful add.
- Bar placement (above/below flip, right-edge anchor for the caller's own
  messages) and long-press timing/gating, outside-dismissal (capture-phase
  pointerdown), and focus-restore (deferred to a microtask) are ported from
  oxpulse-chat web's prod, unit-tested primitives:
  `web/src/lib/chat/list/usePopover.svelte.ts`,
  `web/src/lib/chat/reactions/message-actions-helpers.ts::computePopoverPosition`,
  `web/src/lib/chat/reactions/MessageActions.svelte`'s dismissal pattern, and
  `web/src/lib/chat/list/Bubble.svelte`'s heart-pulse keyframe.
- Gated behind `reactionsEnabled` + `client.sendReaction`, same as before.
