/**
 * room-ns.ts — single authority for the client-side SFU room segment (ADR-0005).
 *
 * HISTORY. The signaling stack once ran two room namespaces: group/SFU rooms
 * joined under an `r:<code>` key while 1to1 / burner / sealed / legacy-bare
 * rooms joined BARE. The `r:` prefix was meant to keep the two keyspaces from
 * colliding when the same code was reused.
 *
 * That separation is now DEAD. Group and non-group codes occupy disjoint
 * keyspaces by construction (ADR-0005: typed group codes are 10-char G-first
 * Luhn-valid; opaque codes are 22-char base64url; the two can never collide).
 * The SFU's room/mode decision is count-driven, not prefix-driven
 * (crates/sfu-edge `mode_decision.rs:52`). Live metrics confirm it:
 * `oxpulse_chat_room_join_total{kind="prefixed_r"}` reads zero — no production
 * join has ever depended on the prefix for separation.
 *
 * THIS FUNCTION THEREFORE RETIRES THE `r:` PREFIX CLIENT-SIDE — it returns the
 * BARE room segment for ALL shapes (group / opaque / legacy-bare / unrecognised).
 * Because PR #1932 collapsed all four web-side writers (signaling.ts,
 * signaling-group.ts, useGroupCall.svelte.ts, kind-resolver.ts) onto this one
 * authority, the retirement propagates to every call site from this single edit.
 *
 * SAFETY DURING ROLLOUT. The server still ACCEPTS `r:<code>`:
 *   - `validate_room_id` (crates/signaling/src/handler.rs) strips a leading `r:`
 *     before validation, so a stale client's `r:<group>` still validates.
 *   - `normalize_room_key` (PR #1934) collapses `r:<bare>` and `<bare>` into ONE
 *     DashMap room, so a stale client emitting `r:` lands in the SAME room as a
 *     fresh client emitting bare. No split during mixed-version rollout.
 * So a fresh (bare) client and a stale (`r:`) client converge server-side.
 *
 * TWO-STEP RETIREMENT. This is the CLIENT half. The server-side `r:` accept/strip
 * stays in place and MUST NOT be removed until the `prefixed_r` join metric
 * drains to zero over a full SW-cache cycle (stale clients fully gone). Tracked
 * in docs/DEBT.md (D8).
 *
 * Spec: docs/adr/ADR-0005-heterogeneous-room-urls.md
 */

/**
 * The legacy `r:` SFU namespace prefix. Retained as the single TypeScript source
 * of truth for the literal — it still mirrors `ROOM_NS_GROUP` in
 * crates/signaling/src/handler.rs, where the server's accept/strip path lives
 * until the `prefixed_r` metric drains (docs/DEBT.md D8). The client no longer
 * APPLIES it (see {@link namespaceRoomSegment}); keep the constant in sync with
 * Rust so the server-strip removal can reference one shared literal.
 */
export const ROOM_NS_GROUP = 'r:';

/**
 * Return the room segment a client sends to the SFU/signaling WS path. The `r:`
 * prefix is RETIRED client-side (see module header) — this returns the room code
 * BARE for every shape: typed group, opaque 22-char, legacy-bare, and any
 * unrecognised form. The raw input is returned verbatim; no prefix is applied.
 *
 * The server still accepts a stale client's `r:<code>` (strip + #1934 normalize),
 * so mixing bare and `r:` clients during rollout is safe — both converge on one
 * room. Do not reintroduce the prefix here.
 *
 * @param code - The raw room code / ID as the client received it.
 * @returns `code` unchanged (bare) for all shapes.
 */
export function namespaceRoomSegment(code: string): string {
  return code;
}
