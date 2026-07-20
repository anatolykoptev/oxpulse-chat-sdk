/**
 * SEC-CR-001 cross-language canonicalizer conformance — TS side.
 *
 * The 9-char canonical room key is produced on BOTH sides of the wire:
 *   - server: `normalize_room_key` (crates/signaling/src/rooms_join.rs)
 *   - client: `parseRoomCode(input)?.roomId` (this package — the value that
 *     becomes the room_token `room` claim / SFU `/sfu/ws/{room}` segment / cache
 *     key after a group code is parsed by the route loader).
 *
 * The signaling SFU verifies `claims.room == room_id` by EXACT match. A one-
 * sided drift between these two producers makes fresh-client group joins fail
 * that match → the group call silently dies. Agreement was convention-only;
 * this fixture makes it a test on both sides.
 *
 * The SAME JSON fixture is consumed by the Rust test
 * crates/signaling/src/rooms_tests.rs::normalize_room_key_matches_cross_language_fixture (asserts `normalize_room_key`),
 * mirroring the room-id-cases.json / room_id_contract.rs cross-language pattern.
 *
 * Class: kind-carrier lost in canonicalization (group-call SFU collapse fix).
 *
 * Vitest: cd packages/url-contract && node_modules/.bin/vitest run canonicalize-contract
 */

import { describe, it, expect } from 'vitest';
import { parseRoomCode } from '../parse.js';
import fixture from '../__fixtures__/canonicalize-cases.json' with { type: 'json' };

interface SharedRow {
  input: string;
  expected: string;
}
interface DivergentRow {
  input: string;
  rust_expected: string;
  ts_parse_is_null: boolean;
}

const shared = fixture.shared_agreement as SharedRow[];
const divergent = fixture.divergent as DivergentRow[];

describe('SEC-CR-001 canonicalizer conformance — TS parseRoomCode', () => {
  it('fixture has the load-bearing rows (regression guard against empty vectors)', () => {
    // A truncated fixture would make the loop bodies vacuously pass.
    expect(shared.length).toBeGreaterThanOrEqual(4);
    expect(divergent.length).toBeGreaterThanOrEqual(3);
    // At least one typed-10 group code and one r:-prefixed divergent vector.
    expect(shared.some((r) => r.input.length === 10)).toBe(true);
    expect(divergent.some((r) => r.input.startsWith('r:'))).toBe(true);
  });

  it.each(shared)(
    'shared_agreement: parseRoomCode("$input").roomId === "$expected"',
    ({ input, expected }) => {
      const parsed = parseRoomCode(input);
      expect(parsed, `parseRoomCode(${input}) must not be null for a shared-agreement vector`).not.toBeNull();
      expect(parsed!.roomId).toBe(expected);
    },
  );

  it.each(divergent)(
    'divergent: parseRoomCode("$input") is null where ts_parse_is_null',
    (row) => {
      if (row.ts_parse_is_null) {
        expect(
          parseRoomCode(row.input),
          `parseRoomCode(${row.input}) must be null (client rejects this form by design; the server-side normalize_room_key produces "${row.rust_expected}")`,
        ).toBeNull();
      } else {
        // Not currently exercised, but pins the column meaning if a future row sets it false.
        expect(parseRoomCode(row.input)?.roomId).toBe(row.rust_expected);
      }
    },
  );
});
