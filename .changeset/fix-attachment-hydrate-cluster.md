---
"@oxpulse/chat-widget": minor
---

Attachment hydration cluster from the repo review council:

- final hydration failure now renders a styled placeholder
  (`[data-hydrate-failed='true']` selector was shipped without any CSS
  consumer — the PR #91 placeholder feature was a silent no-op);
- permanent 403/404/410 responses no longer burn 3 pointless authed
  retries before the direct-URL fallback (typed `AttachmentFetchError`
  carries the HTTP status);
- authed download / open-in-tab click handlers now thread the widget's
  `AbortSignal`, so a click resolving after `destroy()` no longer leaks a
  `blob:` URL;
- a new `oxpulse-chat:attachment-error` CustomEvent (deduped per
  attachment) fires on final hydration failure, documented in the README;
- hydration retry timing now reuses the shared `BackoffStrategy` instead
  of a third hand-rolled backoff curve.
