/**
 * sframe-replay.test.ts — SEC-CR-003 (CWE-294) durable cross-reload anti-replay.
 *
 * Threat: a malicious / compromised app-server (the adversary in the E2EE threat
 * model — it cannot forge, but it CAN replay authentic old ciphertext) re-serves an
 * OLD sealed frame under a FRESH msg_id. The widget's msg_id dedup does not catch it
 * (fresh id), and after a page reload sframe-ratchet's IN-MEMORY receiver replay window
 * is empty — the AEAD verifies (the ciphertext is genuinely authentic, just old) and the
 * stale message renders as new (e.g. replaying an old "approved" / "paid" instruction).
 *
 * A "reload" is simulated by constructing a FRESH provider with the SAME key (fresh
 * in-memory window, like a real page reload) while the durable IndexedDB store persists.
 *
 * TDD: the cross-reload test is RED against main ce7863f (the replay is ACCEPTED),
 * GREEN once the durable receiver-side replay window lands.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get, keys, clear } from 'idb-keyval';
import { createSFrameProvider } from '../sframe.js';
import { ReplayError } from 'sframe-ratchet/chat';
import type { CryptoProvider } from '../types.js';

const ROOM_ID = 'room-replay-1';
const SENDER_UID = 'user-replay-1';

/** A single shared HKDF base-key reused across "reloads" (as a real room key would be). */
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
  vi.restoreAllMocks();
});

describe('SFrame durable cross-reload anti-replay (SEC-CR-003)', () => {
  it('rejects a replayed old frame after a simulated reload (fresh provider, same key)', async () => {
    const key = await makeHkdfKey();

    // Session 1: victim receives (unseals) an authentic frame — records its CTR durably.
    const sender = createSFrameProvider({ getKey: async () => key });
    const oldFrame = await sender.seal(pt('approve payment'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1: CryptoProvider = createSFrameProvider({ getKey: async () => key });
    const firstView = await session1.unseal(oldFrame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(firstView)).toEqual(enc.encode('approve payment'));

    // Reload: fresh provider (empty in-memory window) — durable IDB store persists.
    const session2: CryptoProvider = createSFrameProvider({ getKey: async () => key });

    // Server replays the SAME authentic frame under a fresh msg_id. Must be REJECTED.
    await expect(
      session2.unseal(oldFrame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('persists the accepted CTR to IndexedDB across the simulated reload', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key });
    const frame = await sender.seal(pt('hello'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key });
    await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // The durable store holds a per-(room,sender) entry with at least one accepted CTR.
    const storeKey = `sframe-replay|default|${ROOM_ID}|${SENDER_UID}`;
    const persisted = await get<{ v: number; seen: string[] }>(storeKey);
    expect(persisted).toBeDefined();
    expect(persisted!.seen.length).toBeGreaterThanOrEqual(1);
  });

  it('regression (a): normal in-order delivery of distinct frames still works', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key });
    const receiver = createSFrameProvider({ getKey: async () => key });

    for (const msg of ['one', 'two', 'three']) {
      const frame = await sender.seal(pt(msg), { roomId: ROOM_ID, senderUid: SENDER_UID });
      const out = await receiver.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
      expect(new Uint8Array(out)).toEqual(enc.encode(msg));
    }
  });

  it('regression (b): a genuinely-new frame is still accepted after a reload', async () => {
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

  it('preserves in-session replay rejection (same provider, same frame twice)', async () => {
    const key = await makeHkdfKey();
    const provider = createSFrameProvider({ getKey: async () => key });
    const frame = await provider.seal(pt('once'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    await provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    await expect(
      provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('regression (c): degrades gracefully with a one-time warn when IndexedDB is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saved = globalThis.indexedDB;
    // Simulate an SSR / Node-without-polyfill runtime.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    try {
      const key = await makeHkdfKey();
      // Must NOT throw at construct.
      const sender = createSFrameProvider({ getKey: async () => key });
      const receiver = createSFrameProvider({ getKey: async () => key });

      // Round-trip still works (in-memory window is the only defense).
      const frame = await sender.seal(pt('no-idb'), { roomId: ROOM_ID, senderUid: SENDER_UID });
      const out = await receiver.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
      expect(new Uint8Array(out)).toEqual(enc.encode('no-idb'));

      // One-time no-IDB warning fired, referencing SEC-CR-003.
      const warnMsgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnMsgs.some((m) => m.includes('SEC-CR-003') && m.includes('IndexedDB'))).toBe(true);
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = saved;
    }
  });

  it('opt-out: durableReplay:false reverts to in-memory-only (replay accepted after reload)', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    const frame = await sender.seal(pt('escape-hatch'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session2 = createSFrameProvider({ getKey: async () => key, durableReplay: false });
    const out = await session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('escape-hatch'));
  });

  it('scopes the window per (room, sender): distinct rooms use distinct store entries', async () => {
    const key = await makeHkdfKey();
    const provider = createSFrameProvider({ getKey: async () => key });

    const frameA = await provider.seal(pt('a'), { roomId: 'room-A', senderUid: SENDER_UID });
    const frameB = await provider.seal(pt('b'), { roomId: 'room-B', senderUid: SENDER_UID });
    await provider.unseal(frameA, { roomId: 'room-A', senderUid: SENDER_UID });
    await provider.unseal(frameB, { roomId: 'room-B', senderUid: SENDER_UID });

    const storeKeys = (await keys()).map(String);
    expect(storeKeys).toContain(`sframe-replay|default|room-A|${SENDER_UID}`);
    expect(storeKeys).toContain(`sframe-replay|default|room-B|${SENDER_UID}`);

    // A frame accepted in room-A does not falsely reject a fresh frame in room-B.
    const frameB2 = await provider.seal(pt('b2'), { roomId: 'room-B', senderUid: SENDER_UID });
    const reload = createSFrameProvider({ getKey: async () => key });
    const out = await reload.unseal(frameB2, { roomId: 'room-B', senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('b2'));
  });
});
