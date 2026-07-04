/**
 * getthread-poison-gate.test.ts — CR17 hardening (Item B).
 *
 * getThread reads sealed message-content rows for a room; its sibling read
 * list()/#fetchRows already fails CLOSED on a poisoned room (#assertRoomNotPoisoned).
 * getThread did NOT — a room proven to have a downgraded/tampered crypto_mode still
 * served its thread. This gates getThread on the same poison check so a poisoned room
 * refuses ALL message-content reads.
 *
 * (Interaction-metadata methods — reactions / typing / presence / markRead / pins —
 * are cleartext-by-wire-contract and stay EXEMPT; see the gate-class doc in client.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { makeListResponse, TEST_BASE_URL, TEST_JWT } from './helpers.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

/** A getThread response: a bare JSON array of message rows (server wire contract). */
function makeThreadResponse(): Response {
  return new Response(
    JSON.stringify([
      {
        seq: 1,
        msg_id: 'root-1',
        sender_uid: 'user-1',
        sealed_b64: 'AA==',
        created_at: '2026-06-01T00:00:00Z',
        thread_root_msg_id: null,
        product_ref: null,
        product_meta: null,
      },
    ]),
    { status: 200 },
  );
}

describe('CR17 Item B — getThread fails closed on a poisoned room', () => {
  it('refuses getThread for a room poisoned by a prior crypto_mode_mismatch', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/threads/')) return makeThreadResponse();
      // list() → downgrade mismatch → poison.
      return makeListResponse('AA==', { cryptoMode: 'plaintext' });
    });

    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    // Poison the room via a downgrade mismatch on list().
    await expect(c.list('room-x', {})).rejects.toMatchObject({ code: 'crypto_mode_mismatch' });

    // getThread on the same room must now refuse (before any thread fetch).
    await expect(c.getThread('room-x', 'root-1')).rejects.toMatchObject({
      code: 'crypto_mode_poisoned',
    });
  });

  it('still serves getThread for a healthy (unpoisoned) room', async () => {
    globalThis.fetch = vi.fn(async () => makeThreadResponse());
    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    const rows = await c.getThread('healthy-room', 'root-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(1);
  });

  // SEC-CR-17-B-01 (crypto-review MEDIUM): searchByProductRef is the direct sibling of
  // getThread — it returns sealed message-content rows from a bare array. When scoped to a
  // room it must fail closed on that room's poison, same gate class.
  it('refuses a room-scoped searchByProductRef for a poisoned room', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('product_ref=')) return makeThreadResponse();
      // list() → downgrade mismatch → poison.
      return makeListResponse('AA==', { cryptoMode: 'plaintext' });
    });

    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    await expect(c.list('room-x', {})).rejects.toMatchObject({ code: 'crypto_mode_mismatch' });

    // Room-scoped search on the poisoned room must refuse (before any search fetch).
    await expect(
      c.searchByProductRef('prod-1', { roomId: 'room-x' }),
    ).rejects.toMatchObject({ code: 'crypto_mode_poisoned' });
  });
});
