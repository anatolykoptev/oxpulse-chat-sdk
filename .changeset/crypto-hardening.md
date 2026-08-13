---
"@oxpulse/crypto-primitives": minor
---

feat(crypto): harden crypto-primitives to 2026 industry standard

PQXDH hybrid key agreement (X25519 + ML-KEM-768), XChaCha20-Poly1305 with
key commitment, key zeroization, replay window in openMessage, KAT test
vectors (RFC 7748/5869/8032, NIST GCM), HKDF extract/expand split API,
dedup b64uDecodeBytes, noble deps upgrade.

8 issues closed (#280-#287). 151 tests, 85.5% mutation score, deep crypto
audit passed. Signal PQXDH spec compliance with F prefix + transcript salt.
