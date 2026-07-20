/**
 * Tests for url-contract room-ns.ts — the single-authority client-side room
 * segment helper.
 *
 * HISTORY. The `r:` SFU namespace prefix was once applied to typed group codes
 * so group/SFU rooms keyed `r:<code>` while 1to1 / burner / sealed / legacy-bare
 * rooms keyed BARE. That separation is now DEAD: group (10-char Luhn) and opaque
 * (22-char base64url) and legacy-bare (9-char) codes occupy disjoint keyspaces by
 * construction, and the SFU's room decision is count-driven, not prefix-driven.
 * The live `oxpulse_chat_room_join_total` metric carries no `prefixed_r` series —
 * no production join ever depended on the prefix for separation.
 *
 * CONTRACT NOW: namespaceRoomSegment returns the room code BARE for EVERY shape —
 * typed group, opaque 22-char, legacy-bare 9-char, and any unrecognised form. The
 * `r:` prefix is retired client-side. Because PR #1932 collapsed all four web-side
 * call-WS writers (signaling.ts, signaling-group.ts, useGroupCall.svelte.ts,
 * kind-resolver) onto this one authority, the retirement propagates everywhere
 * from this single function.
 *
 * BACKWARD-COMPAT (do not delete the server strip): the Rust server still ACCEPTS
 * a stale client's `r:<code>` — `validate_room_id` strips a leading `r:` and
 * `normalize_room_key` (PR #1934) collapses `r:<bare>` ⇄ `<bare>` into one room.
 * `ROOM_NS_GROUP` ('r:') is retained as the TS source of truth for that literal so
 * the eventual server-strip removal references one shared constant. The
 * `ROOM_NS_GROUP` test below DOCUMENTS that the server-side accept path still
 * exists — keep it until the `prefixed_r` join metric drains to zero over a full
 * SW-cache cycle (docs/DEBT.md D8).
 *
 * ADR-0005: docs/adr/0005-heterogeneous-room-urls.md
 */

import { describe, it, expect } from 'vitest';
import { generateRoomCode, generateOpaqueRoomId } from '../generators.js';
import { namespaceRoomSegment, ROOM_NS_GROUP } from '../room-ns.js';

describe('namespaceRoomSegment — client returns BARE for all shapes (`r:` retired)', () => {
  it('typed group code (10-char, G-first) → BARE, no r: prefix', () => {
    const group = generateRoomCode('group'); // 10-char, G-first, Luhn-valid
    expect(namespaceRoomSegment(group)).toBe(group);
  });

  it('opaque 22-char code (burner / 1:1 / sealed) → BARE, no r: prefix', () => {
    const opaque = generateOpaqueRoomId(); // 22-char base64url
    expect(namespaceRoomSegment(opaque)).toBe(opaque);
  });

  it('legacy-bare 9-char code → BARE, no r: prefix', () => {
    const legacy = 'GHJK-1234'; // G-first but 9-char (no checksum) → legacy-bare
    expect(namespaceRoomSegment(legacy)).toBe(legacy);
  });

  it('unrecognised shape → BARE (safe default)', () => {
    expect(namespaceRoomSegment('not-a-room')).toBe('not-a-room');
  });

  it('an already-`r:`-prefixed string → returned verbatim (never double-prefixes, never strips)', () => {
    // The client no longer parses to gate; it returns input verbatim. The server
    // owns the strip. A caller that somehow holds an `r:` string still emits it
    // unchanged — the server normalize_room_key collapses it (PR #1934).
    const group = generateRoomCode('group');
    expect(namespaceRoomSegment('r:' + group)).toBe('r:' + group);
  });

  it('REGRESSION GUARD: never prepends the `r:` prefix to any shape', () => {
    // Source-level invariant: the retirement must hold for every kind. If a
    // future edit reintroduces the prefix, this fails for at least one shape.
    const group = generateRoomCode('group');
    const opaque = generateOpaqueRoomId();
    const legacy = 'GHJK-1234';
    for (const code of [group, opaque, legacy, 'not-a-room']) {
      const out = namespaceRoomSegment(code);
      expect(out.startsWith('r:')).toBe(false);
      expect(out).toBe(code); // returned verbatim, length unchanged
    }
  });
});

describe('ROOM_NS_GROUP — server-side accept path still exists (backward-compat marker)', () => {
  // This test is INTENTIONALLY retained after the client retired the prefix.
  // It documents that the literal still mirrors the Rust server's `ROOM_NS_GROUP`
  // in crates/signaling/src/handler.rs, where the accept/strip path lives until
  // the `prefixed_r` join metric drains (docs/DEBT.md D8). Do NOT delete this
  // test — its survival is what stops a premature removal of the server strip.
  it('exports ROOM_NS_GROUP as the `r:` literal (mirrors Rust ROOM_NS_GROUP, server still strips it)', () => {
    expect(ROOM_NS_GROUP).toBe('r:');
  });
});
