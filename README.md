# OxPulse Chat SDK

Embeddable group chat for web applications. This monorepo contains three packages:

- **`@oxpulse/wire-codec`** v0.3.1 — CBOR+zstd binary message codec for the OxPulse chat wire protocol
- **`@oxpulse/chat-sdk`** v1.3.0 — core chat client: rooms, messages, SSE subscribe, E2EE, reactions, and member management
- **`@oxpulse/chat-widget`** v0.1.0 — zero-dependency embeddable UI widget (Custom Element + iframe modes) built on top of `chat-sdk`

## Documentation

- **[docs/quickstart.md](docs/quickstart.md)** — integrate `@oxpulse/chat-sdk` into a web app: install, auth model, send/list/subscribe, E2EE, rooms
- **[docs/embedding.md](docs/embedding.md)** — drop-in `@oxpulse/chat-widget` with no framework: Custom Element attributes, events, iframe postMessage protocol, CSS theming

## Node.js version requirements

The workspace tooling (`pnpm`, scripts) requires **Node.js >= 22** (set in the root `package.json` `engines` field).

The published packages (`@oxpulse/wire-codec`, `@oxpulse/chat-sdk`, `@oxpulse/chat-widget`) declare **Node.js >= 18** — this is the real runtime floor for consumers. The two floors are intentional: workspace tooling wants modern Node.js features; published artifacts run in a wider range of environments.

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.
