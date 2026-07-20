/**
 * checksum.ts — weighted mod-34 single-char checksum.
 *
 * Alphabet: '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ' (34 chars)
 *   - Digits 0-9 (indices 0-9)
 *   - Uppercase letters A-Z excluding I and O (indices 10-33)
 *     This matches the room-code alphabet from roomcode.ts.
 * The '-' separator is positional and excluded from the alphabet.
 *
 * Algorithm: Luhn mod-N variant with weights alternating {1, 3} instead of {1, 2}.
 *
 *   Why not standard Luhn mod-34? Standard Luhn doubles values (weight=2) at odd
 *   positions. When N=34 (even), gcd(2, 34)=2 ≠ 1, so the doubling map is NOT
 *   injective: values v and v+17 are indistinguishable after doubling mod 34.
 *   Result: ~N/2 undetected single-substitution pairs — unacceptable for error detection.
 *
 *   Fix: use weight=3 instead of 2. gcd(3, 34)=1, so multiplication by 3 is injective
 *   mod 34. Both weights in the alternating scheme (1 and 3) are coprime to 34,
 *   guaranteeing that any single-position change produces a different checksum.
 *
 *   Reference: Luhn mod N — https://en.wikipedia.org/wiki/Luhn_mod_N_algorithm
 *   Coprimality requirement for full detection: Knuth, TAOCP Vol.2, §4.3.
 *
 * Properties:
 *   - Detects ALL single-character substitutions (100%) — proven by coprimality.
 *   - Detects MOST adjacent transpositions (≥95% empirically;
 *     some transpositions produce equal weighted sums mod 34).
 *
 * Input format for appendChecksum: 'AAAA-0000' (9 chars).
 * Output format: 'AAAA-0000C' (10 chars, C is the checksum char).
 *
 * Spec: docs/superpowers/specs/2026-05-19-routes-module-upgrade-design.md §shortlink/
 * Decision Q6: checksum lands before type-in-code redesign; validator stays
 * permissive of bare AAAA-0000 during transition.
 *
 * Port: verbatim from web/src/lib/routes/shortlink/checksum.ts (W5.3).
 * Deviation: CHECKSUM_ALPHABET is derived from DIGITS + FULL_LETTERS (imported from
 * ./constants.js) rather than a local literal — same 34-char value, different source.
 */

import { DIGITS, FULL_LETTERS } from './constants.js';

/** 34-char alphabet — matches roomcode.ts (no I, no O to avoid confusion with 1, 0). */
export const CHECKSUM_ALPHABET = DIGITS + FULL_LETTERS;

const N = CHECKSUM_ALPHABET.length; // 34

/** Map from char to its numeric value in the alphabet. */
const CHAR_VALUE = new Map<string, number>(
  CHECKSUM_ALPHABET.split('').map((c, i) => [c, i] as [string, number]),
);

/**
 * Extract the alphabet characters from a room-code-shaped string.
 * The '-' at index 4 is a positional separator — skip it.
 *
 * Input: exactly 9 chars ('AAAA-0000', the payload) or 10 chars ('AAAA-0000C',
 * the checksummed form). Other lengths return null — call sites always supply
 * 9 or 10 chars, so this serves as a belt-and-suspenders guard.
 *
 * Returns the alphabet chars as an array of numeric values,
 * or null if the length is wrong, the separator is missing, or any char
 * is not in the alphabet.
 */
function extractValues(s: string): number[] | null {
  if (s.length !== 9 && s.length !== 10) return null;
  const values: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (i === 4) {
      // Positional separator must be '-'
      if (ch !== '-') return null;
      continue;
    }
    const v = CHAR_VALUE.get(ch);
    if (v === undefined) return null;
    values.push(v);
  }
  return values;
}

/**
 * Compute the weighted mod-34 check digit for a sequence of values.
 *
 * Formula (Luhn mod-N variant with coprime weights):
 *   1. Alternate weights: rightmost value gets weight 3, next gets 1, then 3, etc.
 *      (weight 3 instead of standard Luhn's 2 — gcd(3,34)=1 ensures injectivity)
 *   2. Reduce weighted value: if weighted ≥ N, subtract N (same as standard Luhn mod-N).
 *   3. Sum all weighted values.
 *   4. Check digit = (N - (sum % N)) % N.
 *
 * The sequence passed here is the payload values WITHOUT the check digit.
 *
 * Transposition miss rate (~5%): with alternating weights {1, 3}, swapping
 * two adjacent positions a and b changes the weighted sum by 2·(b − a) mod 34.
 * Since gcd(2, 34) = 2, swaps where (b − a) ≡ 0 (mod 17) produce a zero delta
 * and are undetected — approximately 2/34 ≈ 5.9% of all adjacent-swap pairs.
 * This cannot be reduced to 0 while keeping 100% single-substitution detection:
 * that property requires gcd(weight, 34) = 1, and weight 3 is the smallest such
 * choice. Any weight with gcd(w, 34) = 1 will have the same undetected-swap
 * structure; the ~5% miss rate is a fundamental property of this alphabet size,
 * not a tunable parameter.
 */
function luhnCheckValue(values: number[]): number {
  let sum = 0;
  // Rightmost value gets weight 3 (the "doubled" position in standard Luhn,
  // but using 3 instead of 2 for injectivity mod 34).
  // Use (v * 3) % N — correct modular reduction (single subtract is wrong for v ≥ 23).
  let useWeight3 = true;
  for (let i = values.length - 1; i >= 0; i--) {
    // values is a local array of numbers we constructed; index is always in-bounds.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const v = values[i]!;
    sum += useWeight3 ? (v * 3) % N : v;
    useWeight3 = !useWeight3;
  }
  return (N - (sum % N)) % N;
}

/**
 * Append a single Luhn mod-34 checksum character to a room-code payload.
 *
 * @param payload - A 9-char room code in 'AAAA-0000' format.
 * @returns A 10-char string 'AAAA-0000C' where C is the checksum char.
 * @throws TypeError if payload is not a valid 9-char room-code shape.
 */
export function appendChecksum(payload: string): string {
  if (payload.length !== 9 || payload.charAt(4) !== '-') {
    throw new TypeError(`appendChecksum: expected 'AAAA-0000' shape, got: ${payload}`);
  }
  const values = extractValues(payload);
  if (!values) {
    throw new TypeError(`appendChecksum: payload contains invalid chars: ${payload}`);
  }
  const checkValue = luhnCheckValue(values);
  // checkValue is in [0, N-1] by construction — charAt returns '' only if out of bounds.
  return payload + CHECKSUM_ALPHABET.charAt(checkValue);
}

/**
 * Verify a checksummed room code and extract its payload.
 *
 * @param s - A 10-char string 'AAAA-0000C' (room code + checksum).
 * @returns { ok: true, payload: 'AAAA-0000' } on success,
 *          { ok: false } on bad shape, bad chars, or checksum mismatch.
 *          Never throws.
 */
export function verifyChecksum(s: string): { ok: true; payload: string } | { ok: false } {
  // Must be exactly 10 chars with '-' at index 4
  if (s.length !== 10 || s.charAt(4) !== '-') return { ok: false };

  const payload = s.substring(0, 9);
  const checkChar = s.charAt(9);

  const payloadValues = extractValues(payload);
  if (!payloadValues) return { ok: false };

  const expectedCheckValue = luhnCheckValue(payloadValues);
  // expectedCheckValue is in [0, N-1] by construction.
  const expectedCheckChar = CHECKSUM_ALPHABET.charAt(expectedCheckValue);

  if (checkChar !== expectedCheckChar) return { ok: false };

  return { ok: true, payload };
}
