# ADR Index — oxpulse-chat-sdk

Architecture Decision Records for the oxpulse-chat-sdk monorepo.

## ADRs

| ID | Title | Status | Date |
|---|---|---|---|
| [ADR-010](./ADR-010-intro-protocol-bounded-context.md) | intro-protocol as one bounded context | Accepted | 2026-07-19 |
| [ADR-011](./ADR-011-verify-session-id-cwe-208.md) | Fix CWE-208 timing oracle in verifySessionIdRedundancy | Accepted | 2026-07-19 |
| [ADR-012](./ADR-012-lexless-non-constant-time.md) | lexLess non-constant-time safe-because-public | Accepted | 2026-07-19 |
| [ADR-013](./ADR-013-intro-protocol-harden-and-base64url-consolidation.md) | intro-protocol crypto hardening + base64url consolidation | Accepted | 2026-07-19 |

## Conventions

- ADR numbering continues from the oxpulse-chat repo (ADR-0001 through ADR-0008 + SDK-001) to avoid collisions across the fleet.
- Each ADR follows the Michael Nygard template: Context, Decision, Status, Consequences.
- Security-relevant ADRs (crypto, auth, trust boundaries) cross-link to the relevant package's SECURITY.md.
