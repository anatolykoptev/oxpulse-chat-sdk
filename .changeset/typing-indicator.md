---
"@oxpulse/chat-widget": minor
"@oxpulse/chat-sdk": patch
---

Typing indicator UI + composer throttle (#120)

Add animated "X is typing…" footer to the chat widget, driven by SSE typing events.
The SDK layer (sendTyping, onTyping, SSE routing) was already implemented;
this adds the widget UI: typing-indicator component, 2s keystroke throttle in
the composer, i18n (en+ru), and CSS with prefers-reduced-motion support.
