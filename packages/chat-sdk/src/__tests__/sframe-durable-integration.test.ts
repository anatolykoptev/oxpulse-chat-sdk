/**
 * sframe-durable-integration.test.ts — integration tests for the library-owned
 * DurableReplayGuard (sframe-ratchet 0.5.5+).
 *
 * The SDK's custom 365-line DurableReplayGuard was removed in the 0.5.5 migration
 * and replaced with the library's internal guard. These tests verify the library's
 * guard works correctly in the SDK's context — they are NOT redundant with the
 * library's own tests, they verify the SDK's integration contract:
 *
 *   1. Cross-reload replay rejection (SEC-CR-003) — the core security invariant.
 *   2. Anti-poison — a forged frame (AEAD auth fail) does NOT record its CTR.
 *   3. Default namespace — durable replay is ON without explicit namespace
 *      (backward compat with the pre-0.5.5 SDK guard that defaulted to 'default').
 *   4. Opt-out — durableReplay:false reverts to in-memory-only.
 *
 * The deleted sframe-replay.test.ts had additional tests (FIFO cache bound,
 * cross-tab merge, Web Locks degradation, concurrency double-deliver) — those
 * are the library's internal concerns and covered by its own test suite. The
 * tests here cover the SDK's integration contract only.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { clear } from 'idb-keyval';
import { createSFrameProvider } from '../sframe.js';
import { ReplayError } from 'sframe-ratchet/chat';
import type { CryptoProvider } from '../types.js';

const ROOM_ID = 'room-int-1';
const SENDER_UID = 'user-int-1';

async function makeHkdfKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

const enc = new TextEncoder();
function pt(s: string): ArrayBuffer {
  return enc.encode(s).buffer as ArrayBuffer;
}

beforeEach(async () => {
  await clear();
});

describe('SFrame durable replay — library integration (sframe-ratchet 0.5.5)', () => {
  it('SEC-CR-003: rejects a replayed old frame after a simulated reload', async () => {
    const key = await makeHkdfKey();

    // Session 1: victim receives an authentic frame — records its CTR durably.
    const sender = createSFrameProvider({ getKey: async () => key });
    const oldFrame = await sender.seal(pt('approve payment'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1: CryptoProvider = createSFrameProvider({ getKey: async () => key });
    const firstView = await session1.unseal(oldFrame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(firstView)).toEqual(enc.encode('approve payment'));

    // Reload: fresh provider (empty in-memory window) — durable IDB store persists.
    const session2: CryptoProvider = createSFrameProvider({ getKey: async () => key });

    // Server replays the SAME authentic frame. Must be REJECTED.
    await expect(
      session2.unseal(oldFrame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('SEC-CR-003 regression: a genuinely-new frame is still accepted after a reload', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key });
    const oldFrame = await sender.seal(pt('old'), { roomId: ROOM_ID, senderUid: SENDER_UID });
    const newFrame = await sender.seal(pt('new-and-legit'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key });
    await session1.unseal(oldFrame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Reload: a fresh frame the victim has never seen must still decrypt.
    const session2 = createSFrameProvider({ getKey: async () => key });
    const out = await session2.unseal(newFrame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('new-and-legit'));
  });

  it('anti-poison: a forged frame that fails AEAD is NOT recorded in the durable window', async () => {
    const keyA = await makeHkdfKey();
    const keyB = await makeHkdfKey(); // different key → AEAD auth fails

    // Frame sealed under key B; the victim (key A) will fail to unseal it.
    const sealerB = createSFrameProvider({ getKey: async () => keyB });
    const forged = await sealerB.seal(pt('forged'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const victim = createSFrameProvider({ getKey: async () => keyA });
    await expect(
      victim.unseal(forged, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toThrow(); // AEAD auth error, not a ReplayError

    // The forged CTR must NOT have been persisted — a reload must still ACCEPT
    // a genuine frame with a fresh CTR (no false reject from poison).
    const sender = createSFrameProvider({ getKey: async () => keyA });
    const legit = await sender.seal(pt('legit'), { roomId: ROOM_ID, senderUid: SENDER_UID });
    const reload = createSFrameProvider({ getKey: async () => keyA });
    const out = await reload.unseal(legit, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('legit'));
  });

  it('default namespace: durable replay is ON without explicit namespace (backward compat)', async () => {
    const key = await makeHkdfKey();

    // No durableReplayNamespace, no ctrKeyspace — must still default to 'default'
    // and enable durable replay (preserves pre-0.5.5 SDK behavior).
    const sender = createSFrameProvider({ getKey: async () => key });
    const frame = await sender.seal(pt('default-ns'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key });
    await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Reload: replay must be rejected even without explicit namespace.
    const session2 = createSFrameProvider({ getKey: async () => key });
    await expect(
      session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('opt-out: durableReplay:false reverts to in-memory-only (replay accepted after reload)', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    const frame = await sender.seal(pt('escape-hatch'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Reload: with durable OFF, the replay is ACCEPTED (in-memory window is empty).
    const session2 = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    const out = await session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('escape-hatch'));
  });

  it('in-session replay rejection still works (same provider, same frame twice)', async () => {
    const key = await makeHkdfKey();
    const provider = createSFrameProvider({ getKey: async () => key });
    const frame = await provider.seal(pt('once'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    await provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    await expect(
      provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });
});
