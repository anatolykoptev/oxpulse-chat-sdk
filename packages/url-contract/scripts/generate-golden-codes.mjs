/**
 * generate-golden-codes.mjs — generate deterministic golden fixture.
 *
 * Produces packages/url-contract/fixtures/golden-codes.json:
 *   { group: [1000 x 10-char typed codes], opaque: [1000 x 22-char base64url] }
 *
 * Uses Mulberry32 PRNG (seed=0x12345678) instead of crypto.getRandomValues so
 * the fixture is deterministic and reproducible. The seeded PRNG is test-only —
 * production generators use crypto.getRandomValues exclusively.
 *
 * Used by W5.6 for Rust↔TS parity validation.
 *
 * Run: node packages/url-contract/scripts/generate-golden-codes.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ── Mulberry32 PRNG ───────────────────────────────────────────────────────────

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Constants (mirrors constants.ts) ─────────────────────────────────────────

const GROUP_LETTERS = 'GHJKLM';
const FULL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '0123456789';
const CHECKSUM_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 34 chars

const GROUP_LETTER_THRESHOLD = Math.floor(256 / GROUP_LETTERS.length) * GROUP_LETTERS.length; // 252
const FULL_LETTER_THRESHOLD = Math.floor(256 / FULL_LETTERS.length) * FULL_LETTERS.length; // 240
const DIGIT_THRESHOLD = Math.floor(256 / DIGITS.length) * DIGITS.length; // 250

// ── Seeded rejection sampling ─────────────────────────────────────────────────

function pickFromAlphabetSeeded(rng, alphabet, threshold) {
  let b;
  do {
    b = Math.floor(rng() * 256);
  } while (b >= threshold);
  return alphabet[b % alphabet.length];
}

// ── Luhn mod-34 checksum (mirrors checksum.ts) ───────────────────────────────

function computeChecksum(payload) {
  // payload = 'AAAA-0000' (9 chars, dash at index 4)
  // Strip the dash to get 8 chars for checksum
  const stripped = payload.replace('-', '');
  let factor = 2;
  let sum = 0;
  const n = CHECKSUM_ALPHABET.length; // 34

  for (let i = stripped.length - 1; i >= 0; i--) {
    const codepoint = CHECKSUM_ALPHABET.indexOf(stripped[i]);
    if (codepoint === -1) throw new Error(`invalid char in payload: ${stripped[i]}`);
    let addend = factor * codepoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }

  const remainder = sum % n;
  const checkCodepoint = (n - remainder) % n;
  return CHECKSUM_ALPHABET[checkCodepoint];
}

function generateGroupCode(rng) {
  const firstLetter = pickFromAlphabetSeeded(rng, GROUP_LETTERS, GROUP_LETTER_THRESHOLD);
  let restLetters = '';
  for (let i = 0; i < 3; i++) {
    restLetters += pickFromAlphabetSeeded(rng, FULL_LETTERS, FULL_LETTER_THRESHOLD);
  }
  let digits = '';
  for (let i = 0; i < 4; i++) {
    digits += pickFromAlphabetSeeded(rng, DIGITS, DIGIT_THRESHOLD);
  }
  const bare = `${firstLetter}${restLetters}-${digits}`;
  const checksum = computeChecksum(bare);
  return bare + checksum;
}

// ── Seeded base64url generation ───────────────────────────────────────────────

function generateOpaqueCode(rng) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(rng() * 256);
  }
  // URL-safe base64 without padding
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Generate 1000 of each ─────────────────────────────────────────────────────

const SEED = 0x12345678;
const rng = mulberry32(SEED);
const COUNT = 1000;

const group = [];
const opaque = [];

for (let i = 0; i < COUNT; i++) {
  group.push(generateGroupCode(rng));
}
for (let i = 0; i < COUNT; i++) {
  opaque.push(generateOpaqueCode(rng));
}

const fixture = { group, opaque };

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'fixtures', 'golden-codes.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

console.log(`Written: ${outPath}`);
console.log(`  group: ${group.length} codes, sample: ${group[0]}`);
console.log(`  opaque: ${opaque.length} codes, sample: ${opaque[0]}`);
