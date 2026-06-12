# wire-codec bench results

Measured on Node.js 20, ARM 24 GB (krolik / Oracle Cloud AArch64).
Run: 

## Peer envelope size (full chat-msg envelopes)

| Payload | JSON (B) | CBOR (B) | zstd 0xC6 (B) | zstd vs JSON |
|---|---|---|---|---|
| chat-msg short (body=hi) | 174 | 152 | 73 | −58% |
| chat-msg medium (body ~50 chars) | 237 | 212 | 86 | −64% |
| chat-msg long-repeat (480 chars) | 667 | 643 | 101 | −85% |
| chat-typing | 180 | 158 | 79 | −56% |
| chat-receipt (1 target) | 240 | 214 | 102 | −58% |
| chat-receipt (10 targets) | 591 | 556 | 133 | −78% |
| msg + 32 B binary (ThumbHash) | 462 | 194 | 86 | −81% |

## Dict compression on chat message bodies (body bytes only, medium messages)

| Lang | n (medium) | JSON avg (B) | dictless avg (B) | dict avg (B) | dict vs JSON | dict vs dictless |
|---|---|---|---|---|---|---|
| RU | 40 | 40.4 | 49.4 | 27.9 | −31% | −44% |
| FA | 39 | 38.7 | 47.5 | 28.2 | −27% | −41% |
| EN | 40 | 26.0 | 34.3 | 22.8 | −12% | −34% |

EN note: Latin-script entropy is lower than Cyrillic/Arabic; JSON baseline is already tight (1 B/char).
Dict vs dictless saving (−34%) is the operative metric — without dict, short EN payloads expand from zstd frame overhead.

## Envelope-v2 (0xC8) vs v1 — RU short bodies (n=50 full envelopes)

| Format | Avg size (B) | vs JSON |
|---|---|---|
| JSON | 204.3 | — |
| v1 dictless (0xC6) | 181.8 | −11% |
| v1 dict (0xC7) | 179.4 | −12% |
| v2 dictless (0xC8, dict-id=0) | 157.9 | −23% |
| v2 dict (0xC8, dict-id=1) | 139.1 | −32% |

v2 encodes UUID id as 16 raw bytes (vs 36-char hex) and ts as delta from room epoch — shaves ~37 B per envelope vs v1.
