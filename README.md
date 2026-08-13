# OxPulse Chat SDK

Embeddable group chat for web applications. This monorepo contains multiple packages.

Package versions are not listed here — npm and each package's CHANGELOG are the source
of truth for what is current.

- **`@oxpulse/wire-codec`** — CBOR+zstd binary message codec for the OxPulse chat wire protocol
- **`@oxpulse/chat-sdk`** — core chat client: rooms, messages, SSE subscribe, E2EE, reactions, and member management
- **`@oxpulse/chat-widget`** — zero-third-party-dependency embeddable UI widget (Custom Element + iframe modes) built on top of `chat-sdk`. The CDN bundle is fully self-contained (`chat-sdk` inlined); the npm package declares `@oxpulse/chat-sdk` as a regular dependency. Available both via CDN (`https://cdn.oxpulse.chat/widget/<version>/index.js` — immutable, CORS `*`; see [docs/embedding.md](docs/embedding.md) for the versioned-path contract) and npm (`npm install @oxpulse/chat-widget`) — CDN `<script>` tag remains the primary embed path for zero-build pages.
- **`@oxpulse/crypto-primitives`** — X25519+HKDF+AEAD primitives, MessageEnvelope v2 codec (authenticated binding transcript), pairwise-seal, and public constant-time comparison helpers (`timingSafeEqual`, `timingSafePubkeyEqualB64u`).
- **`@oxpulse/url-contract`** — heterogeneous room URL contract: generators, parsers, brands (ADR-0005).
- **`@oxpulse/voice-core`** — voice capture/playback core shared by the widget.
- **`@oxpulse/intro-protocol`** (EXPERIMENTAL) — L2 introduction protocol as one bounded context: intro-crypto (X25519+HKDF+AEAD, constant-time pubkey comparison, session ID derivation), intro-wire (JSON+Zod wire codec), intro-safety-number (Signal-style safety number). Fixes CWE-208 timing oracle in `verifySessionIdRedundancy`. See [packages/intro-protocol/SECURITY.md](packages/intro-protocol/SECURITY.md).

## Documentation

- **[docs/integration.md](docs/integration.md)** — **start here**: environments and base URLs, the API contract, entities, getting credentials, the server-side mint, and where integrations usually fail
- **[docs/quickstart.md](docs/quickstart.md)** — integrate `@oxpulse/chat-sdk` into a web app: install, auth model, send/list/subscribe, E2EE, rooms
- **[docs/embedding.md](docs/embedding.md)** — drop-in `@oxpulse/chat-widget` with no framework: Custom Element attributes, events, iframe postMessage protocol, CSS theming

### Architecture

- **[docs/architecture/e2ee-model.md](docs/architecture/e2ee-model.md)** — the E2EE design: per-room serial decrypt chain, downgrade/poison-gate defense, durable replay guard, wire-codec brand boundary
- **[docs/architecture/threat-model.md](docs/architecture/threat-model.md)** — SDK-scoped threat model (server-as-adversary: downgrade, replay, message loss)

## Node.js version requirements

The workspace tooling (`pnpm`, scripts) requires **Node.js >= 22** (set in the root `package.json` `engines` field).

The published packages (`@oxpulse/wire-codec`, `@oxpulse/chat-sdk`, `@oxpulse/chat-widget`) declare **Node.js >= 18** — this is the real runtime floor for consumers. The two floors are intentional: workspace tooling wants modern Node.js features; published artifacts run in a wider range of environments.

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.
