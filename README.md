# OxPulse Chat SDK

Embeddable group chat for web applications. This monorepo contains three packages:

- **`@oxpulse/wire-codec`** — binary message codec for the OxPulse chat wire protocol
- **`@oxpulse/chat-sdk`** — core chat client: connection management, message handling, and room lifecycle
- **`@oxpulse/chat-widget`** — ready-to-embed UI widget built on top of `chat-sdk`

See `docs/quickstart.md` — coming.

## Node.js version requirements

The workspace tooling (`pnpm`, scripts) requires **Node.js >= 22** (set in the root `package.json` `engines` field).

The published packages (`@oxpulse/wire-codec`, `@oxpulse/chat-sdk`, `@oxpulse/chat-widget`) declare **Node.js >= 18** — this is the real runtime floor for consumers. The two floors are intentional: workspace tooling wants modern Node.js features; published artifacts run in a wider range of environments.
