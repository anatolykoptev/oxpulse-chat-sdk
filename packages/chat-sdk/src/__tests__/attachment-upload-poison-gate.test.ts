/**
 * attachment-upload-poison-gate.test.ts — SEC-CR-001 (byte-leak on the direct-upload path).
 *
 * sendFile() already fails CLOSED on a poisoned room (client.ts, #assertRoomNotPoisoned),
 * but the chat-widget uploads attachment BYTES via presignAttachment() + a raw PUT
 * directly — bypassing sendFile() to keep the presigned attachmentId — so it could still
 * presign + upload a file body for a room poisoned by a prior crypto_mode_mismatch,
 * leaking the fail-closed guarantee that no message content leaves a poisoned room.
 *
 * The fix exposes a minimal PUBLIC delegate, assertRoomNotPoisoned(roomId), that reads the
 * SAME authoritative #poisonedRooms as every internal gate. The widget's room-aware upload
 * wrapper calls it BEFORE presign. This suite proves the SDK contract that wrapper relies
 * on: a poisoned room throws, a healthy one does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { makeListResponse, TEST_BASE_URL, TEST_JWT } from './helpers.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SEC-CR-001 — public assertRoomNotPoisoned gate (attachment-upload byte-leak)', () => {
  it('throws crypto_mode_poisoned for a room poisoned by a prior crypto_mode_mismatch', async () => {
    globalThis.fetch = vi.fn(async () =>
      // list() sees a downgraded crypto_mode → validateAndResolveCryptoMode poisons the room.
      makeListResponse('AA==', { cryptoMode: 'plaintext' }),
    ) as typeof fetch;

    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    // Poison 'room-x' via a downgrade mismatch on list().
    await expect(c.list('room-x', {})).rejects.toMatchObject({ code: 'crypto_mode_mismatch' });

    // The public gate (the widget's pre-presign check) now refuses the same room.
    expect(() => c.assertRoomNotPoisoned('room-x')).toThrow(
      expect.objectContaining({ code: 'crypto_mode_poisoned' }),
    );
  });

  it('is a no-op for a healthy (unpoisoned) room — upload still allowed', async () => {
    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    expect(() => c.assertRoomNotPoisoned('healthy-room')).not.toThrow();
  });

  it('poison is scoped to the mismatched room; a sibling room stays uploadable', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // Only 'room-x' downgrades; 'room-ok' stays on the configured mode.
      if (url.includes('room-x')) return makeListResponse('AA==', { cryptoMode: 'plaintext' });
      return makeListResponse('AA==', { cryptoMode: 'sframe-static' });
    }) as typeof fetch;

    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    await expect(c.list('room-x', {})).rejects.toMatchObject({ code: 'crypto_mode_mismatch' });
    await c.list('room-ok', {});

    expect(() => c.assertRoomNotPoisoned('room-x')).toThrow(
      expect.objectContaining({ code: 'crypto_mode_poisoned' }),
    );
    expect(() => c.assertRoomNotPoisoned('room-ok')).not.toThrow();
  });
});
