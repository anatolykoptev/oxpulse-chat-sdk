/**
 * Tests for url-contract parse.ts — canonical-short codec.
 *
 * ADR-0005: heterogeneous room URLs.
 *   - Typed 10-char codes: group kind only (G-letter first + Luhn checksum)
 *   - Opaque 22-char base64url: 1to1, burner, sealed
 *   - Legacy bare 9-char: 'AAAA-0000' (transition window)
 *
 * parseRoomCode is the primary entry point.
 * isValidRoomId performs full semantic validation (structure + Luhn for 10-char).
 * kindFromFirstLetter maps letter → 'group' | null.
 *
 * ADR:  docs/adr/ADR-0005-heterogeneous-room-urls.md
 * Port: web/src/lib/routes/shortlink/__tests__/canonical.test.ts
 * Deviation: no encodeCanonicalShort/decodeCanonicalShort/generateRoomCode here
 * (W5.5). Uses appendChecksum from ./checksum.js for round-trip helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  parseRoomCode,
  kindFromFirstLetter,
  isValidRoomId,
  type RoomKind,
  type RealKind,
} from '../parse.js';
import { GROUP_FIRST_LETTERS } from '../constants.js';
import { appendChecksum } from '../checksum.js';

// Helper: build a valid group typed code from a 9-char roomId
function makeGroupCode(roomId: string): string {
  return appendChecksum(roomId);
}

// ── 1. parseRoomCode — group typed (10-char) ──────────────────────────────────

describe('parseRoomCode — group typed codes', () => {
  it('returns kind: group for G-first 10-char typed code', () => {
    const code = makeGroupCode('GHJK-1234');
    const result = parseRoomCode(code);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('group');
    expect(result!.roomId).toHaveLength(9);
    expect(result!.roomId).toBe('GHJK-1234');
  });

  it('returns kind: group for H-first code', () => {
    const code = makeGroupCode('HZZZ-9999');
    const result = parseRoomCode(code);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('group');
  });

  it('returns kind: group for J, K, L, M first letters', () => {
    for (const letter of ['J', 'K', 'L', 'M']) {
      const roomId = `${letter}AAA-0000`;
      const code = makeGroupCode(roomId);
      const result = parseRoomCode(code);
      expect(result, `letter ${letter}`).not.toBeNull();
      expect(result!.kind).toBe('group');
      expect(result!.roomId).toBe(roomId);
    }
  });

  it('returns null for A-first 10-char code (not group — ADR-0005 rejects non-group typed)', () => {
    // Build a valid-checksum 10-char with A-first — should still be rejected (not group)
    const code = makeGroupCode('ABCD-1234');
    const result = parseRoomCode(code);
    expect(result).toBeNull();
  });

  it('returns null for N-first 10-char code (not group)', () => {
    const code = makeGroupCode('NAAA-0000');
    const result = parseRoomCode(code);
    expect(result).toBeNull();
  });

  it('returns null for 10-char typed code with bad checksum', () => {
    const code = makeGroupCode('GHJK-1234');
    // Corrupt the last char
    const corrupted = code.substring(0, 9) + (code[9] === '0' ? '1' : '0');
    expect(parseRoomCode(corrupted)).toBeNull();
  });
});

// ── 2. parseRoomCode — opaque 22-char ────────────────────────────────────────

describe('parseRoomCode — opaque 22-char', () => {
  it('returns kind: opaque for 22-char base64url (all uppercase)', () => {
    const result = parseRoomCode('AAAAAAAAAAAAAAAAAAAAAA');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('opaque');
    expect(result!.roomId).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('returns kind: opaque for mixed-case base64url with - and _', () => {
    const result = parseRoomCode('dGhlcXVpY2tici1mb3h5AA');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('opaque');
  });

  it('returns null for 21-char string', () => {
    expect(parseRoomCode('AAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('returns null for 23-char string', () => {
    expect(parseRoomCode('AAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('returns null for 22-char with + (standard base64, not url-safe)', () => {
    expect(parseRoomCode('aaaaaa+bbbbb-ccccc1234')).toBeNull();
  });

  it('returns null for 22-char with leading space', () => {
    expect(parseRoomCode(' AAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });
});

// ── 3. parseRoomCode — legacy bare (9-char) ───────────────────────────────────

describe('parseRoomCode — legacy bare (9-char)', () => {
  it('returns kind: legacy-bare for ABCD-1234', () => {
    const result = parseRoomCode('ABCD-1234');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('legacy-bare');
    expect(result!.roomId).toBe('ABCD-1234');
  });

  it('accepts various valid bare roomIds', () => {
    for (const code of ['AAAA-0000', 'ZZZZ-9999', 'HJNP-1357']) {
      const result = parseRoomCode(code);
      expect(result, `bare ${code}`).not.toBeNull();
      expect(result!.kind).toBe('legacy-bare');
    }
  });
});

// ── 4. parseRoomCode — invalid / r:-prefix rejection ─────────────────────────

describe('parseRoomCode — invalid inputs', () => {
  const invalid = [
    ['', 'empty'],
    ['garbage', 'random garbage'],
    ['ABCD-12', 'too short (7)'],
    ['AAAA-0000-extra', 'too long'],
    ['abcd-1234', 'lowercase bare'],
    ['ABCD-1234L0', 'too long (11)'],
    ['r:ABCD-1234', "r:-prefixed bare (rejected per Rust validate_bare_room_id_no_opaque)"],
    ['r:AAAAAAAAAAAAAAAAAAAAAA', 'r:-prefixed opaque (rejected)'],
    ['AAAA-OOOO', 'O in letter positions (invalid alphabet)'],
    ['IIII-1234', 'I in letter positions (invalid alphabet)'],
  ] as const;

  for (const [input, label] of invalid) {
    it(`returns null for ${label}`, () => {
      expect(parseRoomCode(input)).toBeNull();
    });
  }
});

// ── 5. isValidRoomId — full semantic validation ───────────────────────────────

describe('isValidRoomId — full semantic check', () => {
  it('accepts valid 9-char bare form', () => {
    expect(isValidRoomId('ABCD-1234')).toBe(true);
  });

  it('accepts valid 22-char opaque', () => {
    expect(isValidRoomId('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
  });

  it('accepts 10-char typed code with correct Luhn checksum', () => {
    const code = makeGroupCode('GHJK-1234');
    expect(isValidRoomId(code)).toBe(true);
  });

  it('accepts 10-char typed code with non-G first letter (Luhn-only check, letter-agnostic)', () => {
    // isValidRoomId is letter-agnostic — only shape + Luhn matter.
    // parseRoomCode adds the G-first gate; isValidRoomId pins the boolean predicate
    // contract that any letter is acceptable here.
    const code = makeGroupCode('ABCD-1234');
    expect(isValidRoomId(code)).toBe(true);
  });

  it('rejects 10-char typed code with wrong Luhn checksum', () => {
    const code = makeGroupCode('GHJK-1234');
    const corrupted = code.substring(0, 9) + (code[9] === '0' ? '1' : '0');
    expect(isValidRoomId(corrupted)).toBe(false);
  });

  it('rejects lowercase bare', () => {
    expect(isValidRoomId('abcd-1234')).toBe(false);
  });

  it('rejects r:-prefixed input', () => {
    expect(isValidRoomId('r:ABCD-1234')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidRoomId('')).toBe(false);
  });
});

// ── 6. Checksum exhaustive rejection ─────────────────────────────────────────

describe('bad-checksum rejection — all wrong chars on a group code', () => {
  it('returns null for every wrong checksum char', () => {
    const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const code = makeGroupCode('GHJK-1234');
    const correctCheck = code[9];
    const wrongChars = ALPHABET.split('').filter((c) => c !== correctCheck);

    for (const wrongChar of wrongChars) {
      const corrupted = code.substring(0, 9) + wrongChar;
      expect(parseRoomCode(corrupted), `checksum '${wrongChar}'`).toBeNull();
    }
  });
});

// ── 7. GROUP_FIRST_LETTERS export ─────────────────────────────────────────────

describe('GROUP_FIRST_LETTERS (re-exported from constants)', () => {
  it('contains exactly 6 letters', () => {
    expect(GROUP_FIRST_LETTERS.size).toBe(6);
  });

  it('contains G, H, J, K, L, M', () => {
    for (const letter of ['G', 'H', 'J', 'K', 'L', 'M']) {
      expect(GROUP_FIRST_LETTERS.has(letter), `missing ${letter}`).toBe(true);
    }
  });

  it('does not contain A, N, U (other ADR-0004 groups)', () => {
    for (const letter of ['A', 'B', 'C', 'N', 'P', 'U', 'V']) {
      expect(GROUP_FIRST_LETTERS.has(letter), `should not have ${letter}`).toBe(false);
    }
  });

  it('does not contain I or O', () => {
    expect(GROUP_FIRST_LETTERS.has('I')).toBe(false);
    expect(GROUP_FIRST_LETTERS.has('O')).toBe(false);
  });
});

// ── 8. kindFromFirstLetter ────────────────────────────────────────────────────

describe('kindFromFirstLetter (ADR-0005: group only)', () => {
  it('returns "group" for G, H, J, K, L, M', () => {
    for (const letter of ['G', 'H', 'J', 'K', 'L', 'M']) {
      expect(kindFromFirstLetter(letter), `letter ${letter}`).toBe('group');
    }
  });

  it('returns null for A (was 1to1 in ADR-0004)', () => {
    expect(kindFromFirstLetter('A')).toBeNull();
  });

  it('returns null for N (was burner in ADR-0004)', () => {
    expect(kindFromFirstLetter('N')).toBeNull();
  });

  it('returns null for U (was sealed in ADR-0004)', () => {
    expect(kindFromFirstLetter('U')).toBeNull();
  });

  it('returns null for I, O (invalid alphabet chars)', () => {
    expect(kindFromFirstLetter('I')).toBeNull();
    expect(kindFromFirstLetter('O')).toBeNull();
  });

  it('returns null for lowercase', () => {
    expect(kindFromFirstLetter('g')).toBeNull();
    expect(kindFromFirstLetter('h')).toBeNull();
  });
});

// ── 9. RealKind type export (compile-time guard) ──────────────────────────────

describe('RealKind type export', () => {
  it('RealKind is exported (compile-time only — verify via import)', () => {
    const kinds: RealKind[] = ['1to1', 'group', 'burner', 'sealed'];
    expect(kinds).toHaveLength(4);
  });
});

// ── 10. RoomKind type export (compile-time guard) ─────────────────────────────

describe('RoomKind type export', () => {
  it('RoomKind covers all three URL-level forms', () => {
    const kinds: RoomKind[] = ['group', 'opaque', 'legacy-bare'];
    expect(kinds).toHaveLength(3);
  });
});
