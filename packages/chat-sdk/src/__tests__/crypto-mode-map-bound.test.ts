/**
 * crypto-mode-map-bound.test.ts — CR17 hardening (Item A).
 *
 * `#activeCryptoModeByRoom` is populated by list()/#fetchRows on the list()-only path
 * (no live subscription). Eviction only fires in subscribe()'s teardownSubscriber
 * (chain refCount 0). A client paging history across many DISTINCT rooms via list()
 * with NO subscriptions would otherwise accumulate one map entry per room forever —
 * an availability leak (the per-room crypto state was a single O(1) field before the
 * per-room split landed).
 *
 * Locks:
 *   - the map stays bounded (<= cap) across many list()-only rooms;
 *   - insertion-order (FIFO) eviction of a MODE entry never un-poisons a room
 *     (`#poisonedRooms` is a SEPARATE authoritative set the bound must not touch).
 *
 * Note: eviction is bounded FIFO / insertion-order (evict the oldest non-live entry), NOT
 * true LRU — #resolveRoomCryptoMode sets unconditionally and Map.set on an existing key does
 * not reorder, so a re-listed room does not move to the back. For the page-once-per-room
 * access pattern this is equivalent to LRU and simpler; hot rooms are not specially protected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { makeListResponse, TEST_BASE_URL, TEST_JWT } from './helpers.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CR17 Item A — #activeCryptoModeByRoom bound on the list()-only path', () => {
  it('stays bounded across many distinct list()-only rooms (no subscriptions)', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeListResponse('AA==', { cryptoMode: 'sframe-static' }),
    );
    const c = new SDKChatClient({ baseUrl: TEST_BASE_URL, jwt: TEST_JWT });

    // 400 distinct list()-only rooms, none subscribed → one entry each without a bound.
    for (let i = 0; i < 400; i++) {
      await c.list(`list-only-${i}`, {});
    }

    expect(c._roomCryptoStateSize().modes).toBeLessThanOrEqual(256);
  });

  it('insertion-order (FIFO) eviction of a mode entry never un-poisons a room', async () => {
    const POISON_ROOM = 'room-poisoned';
    let poisonRoomFetches = 0;
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes(`room_id=${POISON_ROOM}`)) {
        poisonRoomFetches++;
        // 1st resolve caches 'sframe-static' (a real mode entry); 2nd downgrades to
        // 'plaintext' → configured-mismatch → poison (the cached entry lingers).
        const mode = poisonRoomFetches === 1 ? 'sframe-static' : 'plaintext';
        return makeListResponse('AA==', { cryptoMode: mode });
      }
      return makeListResponse('AA==', { cryptoMode: 'sframe-static' });
    });

    const c = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'sframe-static',
    });

    // Give the room a cached mode entry, then poison it via a downgrade mismatch.
    await c.list(POISON_ROOM, {});
    await expect(c.list(POISON_ROOM, {})).rejects.toMatchObject({
      code: 'crypto_mode_mismatch',
    });

    // Flood the map with list()-only rooms to force insertion-order eviction of the (oldest)
    // poisoned room's now-stale mode entry.
    for (let i = 0; i < 400; i++) {
      await c.list(`flood-${i}`, {});
    }

    expect(c._roomCryptoStateSize().modes).toBeLessThanOrEqual(256);
    // The mode entry was evicted, but the poison is authoritative and untouched.
    await expect(c.list(POISON_ROOM, {})).rejects.toMatchObject({
      code: 'crypto_mode_poisoned',
    });
    expect(c._roomCryptoStateSize().poisoned).toBeGreaterThanOrEqual(1);
  });
});
