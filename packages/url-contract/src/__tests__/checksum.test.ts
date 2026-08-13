/**
 * Tests for url-contract checksum.ts — Luhn mod-34 single-char checksum.
 *
 * Alphabet: '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ' (34 chars; no I, O)
 * The '-' separator is positional and excluded from the alphabet.
 *
 * ADR:  docs/adr/ADR-0005-heterogeneous-room-urls.md
 *
 * Port: verbatim from web/src/lib/routes/shortlink/__tests__/checksum.test.ts,
 * plus 100 deterministic fixture cases (W5.3 addition).
 */

import { describe, it, expect } from 'vitest';
import { appendChecksum, verifyChecksum, stripChecksum } from '../checksum.js';

// ── Seeded PRNG (mulberry32) — deterministic fixture generation ───────────────
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1. Identity: round-trip on a known code ───────────────────────────────────

describe('appendChecksum / verifyChecksum round-trip', () => {
  it('verifyChecksum(appendChecksum(payload)) returns { ok: true, payload }', () => {
    const payload = 'ABCD-1234';
    const withCheck = appendChecksum(payload);
    const result = verifyChecksum(withCheck);
    expect(result).toEqual({ ok: true, payload });
  });
});

// ── 2. Random round-trip: 1000 random AAAA-0000 codes ────────────────────────

describe('random round-trip (1000 codes)', () => {
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const DIGITS = '0123456789';

  function randomCode(): string {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let code = '';
    for (let i = 0; i < 4; i++) code += LETTERS[buf[i] % LETTERS.length];
    code += '-';
    for (let i = 4; i < 8; i++) code += DIGITS[buf[i] % DIGITS.length];
    return code;
  }

  it('append+verify reproduces original for 1000 random codes', () => {
    for (let i = 0; i < 1000; i++) {
      const payload = randomCode();
      const withCheck = appendChecksum(payload);
      const result = verifyChecksum(withCheck);
      expect(result, `failed on code: ${payload}`).toEqual({ ok: true, payload });
    }
  });
});

// ── 3. Single-char substitution detection ────────────────────────────────────
//
// For 100 random codes, for each of the 8 alphabet positions (4 letters + 4 digits),
// mutate to a different alphabet char. All mutations must be detected.
// Expected: 100 × 8 = 800 mutations detected (100%).

describe('single-char substitution detection', () => {
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 34 chars

  function randomCode(): string {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let code = '';
    for (let i = 0; i < 4; i++) code += LETTERS[buf[i] % LETTERS.length];
    code += '-';
    for (let i = 4; i < 8; i++) code += DIGITS[buf[i] % DIGITS.length];
    return code;
  }

  it('detects all 800 single-char substitutions across 100 random codes', () => {
    let detectedCount = 0;
    let totalMutations = 0;

    for (let trial = 0; trial < 100; trial++) {
      const payload = randomCode();
      const withCheck = appendChecksum(payload);

      // Positions in the 9-char string: 0-3 (letters), 4 is '-' (skip), 5-8 (digits)
      // Alphabet positions: chars at indices 0,1,2,3,5,6,7,8 — 8 alphabet positions
      const alphabetIndices = [0, 1, 2, 3, 5, 6, 7, 8];

      for (const pos of alphabetIndices) {
        const originalChar = withCheck[pos];
        // Pick a different char from the 34-char alphabet
        const altChars = ALPHABET.split('').filter((c) => c !== originalChar);
        const altChar = altChars[0]; // deterministic, just pick first different

        const mutated = withCheck.substring(0, pos) + altChar + withCheck.substring(pos + 1);
        const result = verifyChecksum(mutated);
        if (!result.ok) detectedCount++;
        totalMutations++;
      }
    }

    // Luhn mod-N detects all single substitutions by construction.
    expect(detectedCount).toBe(totalMutations);
    expect(totalMutations).toBe(800);
  });
});

// ── 4. Adjacent transposition detection (best-effort ≥95%) ───────────────────

describe('adjacent transposition detection (best-effort)', () => {
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const DIGITS = '0123456789';

  function randomCode(): string {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let code = '';
    for (let i = 0; i < 4; i++) code += LETTERS[buf[i] % LETTERS.length];
    code += '-';
    for (let i = 4; i < 8; i++) code += DIGITS[buf[i] % DIGITS.length];
    return code;
  }

  it('detects ≥95% of adjacent transpositions across 100 codes', () => {
    let detectedCount = 0;
    let totalCount = 0;

    for (let trial = 0; trial < 100; trial++) {
      const payload = randomCode();
      const withCheck = appendChecksum(payload);

      // Adjacent pairs in alphabet positions (skip '-' at index 4):
      // (0,1), (1,2), (2,3), (5,6), (6,7), (7,8) — 6 pairs
      // Also cross-dash is not a transposition (dash is fixed positional)
      const pairs = [
        [0, 1], [1, 2], [2, 3],
        [5, 6], [6, 7], [7, 8],
      ];

      for (const [i, j] of pairs) {
        const a = withCheck[i];
        const b = withCheck[j];
        // Only meaningful if the two chars are different
        if (a === b) continue;

        const chars = withCheck.split('');
        chars[i] = b;
        chars[j] = a;
        const transposed = chars.join('');
        const result = verifyChecksum(transposed);
        if (!result.ok) detectedCount++;
        totalCount++;
      }
    }

    const rate = detectedCount / totalCount;
    expect(rate, `detection rate ${rate.toFixed(3)} below 95%`).toBeGreaterThanOrEqual(0.95);
  });
});

// ── 5. Bad-shape rejection — no throw, always { ok: false } ──────────────────

describe('bad-shape rejection', () => {
  it('rejects "garbage"', () => {
    expect(verifyChecksum('garbage')).toEqual({ ok: false });
  });

  it('rejects "ABCD-1234" (no checksum — 9 chars, not 10)', () => {
    // Bare payload without appended checksum should fail (wrong length)
    expect(verifyChecksum('ABCD-1234')).toEqual({ ok: false });
  });

  it('rejects empty string', () => {
    expect(verifyChecksum('')).toEqual({ ok: false });
  });

  it('does not throw on any bad input', () => {
    const badInputs = ['', 'x', 'ABCD-1234', 'garbage', '!!!', 'A'.repeat(20)];
    for (const s of badInputs) {
      expect(() => verifyChecksum(s)).not.toThrow();
    }
  });
});

// ── 6. Output shape ───────────────────────────────────────────────────────────

describe('output shape', () => {
  const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  it('appendChecksum("ABCD-1234") produces a 10-char string', () => {
    expect(appendChecksum('ABCD-1234').length).toBe(10);
  });

  it('last char of appendChecksum output is from the 34-char alphabet', () => {
    const result = appendChecksum('ABCD-1234');
    const lastChar = result[result.length - 1];
    expect(ALPHABET.includes(lastChar)).toBe(true);
  });
});

// ── 7. Deterministic fixture cases (W5.3) — seeded PRNG, 100 cases ───────────
//
// 50 round-trip (pass) + 50 tampered (fail).
// PRNG seed fixed at 0xdeadc0de for full repeatability.

describe('deterministic fixture cases (W5.3)', () => {
  const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 34 chars
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';            // 24 chars
  const DIGITS = '0123456789';                            // 10 chars

  const rng = mulberry32(0xdeadc0de);

  function pickChar(alphabet: string): string {
    return alphabet[Math.floor(rng() * alphabet.length)];
  }

  /** Generate a deterministic 9-char payload 'AAAA-0000'. */
  function makePayload(): string {
    return (
      pickChar(LETTERS) +
      pickChar(LETTERS) +
      pickChar(LETTERS) +
      pickChar(LETTERS) +
      '-' +
      pickChar(DIGITS) +
      pickChar(DIGITS) +
      pickChar(DIGITS) +
      pickChar(DIGITS)
    );
  }

  /**
   * Mutate one char of a typed-10 code at a deterministic position.
   * Picks a char from ALPHABET that differs from the original.
   */
  function tamper(typed10: string): string {
    // Pick one of the 8 alphabet positions (skip '-' at index 4)
    const alphabetPositions = [0, 1, 2, 3, 5, 6, 7, 8, 9]; // include checksum char at 9
    const pos = alphabetPositions[Math.floor(rng() * alphabetPositions.length)];
    const original = typed10[pos];
    // Pick a different char
    const others = ALPHABET.split('').filter((c) => c !== original);
    const replacement = others[Math.floor(rng() * others.length)];
    return typed10.substring(0, pos) + replacement + typed10.substring(pos + 1);
  }

  it('50 deterministic round-trips: verifyChecksum(appendChecksum(payload)) → ok:true', () => {
    for (let i = 0; i < 50; i++) {
      const payload = makePayload();
      const typed10 = appendChecksum(payload);
      const result = verifyChecksum(typed10);
      expect(result, `fixture ${i}: payload=${payload}`).toEqual({ ok: true, payload });
    }
  });

  it('50 deterministic tampered codes: verifyChecksum → ok:false', () => {
    for (let i = 0; i < 50; i++) {
      const payload = makePayload();
      const typed10 = appendChecksum(payload);
      const mutated = tamper(typed10);
      // If tamper happened to produce the same char (degenerate), test is vacuous.
      // By construction rng picks a different char so this should never occur.
      if (mutated === typed10) continue; // safety skip, shouldn't happen
      const result = verifyChecksum(mutated);
      expect(result.ok, `fixture ${i}: mutated=${mutated} from typed=${typed10}`).toBe(false);
    }
  });
});

// ── stripChecksum (#344) ─────────────────────────────────────────────────────

describe('stripChecksum', () => {
  it('strips the checksum char from a 10-char code', () => {
    const payload = 'GHJK-1234';
    const withCheck = appendChecksum(payload);
    expect(withCheck).toHaveLength(10);
    expect(stripChecksum(withCheck)).toBe(payload);
  });

  it('is the inverse of appendChecksum', () => {
    for (let i = 0; i < 100; i++) {
      const payload = 'TEST-0000';
      const withCheck = appendChecksum(payload);
      expect(stripChecksum(withCheck)).toBe(payload);
    }
  });

  it('does NOT verify the checksum (returns payload even for bad checksum)', () => {
    // 'GHJK-1234X' has a wrong checksum char 'X' but stripChecksum still works
    expect(stripChecksum('GHJK-1234X')).toBe('GHJK-1234');
  });

  it('throws TypeError for wrong length', () => {
    expect(() => stripChecksum('GHJK-123')).toThrow(TypeError);
    expect(() => stripChecksum('GHJK-123456')).toThrow(TypeError);
  });

  it('throws TypeError for missing dash at index 4', () => {
    expect(() => stripChecksum('GHJK12345')).toThrow(TypeError);
  });
});
