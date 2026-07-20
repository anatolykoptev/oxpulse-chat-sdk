/**
 * Tests for url-contract generators.ts — room code / ID generation.
 *
 * ADR-0005: heterogeneous room URLs.
 *   - generateRoomCode('group') → typed 10-char code (G-letter first + Luhn checksum)
 *   - generateRoomCode('1to1'|'burner'|'sealed') → opaque 22-char base64url
 *   - generateOpaqueRoomId() → opaque 22-char base64url (direct call)
 *
 * Port: web/src/lib/__tests__/roomcode-csprng.test.ts (W5.5).
 * Deviation: imports from @oxpulse/url-contract source modules instead of
 * web-internal paths. GROUP_FIRST_LETTERS comes from constants.js.
 * Adds round-trip tests: generated codes pass parseRoomCode + verifyChecksum.
 *
 * Plan: docs/superpowers/plans/2026-05-22-url-contract-extract-plan.md W5.5
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateRoomCode, generateOpaqueRoomId, messengerSafeBase64Url16 } from '../generators.js';
import { parseRoomCode } from '../parse.js';
import { verifyChecksum } from '../checksum.js';
import { GROUP_FIRST_LETTERS } from '../constants.js';

// 10-char typed code: 4 letters + '-' + 4 digits + 1 checksum char from [0-9A-HJ-NP-Z]
const TYPED_SHAPE_RE = /^[A-HJ-NP-Z]{4}-[0-9]{4}[0-9A-HJ-NP-Z]$/;
// 22-char opaque base64url: A-Z, a-z, 0-9, -, _
const OPAQUE_SHAPE_RE = /^[A-Za-z0-9_-]{22}$/;

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 chars
const DIGITS = '0123456789'; // 10 chars
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // 64 chars

// ── Shape invariant ───────────────────────────────────────────────────────────

describe('generateRoomCode(kind) — shape invariant (ADR-0005)', () => {
  it('group → 10-char typed code', () => {
    for (let i = 0; i < 250; i++) {
      const code = generateRoomCode('group');
      expect(code, `iteration ${i}`).toMatch(TYPED_SHAPE_RE);
      expect(code).toHaveLength(10);
    }
  });

  it('1to1 → 22-char opaque base64url', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateRoomCode('1to1');
      expect(id, `iteration ${i}`).toMatch(OPAQUE_SHAPE_RE);
      expect(id).toHaveLength(22);
    }
  });

  it('burner → 22-char opaque base64url', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateRoomCode('burner');
      expect(id, `iteration ${i}`).toMatch(OPAQUE_SHAPE_RE);
      expect(id).toHaveLength(22);
    }
  });

  it('sealed → 22-char opaque base64url', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateRoomCode('sealed');
      expect(id, `iteration ${i}`).toMatch(OPAQUE_SHAPE_RE);
      expect(id).toHaveLength(22);
    }
  });
});

describe('generateOpaqueRoomId() — shape invariant', () => {
  it('250 calls always match 22-char base64url shape', () => {
    for (let i = 0; i < 250; i++) {
      const id = generateOpaqueRoomId();
      expect(id, `iteration ${i}`).toMatch(OPAQUE_SHAPE_RE);
      expect(id).toHaveLength(22);
    }
  });
});

// ── First-letter encodes group type ──────────────────────────────────────────

describe('generateRoomCode(group) — first letter in GROUP_FIRST_LETTERS', () => {
  it('first letter is always in {G,H,J,K,L,M}', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode('group');
      expect(
        GROUP_FIRST_LETTERS.has(code[0]),
        `iteration ${i}: '${code[0]}' not in GROUP_FIRST_LETTERS`,
      ).toBe(true);
    }
  });
});

// ── Round-trip: generated group codes parse correctly ────────────────────────

describe('generateRoomCode(group) — round-trip via parseRoomCode', () => {
  it('100 generated group codes parse to kind=group', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode('group');
      const result = parseRoomCode(code);
      expect(result, `iteration ${i}: parseRoomCode(${code})`).not.toBeNull();
      expect(result!.kind).toBe('group');
    }
  });

  it('100 generated group codes pass verifyChecksum', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode('group');
      const result = verifyChecksum(code);
      expect(result.ok, `iteration ${i}: verifyChecksum(${code})`).toBe(true);
    }
  });
});

// ── Round-trip: generated opaque codes parse correctly ───────────────────────

describe('generateOpaqueRoomId() — round-trip via parseRoomCode', () => {
  it('100 generated opaque codes parse to kind=opaque', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateOpaqueRoomId();
      const result = parseRoomCode(id);
      expect(result, `iteration ${i}: parseRoomCode(${id})`).not.toBeNull();
      expect(result!.kind).toBe('opaque');
    }
  });
});

// ── Uniformity — typed group ──────────────────────────────────────────────────

describe('generateRoomCode(group) — uniformity', () => {
  it('no position-character bucket deviates from uniform by >2pp over 10_000 samples', { timeout: 30_000 }, () => {
    const N = 10_000;
    const kind = 'group' as const;

    // Positions 1-3 (rest letters after first): uniform over all 24 letters
    const restLetterCounts: number[][] = Array.from({ length: 3 }, () =>
      new Array(LETTERS.length).fill(0),
    );
    // Positions 5-8 (digits): uniform over 0-9
    const digitCounts: number[][] = Array.from({ length: 4 }, () =>
      new Array(DIGITS.length).fill(0),
    );

    for (let i = 0; i < N; i++) {
      const code = generateRoomCode(kind);
      // code = L L L L - D D D D C (10 chars, '-' at index 4)
      for (let pos = 1; pos < 4; pos++) {
        const ch = code[pos];
        const idx = LETTERS.indexOf(ch);
        expect(idx).toBeGreaterThanOrEqual(0);
        restLetterCounts[pos - 1][idx]++;
      }
      for (let pos = 5; pos < 9; pos++) {
        const ch = code[pos];
        const idx = DIGITS.indexOf(ch);
        expect(idx).toBeGreaterThanOrEqual(0);
        digitCounts[pos - 5][idx]++;
      }
    }

    const THRESHOLD_PP = 0.02;

    for (let pos = 0; pos < 3; pos++) {
      for (let c = 0; c < LETTERS.length; c++) {
        const pct = restLetterCounts[pos][c] / N;
        expect(
          Math.abs(pct - 1 / LETTERS.length),
          `rest letter pos ${pos + 1} char ${LETTERS[c]}: got ${restLetterCounts[pos][c]}`,
        ).toBeLessThan(THRESHOLD_PP);
      }
    }

    for (let pos = 0; pos < 4; pos++) {
      for (let d = 0; d < DIGITS.length; d++) {
        const pct = digitCounts[pos][d] / N;
        expect(
          Math.abs(pct - 1 / DIGITS.length),
          `digit pos ${pos} char ${DIGITS[d]}: got ${digitCounts[pos][d]}`,
        ).toBeLessThan(THRESHOLD_PP);
      }
    }
  });
});

// ── Uniformity — opaque (positions 0-20) ─────────────────────────────────────

describe('generateOpaqueRoomId() — uniformity (positions 0-20)', () => {
  it('no bucket deviates from uniform by >2pp over 5_000 samples (positions 0-20)', { timeout: 30_000 }, () => {
    // Position 21 is NOT tested here: 16 bytes = 128 bits → only 2 data bits
    // for the 22nd base64 char → only 4 possible values {A,Q,g,w}. Tested separately.
    const N = 5_000;
    const counts: number[][] = Array.from({ length: 21 }, () =>
      new Array(BASE64URL_CHARS.length).fill(0),
    );

    for (let i = 0; i < N; i++) {
      const id = generateOpaqueRoomId();
      for (let pos = 0; pos < 21; pos++) {
        const idx = BASE64URL_CHARS.indexOf(id[pos]);
        expect(idx, `pos ${pos} char '${id[pos]}' not in base64url`).toBeGreaterThanOrEqual(0);
        counts[pos][idx]++;
      }
    }

    const THRESHOLD_PP = 0.02;
    for (let pos = 0; pos < 21; pos++) {
      for (let c = 0; c < BASE64URL_CHARS.length; c++) {
        const pct = counts[pos][c] / N;
        expect(
          Math.abs(pct - 1 / BASE64URL_CHARS.length),
          `pos ${pos} char '${BASE64URL_CHARS[c]}': got ${counts[pos][c]}`,
        ).toBeLessThan(THRESHOLD_PP);
      }
    }
  });
});

// ── Padding invariant: position 21 ───────────────────────────────────────────

describe('generateOpaqueRoomId() — padding invariant (position 21)', () => {
  it('position 21 is always in {A, Q, g, w} (2 data bits from 128-bit input)', () => {
    // 16 bytes = 128 bits. 128 / 6 = 21 remainder 2. The 22nd base64 char
    // encodes only 2 bits (the remaining 2 bits from byte 15), always padded
    // to 6 bits with trailing zeros. Only 4 values are possible:
    //   00xxxxxx→ A (0), 01xxxxxx→ Q (16), 10xxxxxx→ g (32), 11xxxxxx→ w (48)
    const ALLOWED = new Set(['A', 'Q', 'g', 'w']);
    for (let i = 0; i < 500; i++) {
      const id = generateOpaqueRoomId();
      expect(
        ALLOWED.has(id[21]),
        `position 21 '${id[21]}' not in {A,Q,g,w}`,
      ).toBe(true);
    }
  });
});

// ── GROUP_FIRST_LETTERS parity invariant ─────────────────────────────────────

describe('GROUP_FIRST_LETTERS parity invariant', () => {
  it('TS constant equals documented {G,H,J,K,L,M} sorted', () => {
    const sorted = Array.from(GROUP_FIRST_LETTERS).sort().join('');
    expect(sorted).toBe('GHJKLM');
  });
});

// ── Messenger-safety: no -_ or _- adjacency ──────────────────────────────────

describe('generateOpaqueRoomId() — messenger-safe: no -_/_- adjacency', () => {
  /**
   * Prod incident fix: some messengers (Telegram, WhatsApp, Signal) apply
   * Markdown-style rendering to URLs in plain-text shares. `_..._` is parsed as
   * italic delimiters — an ID like `up-_4EU...` becomes `up-4EU...` (shorter,
   * invalid). The generator must never produce IDs with `-_` or `_-` adjacency.
   *
   * 5,000 draws — prob of seeing no `-_`/`_-` pair by chance over that many
   * samples with an unbiased generator is negligible (≈0.049% per position pair).
   */
  it('5000 draws never contain -_ or _- adjacency (messenger Markdown safety)', { timeout: 15_000 }, () => {
    for (let i = 0; i < 5_000; i++) {
      const id = generateOpaqueRoomId();
      expect(
        !id.includes('-_') && !id.includes('_-'),
        `iteration ${i}: id '${id}' contains -_ or _- (messenger Markdown safety invariant violated)`,
      ).toBe(true);
    }
  });
});

// ── messengerSafeBase64Url16 — shared helper ──────────────────────────────────
//
// These tests verify the shared 16-byte CSPRNG → base64url helper that all
// three minters (generateOpaqueRoomId, generateBurnerKey, generateJoinSecret)
// delegate to. Extracted per the 3rd-duplicate architecture trigger in CLAUDE.md.

describe('messengerSafeBase64Url16() — shape invariants', () => {
  it('returns a 22-char base64url string', () => {
    const s = messengerSafeBase64Url16();
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('position 21 is always in {A, Q, g, w} (2 trailing data bits from 128-bit input)', () => {
    const ALLOWED = new Set(['A', 'Q', 'g', 'w']);
    for (let i = 0; i < 200; i++) {
      const s = messengerSafeBase64Url16();
      expect(
        ALLOWED.has(s[21]!),
        `position 21 '${s[21]}' not in {A,Q,g,w}`,
      ).toBe(true);
    }
  });

  it('5000 draws never contain -_ or _- adjacency (messenger Markdown safety)', { timeout: 15_000 }, () => {
    for (let i = 0; i < 5_000; i++) {
      const s = messengerSafeBase64Url16();
      expect(
        !s.includes('-_') && !s.includes('_-'),
        `iteration ${i}: '${s}' contains -_ or _- (messenger Markdown safety invariant violated)`,
      ).toBe(true);
    }
  });

  it('5000 draws are all unique (no repeat from CSPRNG)', { timeout: 15_000 }, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      seen.add(messengerSafeBase64Url16());
    }
    expect(seen.size).toBe(5_000);
  });
});

// ── CSPRNG routing proof ──────────────────────────────────────────────────────

describe('generateOpaqueRoomId() — messenger-safety invariants', () => {
  it('never starts with "-" or "_" (operator-perceived url-ugliness — room `-wz9g…` on staging)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateOpaqueRoomId();
      const first = id.charAt(0);
      expect(first).not.toBe('-');
      expect(first).not.toBe('_');
    }
  });

  it('never ends with "-" or "_" (defense-in-depth — structurally impossible but checked anyway)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateOpaqueRoomId();
      const last = id.charAt(id.length - 1);
      expect(last).not.toBe('-');
      expect(last).not.toBe('_');
    }
  });

  it('never contains "-_" or "_-" adjacency (Telegram/WhatsApp markdown italic-strip)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateOpaqueRoomId();
      expect(id).not.toMatch(/-_/);
      expect(id).not.toMatch(/_-/);
    }
  });

  it('every char is in [A-Za-z0-9_-]', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateOpaqueRoomId();
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('CSPRNG routing proof', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generateRoomCode("group") throws when crypto.getRandomValues throws', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('crypto.getRandomValues deliberately disabled');
    });
    expect(() => generateRoomCode('group')).toThrow('crypto.getRandomValues deliberately disabled');
  });

  it('generateOpaqueRoomId() throws when crypto.getRandomValues throws', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('crypto.getRandomValues deliberately disabled');
    });
    expect(() => generateOpaqueRoomId()).toThrow('crypto.getRandomValues deliberately disabled');
  });
});
