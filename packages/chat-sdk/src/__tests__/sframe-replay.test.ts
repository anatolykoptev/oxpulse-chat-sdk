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
import { DurableReplayGuard } from '../sframe-replay.js';
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

  it('CR17-02: without Web Locks (legacy Safari), durable persistence is disabled with a one-time warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    // Legacy engine (Safari <15.4): IndexedDB present, but no Web Locks API. Without a
    // cross-tab lock the durable read-merge-write could silently drop a CTR (CR17-02), so
    // the guard gates durable persistence OFF rather than claim a protection it cannot keep.
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: undefined },
      configurable: true,
    });
    try {
      const key = await makeHkdfKey();
      const sender = createSFrameProvider({ getKey: async () => key });
      const frame = await sender.seal(pt('no-locks'), { roomId: ROOM_ID, senderUid: SENDER_UID });

      // Round-trip still works — the library's in-memory window is the only defense.
      const session1 = createSFrameProvider({ getKey: async () => key });
      await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

      // Durable OFF → nothing persisted, and a cross-reload replay is ACCEPTED (like no-IDB).
      const storeKey = `sframe-replay|default|${ROOM_ID}|${SENDER_UID}`;
      expect(await get(storeKey)).toBeUndefined();
      const session2 = createSFrameProvider({ getKey: async () => key });
      const out = await session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
      expect(new Uint8Array(out)).toEqual(enc.encode('no-locks'));

      // One-time CR17-02 warn referencing the Web Locks API fired.
      const warnMsgs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnMsgs.some((m) => m.includes('CR17-02') && m.includes('Web Locks'))).toBe(true);
    } finally {
      if (savedNavDesc) Object.defineProperty(globalThis, 'navigator', savedNavDesc);
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

  it('anti-poison: a forged frame that fails AEAD is NOT recorded in the durable window', async () => {
    const keyA = await makeHkdfKey();
    const keyB = await makeHkdfKey(); // different key → AEAD auth fails

    // Frame sealed under key B; the victim (key A) will fail to unseal it.
    const sealerB = createSFrameProvider({ getKey: async () => keyB });
    const forged = await sealerB.seal(pt('forged'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const victim = createSFrameProvider({ getKey: async () => keyA });
    await expect(
      victim.unseal(forged, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeTruthy(); // AEAD auth error, not a ReplayError

    // The forged CTR must NOT have been persisted (accept runs only after a successful unseal),
    // so an attacker cannot poison the window to false-reject a later legitimate frame.
    const storeKey = `sframe-replay|default|${ROOM_ID}|${SENDER_UID}`;
    const persisted = await get<{ v: number; seen: string[] }>(storeKey);
    expect(persisted).toBeUndefined();
  });

  it('documents the eviction residual (SEC-CR-003-01): an aged, evicted CTR can replay', async () => {
    const key = await makeHkdfKey();
    // Tiny durable window so eviction is cheap to exercise.
    const sender = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 2 });
    const f1 = await sender.seal(pt('f1'), { roomId: ROOM_ID, senderUid: SENDER_UID });
    const f2 = await sender.seal(pt('f2'), { roomId: ROOM_ID, senderUid: SENDER_UID });
    const f3 = await sender.seal(pt('f3'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 2 });
    // Accept f1, f2, f3 in order — f1 is evicted (window holds only the 2 most recent).
    await session1.unseal(f1, { roomId: ROOM_ID, senderUid: SENDER_UID });
    await session1.unseal(f2, { roomId: ROOM_ID, senderUid: SENDER_UID });
    await session1.unseal(f3, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Recent frames (f2, f3) are still rejected on reload.
    const session2 = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 2 });
    await expect(
      session2.unseal(f3, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);

    // The evicted f1 is accepted — the bounded-window residual (documented in the changeset).
    const session3 = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 2 });
    const out = await session3.unseal(f1, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('f1'));
  });

  it('monotonic-idb strategy: round-trip works and cross-reload replay is still rejected', async () => {
    const key = await makeHkdfKey();
    const opts = { getKey: async () => key, ctrStrategy: 'monotonic-idb' as const, ctrKeyspace: 'ks-test' };
    const sender = createSFrameProvider(opts);
    const frame = await sender.seal(pt('mono'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider(opts);
    const out = await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('mono'));

    // The durable window (not monotonic-idb itself) is what protects the receiver on reload.
    const session2 = createSFrameProvider(opts);
    await expect(
      session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('durableReplayWindow:0 disables the durable window (mirrors replayWindow:0)', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 0 });
    const frame = await sender.seal(pt('disabled'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    const session1 = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 0 });
    await session1.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Disabled → nothing persisted, and a cross-reload replay is accepted (opt-in-only again).
    const storeKey = `sframe-replay|default|${ROOM_ID}|${SENDER_UID}`;
    expect(await get(storeKey)).toBeUndefined();

    const session2 = createSFrameProvider({ getKey: async () => key, durableReplayWindow: 0 });
    const out = await session2.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID });
    expect(new Uint8Array(out)).toEqual(enc.encode('disabled'));
  });

  it('cross-tab: a second tab merges (does not clobber) the first tab persisted CTRs', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key });
    const fA = await sender.seal(pt('tabA-frame'), { roomId: ROOM_ID, senderUid: SENDER_UID });
    const fB = await sender.seal(pt('tabB-frame'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Two "tabs" (separate provider instances) sharing the same IDB store record different CTRs.
    const tabA = createSFrameProvider({ getKey: async () => key });
    const tabB = createSFrameProvider({ getKey: async () => key });
    await tabA.unseal(fA, { roomId: ROOM_ID, senderUid: SENDER_UID }); // persists {ctrA}
    await tabB.unseal(fB, { roomId: ROOM_ID, senderUid: SENDER_UID }); // read-merge-write -> {ctrA, ctrB}

    // A reload sees BOTH CTRs — tabA's ctrA was merged, not clobbered by tabB's write.
    const reloadA = createSFrameProvider({ getKey: async () => key });
    await expect(
      reloadA.unseal(fA, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
    const reloadB = createSFrameProvider({ getKey: async () => key });
    await expect(
      reloadB.unseal(fB, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('concurrency: overlapping unseals of one frame may double-deliver, but the guarantee holds after', async () => {
    const key = await makeHkdfKey();
    const provider = createSFrameProvider({ getKey: async () => key });
    const frame = await provider.seal(pt('race'), { roomId: ROOM_ID, senderUid: SENDER_UID });

    // Two overlapping unseals of the SAME fresh frame — mirrors the un-serialized public list()
    // path (subscribe()/reconnect route through the per-room serial chain; list() does not).
    // Both pass check() before either accept() lands → the documented double-deliver residual.
    const results = await Promise.allSettled([
      provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
      provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

    // Once the race settles, the durable window rejects any subsequent replay.
    await expect(
      provider.unseal(frame, { roomId: ROOM_ID, senderUid: SENDER_UID }),
    ).rejects.toBeInstanceOf(ReplayError);
  });
});

/**
 * SEC-CR-F4: the in-memory `mem` cache must be bounded — one MemWindow per distinct
 * (namespace, room, sender) was created on hydrate and never released, so a long-lived
 * always-open widget seeing many distinct senders/rooms grew `mem` without bound.
 *
 * These tests install a minimal Web Locks stub so the guard is `available` deterministically
 * on ANY platform (node has no Web Locks API — the 6 cross-reload tests above are no-ops here
 * and are the known darwin/node baseline failures). The `available === true` assertion + the
 * re-hydrate assertion below both guard against a vacuous (no-op guard) pass.
 */
describe('DurableReplayGuard in-memory cache bound (SEC-CR-F4)', () => {
  const savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function installLocksStub(): void {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        locks: {
          request: (_name: string, _opts: unknown, cb: () => unknown): Promise<unknown> =>
            Promise.resolve().then(() => cb()),
        },
      },
      configurable: true,
    });
  }
  function restoreNav(): void {
    if (savedNavDesc) Object.defineProperty(globalThis, 'navigator', savedNavDesc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }

  /** Read the private `mem` size to assert the internal cache invariant (no public size API). */
  const memSize = (g: DurableReplayGuard): number =>
    (g as unknown as { mem: Map<string, unknown> }).mem.size;

  it('caps mem via FIFO eviction; an evicted (room,sender) re-hydrates correctly from IDB', async () => {
    installLocksStub();
    try {
      // fake-indexeddb (auto-imported) + the locks stub → the guard is durable-available.
      const guard = new DurableReplayGuard({ warnIfUnavailable: false });
      expect(guard.available).toBe(true); // anti-vacuous: a no-op guard would never grow `mem`

      const CAP = 256;
      const OVERFLOW = 10;
      const CTR = 5n;
      // Accept one CTR per distinct (room, sender) key. Sequential awaits ⇒ each persist
      // settles (drains `persisting`) before the next accept, so the oldest is always evictable.
      for (let i = 0; i < CAP + OVERFLOW; i++) {
        await guard.accept(`room-${i}`, 'sender', CTR);
      }

      // FIX: mem never exceeds the cap. RED pre-fix: it is CAP + OVERFLOW (266) — unbounded growth.
      expect(memSize(guard)).toBeLessThanOrEqual(CAP);

      // room-0 (oldest) was evicted, but its CTR is durably persisted: a re-check re-hydrates from
      // IDB and STILL rejects the replay, and a genuinely-new CTR is accepted (no false reject).
      expect(await guard.check('room-0', 'sender', CTR)).toBe(false); // already seen → replay
      expect(await guard.check('room-0', 'sender', 999n)).toBe(true); // never seen → accept
    } finally {
      restoreNav();
    }
  });

  /**
   * A Web Locks stub whose `request` NEVER settles until the test explicitly calls `release()`
   * — lets a test genuinely hold a `persistMerged` call in flight (and therefore its key
   * `persisting`) across other guard operations, instead of racing real microtask timing.
   */
  function installControllableLocksStub(): {
    pending: Array<{ name: string }>;
    release: () => void;
  } {
    const pending: Array<{ name: string; run: () => void }> = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        locks: {
          request: (name: string, _opts: unknown, cb: () => unknown): Promise<unknown> =>
            new Promise((resolve, reject) => {
              pending.push({
                name,
                run: () => {
                  Promise.resolve().then(cb).then(resolve, reject);
                },
              });
            }),
        },
      },
      configurable: true,
    });
    return {
      pending,
      release: () => pending.splice(0, pending.length).forEach((entry) => entry.run()),
    };
  }

  /** Poll (macrotask ticks — fake-indexeddb's IDBRequest events resolve on a task, not a microtask). */
  async function waitUntil(cond: () => boolean, maxTicks = 500): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (cond()) return;
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (!cond()) throw new Error('waitUntil: condition never became true');
  }

  it('SEC-CR-189-01: a key with an in-flight persist survives trim (even though oldest); self-heals once it drains', async () => {
    const { pending, release } = installControllableLocksStub();
    try {
      const guard = new DurableReplayGuard({ warnIfUnavailable: false });
      expect(guard.available).toBe(true); // anti-vacuous

      const CAP = 256;
      const holdKey = 'sframe-replay|default|room-hold|sender';

      // Start an accept() whose persistMerged reaches navigator.locks.request and BLOCKS there
      // (the stub above never auto-resolves) — this is the oldest entry, with `persisting` set,
      // genuinely in flight (not merely "not yet awaited") for the entire test until release().
      const holdPromise = guard.accept('room-hold', 'sender', 1n);
      await waitUntil(() => pending.some((p) => p.name.includes('room-hold')));
      expect(memSize(guard)).toBe(1);

      // Push CAP more DISTINCT keys through check() (hydrate-only — never touches `persisting`,
      // so each becomes immediately evictable once no longer the freshest). Sequential awaits so
      // each hydrate (and any trim it triggers) fully settles before the next.
      for (let i = 0; i < CAP; i++) {
        await guard.check(`room-fill-${i}`, 'sender', 1n);
      }

      // mem holds hold + CAP fills = 257 > cap. Trim must have evicted the oldest NON-persisting
      // entry (room-fill-0) each time it ran — room-hold (still persisting) must have SURVIVED,
      // proving the `persisting.has(key)` skip in trimMemCache is load-bearing.
      expect(memSize(guard)).toBeLessThanOrEqual(CAP);
      expect((guard as unknown as { mem: Map<string, unknown> }).mem.has(holdKey)).toBe(true);

      // Release the held lock — room-hold's persist completes, `persisting` drains.
      release();
      await holdPromise;
      expect((guard as unknown as { persisting: Map<string, number> }).persisting.size).toBe(0);

      // Self-heal: room-hold is now the oldest AND no longer persisting — the next trim evicts it.
      await guard.check('room-fill-256', 'sender', 1n);
      expect(memSize(guard)).toBeLessThanOrEqual(CAP);
      expect((guard as unknown as { mem: Map<string, unknown> }).mem.has(holdKey)).toBe(false);
    } finally {
      restoreNav();
    }
  });
});
