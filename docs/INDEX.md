# Documentation index

| Document | Description |
|---|---|
| [README](../README.md) | The packages in this monorepo, where to start, Node requirements and licence |
| [SECURITY](../SECURITY.md) | How to report a vulnerability privately |
| [CODE_OF_CONDUCT](../CODE_OF_CONDUCT.md) | Contributor Covenant Code of Conduct |
| [DEBT](DEBT.md) | Registry of stuck migrations and strangler-fig entries, such as the retired room namespace prefix |
| [REPORTS-EXTERNAL](REPORTS-EXTERNAL.md) | Index of plans and review reports kept outside this repository, one row per report |
| [ROADMAP](ROADMAP.md) | Wire-optimization roadmap: the layer model, what has shipped, the next phases and the magic-byte registry |
| [RUNBOOK-widget-cdn](RUNBOOK-widget-cdn.md) | Operations runbook for publishing and serving the widget CDN bundle |
| [adr/ADR-0005-heterogeneous-room-urls](adr/ADR-0005-heterogeneous-room-urls.md) | Decision on one URL contract for the five room kinds: 1:1 call, group call, burner chat, sealed chat and short link |
| [adr/ADR-0005-threat-model](adr/ADR-0005-threat-model.md) | Threat model for the room URL contract |
| [adr/ADR-010-intro-protocol-bounded-context](adr/ADR-010-intro-protocol-bounded-context.md) | Decision to treat the introduction protocol as one bounded context |
| [adr/ADR-011-verify-session-id-cwe-208](adr/ADR-011-verify-session-id-cwe-208.md) | Fix of the timing oracle in session-id redundancy verification |
| [adr/ADR-012-lexless-non-constant-time](adr/ADR-012-lexless-non-constant-time.md) | Why the lexicographic public-key comparison need not be constant time |
| [adr/ADR-013-intro-protocol-harden-and-base64url-consolidation](adr/ADR-013-intro-protocol-harden-and-base64url-consolidation.md) | Hardening of the introduction protocol crypto and consolidation of base64url handling |
| [adr/README](adr/README.md) | Index of the architecture decision records |
| [architecture/e2ee-model](architecture/e2ee-model.md) | The E2EE design: serial decrypt chain, downgrade defense, poison gate, replay guard and the invariants checklist |
| [architecture/threat-model](architecture/threat-model.md) | SDK-scoped threat model with the server treated as the adversary |
| [embedding](embedding.md) | Using the chat widget without a framework: Custom Element attributes, events, iframe protocol and theming |
| [integration](integration.md) | Start-here integration guide: environments, the API contract, entities, credentials and the server-side mint |
| [quickstart](quickstart.md) | Integrating the chat SDK into a web app: install, auth model, send, list, subscribe, E2EE and rooms |
| [server-contract](server-contract.md) | Notes on where the SDK and the server contract differ, such as the room visibility field |
| [CLAUDE](../CLAUDE.md) | Notes for coding agents: layout, the CI gate, the E2EE invariants and release rules |
| [CHANGELOG](../CHANGELOG.md) | Pointer to each package's generated changelog, plus pending changes |
| [CONTRIBUTING](../CONTRIBUTING.md) | Setup, the CI gate, changesets, commit style and pull-request expectations |
| [LICENSE](../LICENSE) | GNU Affero General Public License v3, the licence declared by every package |
| [RELEASING](../RELEASING.md) | The Changesets release flow, OIDC trusted publishing and the widget bootstrap step |
