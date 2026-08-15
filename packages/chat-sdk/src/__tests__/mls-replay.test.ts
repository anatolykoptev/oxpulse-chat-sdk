/**
 * mls-replay.test.ts — replay protection under MLS.
 *
 * The migration plan states: "The existing sframe-ratchet durable replay guard
 * (per-CTR) is NOT used for MLS mode — MLS has its own replay protection via
 * generation counters." That is wrong. MLS generation counters protect
 * handshake messages inside ts-mls; application ciphertext rides
 * sframe-ratchet with MLS-derived epoch material, and sframe-ratchet runs TWO
 * guards in sequence before decrypting (sframe-ratchet@0.5.7 dist/chat/mls.js,
 * createMlsChatProvider → unseal):
 *
 *   1. In-memory sliding CTR window per (roomId, senderUid), default size 1024.
 *      Throws ReplayError("createMlsChatProvider: replay detected (ctr=…)").
 *   2. When IndexedDB + Web Locks are available, a durable IDB-backed window
 *      keyed room|uid. Throws ReplayError("createMlsChatProvider: durable
 *      cross-reload replay detected (ctr=…)").
 *
 * T1 is a POSITIVE CONTROL for a DEPENDENCY guarantee, not a gate on our
 * logic. The in-memory window (guard 1) is created unconditionally inside
 * createMlsChatProvider and cannot be disabled from our code. If T1 goes red,
 * it means the guard is reachable from our configuration after all — report it.
 *
 * T3 IS a gate on our logic: the durable namespace is wired by
 * createMlsProvider (mls-provider.ts, durableReplayNamespace line). Deleting
 * that line (M1) disables the durable guard and T3 must go red.
 *
 * Test environment: fake-indexeddb provides IndexedDB; the Web Locks API
 * (navigator.locks.request) comes from the runtime. sframe-ratchet requires
 * BOTH before it will arm the durable guard.
 *
 * Web Locks is absent below Node 24, and there T3 does not merely lose its
 * subject — it FAILS, because the replay it expects to be rejected is accepted
 * by a guard that never armed. Measured on krolik over a non-login shell
 * (node v22.22.3): `1 failed | 3 passed`, and the failure reads exactly like a
 * broken replay guard. So T3 is gated on the capability and states why it
 * skipped, rather than reporting a runtime gap as a security regression.
 *
 * Skipping is safe here only because CI cannot take that branch: preflight.yml
 * pins node 24 and fails the job outright if `navigator.locks.request` is
 * missing, precisely so this coverage cannot go quiet. If that guard is ever
 * removed, this skip becomes a hole — they are one mechanism, not two.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clear as idbClear, createStore } from 'idb-keyval';
import { createMlsProvider } from '../mls-provider.js';
import { InMemoryMlsStateStore, IdbMlsStateStore } from '../mls-state-store.js';
import type { MLSStateStore } from '../mls-state-store.js';
import { ReplayError } from 'sframe-ratchet/chat';
import type { MlsProvider } from '../mls-provider.js';

// ---------------------------------------------------------------------------
// Mock Delivery Service — self-contained, not imported from other test files.
// ---------------------------------------------------------------------------

class MockDeliveryService {
  readonly keyPackages = new Map<string, string[]>();
  readonly welcomeQueue = new Map<string, Array<{ roomId: string; welcome_b64: string }>>();
  readonly mlsMessages = new Map<string, string[]>();
  #originalFetch: typeof globalThis.fetch | null = null;

  install(): void {
    this.#originalFetch = globalThis.fetch;
    globalThis.fetch = this.#fetch.bind(this) as unknown as typeof globalThis.fetch;
  }

  restore(): void {
    if (this.#originalFetch) {
      globalThis.fetch = this.#originalFetch;
      this.#originalFetch = null;
    }
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    // POST /keys/publish — publish KeyPackage
    if (url.endsWith('/keys/publish') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { key_package_b64: string };
      const auth = (init?.headers?.['Authorization'] as string) ?? '';
      const uid = auth.replace('Bearer mock-jwt-', '') || 'unknown';
      const kps = this.keyPackages.get(uid) ?? [];
      kps.push(body.key_package_b64);
      this.keyPackages.set(uid, kps);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    // GET /keys/:uid — fetch KeyPackages
    const getKpMatch = url.match(/\/keys\/([^/]+)$/);
    if (getKpMatch && method === 'GET') {
      const uid = getKpMatch[1]!;
      const kps = this.keyPackages.get(uid) ?? [];
      return new Response(JSON.stringify({
        key_packages: kps.map((b64) => ({ key_package_b64: b64 })),
      }), { status: 200 });
    }

    // POST /rooms/:roomId/mls-welcome — queue Welcome for target user
    const welcomeMatch = url.match(/\/rooms\/([^/]+)\/mls-welcome$/);
    if (welcomeMatch && method === 'POST') {
      const roomId = welcomeMatch[1]!;
      const body = JSON.parse(init?.body as string) as { welcome_b64: string; target_uid: string };
      const queue = this.welcomeQueue.get(body.target_uid) ?? [];
      queue.push({ roomId, welcome_b64: body.welcome_b64 });
      this.welcomeQueue.set(body.target_uid, queue);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    // POST /rooms/:roomId/mls-messages — relay MLS protocol message
    const msgMatch = url.match(/\/rooms\/([^/]+)\/mls-messages$/);
    if (msgMatch && method === 'POST') {
      const roomId = msgMatch[1]!;
      const body = JSON.parse(init?.body as string) as { message_b64: string };
      const msgs = this.mlsMessages.get(roomId) ?? [];
      msgs.push(body.message_b64);
      this.mlsMessages.set(roomId, msgs);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function makeIdentityKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
}

async function makeTestAuthService(): Promise<import('ts-mls').AuthenticationService> {
  const tsMls = await import('ts-mls');
  return tsMls.unsafeTestingAuthenticationService;
}

async function makeProvider(
  uid: string,
  stateStore: MLSStateStore,
  durableReplayNamespace?: string,
): Promise<MlsProvider> {
  return createMlsProvider({
    identityKey: await makeIdentityKey(),
    credential: 'basic',
    uid,
    keyPackageDirectoryUrl: 'http://mock/keys',
    jwt: `mock-jwt-${uid}`,
    authService: await makeTestAuthService(),
    stateStore,
    ...(durableReplayNamespace ? { durableReplayNamespace } : {}),
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function strToBuf(s: string): ArrayBuffer {
  return enc.encode(s).buffer as ArrayBuffer;
}

/** Clear all keys in an idb-keyval store (avoids deleteDatabase which blocks
 *  on open connections from prior test providers — fake-indexeddb keeps IDB
 *  connections alive after dispose()). */
async function clearIdbStore(dbName: string, storeName: string): Promise<void> {
  const store = createStore(dbName, storeName);
  await idbClear(store);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MLS replay protection', () => {
  let ds: MockDeliveryService;

  beforeEach(() => {
    ds = new MockDeliveryService();
    ds.install();
  });

  afterEach(() => {
    ds.restore();
  });

  /**
   * Shared setup: Alice + Bob publish KeyPackages, Alice creates a group with
   * Bob, Bob joins via the welcome from the mock DS. Both are at the same
   * epoch with the same AEAD keys after this.
   */
  async function setupTwoMembers(
    roomId: string,
    aliceStore: MLSStateStore = new InMemoryMlsStateStore(),
    bobStore: MLSStateStore = new InMemoryMlsStateStore(),
  ): Promise<{ alice: MlsProvider; bob: MlsProvider }> {
    const alice = await makeProvider('alice', aliceStore);
    const bob = await makeProvider('bob', bobStore);
    await alice.manager.publishKeyPackage();
    await bob.manager.publishKeyPackage();
    await alice.manager.createGroup(roomId, ['bob']);

    const welcomeEntry = ds.welcomeQueue.get('bob')?.[0];
    if (!welcomeEntry) throw new Error('setup: no welcome queued for bob');
    await bob.manager.processWelcome(roomId, b64ToBytes(welcomeEntry.welcome_b64));
    return { alice, bob };
  }

  // ---- T1: in-memory replay guard -----------------------------------------

  it('T1 — an application message cannot be unsealed twice (in-memory guard)', async () => {
    const roomId = 'room-t1';
    const { alice, bob } = await setupTwoMembers(roomId);

    const sealed = await alice.seal(strToBuf('T1 hello'), { roomId, senderUid: 'alice' });
    const opened = await bob.unseal(sealed, { roomId, senderUid: 'alice' });
    expect(dec.decode(opened)).toBe('T1 hello');

    // Same bytes again → must throw ReplayError, not a generic decrypt failure.
    // A test that passes because keys rotated proves nothing.
    await expect(
      bob.unseal(sealed, { roomId, senderUid: 'alice' }),
    ).rejects.toBeInstanceOf(ReplayError);

    alice.dispose();
    bob.dispose();
  });

  // ---- T2: guard does not wedge the channel -------------------------------

  it('T2 — after the rejected replay, a fresh message still unseals', async () => {
    const roomId = 'room-t2';
    const { alice, bob } = await setupTwoMembers(roomId);

    const sealed1 = await alice.seal(strToBuf('T2 first'), { roomId, senderUid: 'alice' });
    await bob.unseal(sealed1, { roomId, senderUid: 'alice' });

    // Replay — rejected.
    await expect(
      bob.unseal(sealed1, { roomId, senderUid: 'alice' }),
    ).rejects.toBeInstanceOf(ReplayError);

    // Fresh message — must still unseal (channel not wedged).
    const sealed2 = await alice.seal(strToBuf('T2 second'), { roomId, senderUid: 'alice' });
    const opened2 = await bob.unseal(sealed2, { roomId, senderUid: 'alice' });
    expect(dec.decode(opened2)).toBe('T2 second');

    alice.dispose();
    bob.dispose();
  });

  // ---- T3: durable cross-reload replay guard ------------------------------

  // sframe-ratchet arms the durable guard only when IndexedDB AND Web Locks are
  // both present. Read the capability the same way it does, rather than testing
  // a version number — a runtime that gains Web Locks should light this up
  // without an edit here.
  const DURABLE_GUARD_AVAILABLE =
    typeof indexedDB !== 'undefined' &&
    typeof (globalThis as { navigator?: { locks?: { request?: unknown } } })
      .navigator?.locks?.request === 'function';

  describe.skipIf(!DURABLE_GUARD_AVAILABLE)('T3 — durable cross-reload replay', () => {
    const roomId = 'room-t3';
    const MLS_DB = 'test-mls-reload-state';
    // Unique durable namespace for T3 — avoids cross-test contamination with
    // T1/T2 (which use the default 'oxpulse-mls' namespace) AND avoids the
    // deleteDatabase hang: fake-indexeddb keeps IDB connections alive after
    // dispose(), so deleteDatabase on 'sframe-replay/oxpulse-mls' would be
    // blocked by T1/T2's open connections, which in turn blocks T3's
    // indexedDB.open inside the durable guard's check().
    const DURABLE_NS = 'oxpulse-mls-t3';

    beforeEach(async () => {
      // Clear the MLS state store (idb-keyval clear, not deleteDatabase).
      await clearIdbStore(`${MLS_DB}/client-states`, 'client-states');
    });

    it('a ciphertext accepted by the first instance is rejected by the second', { timeout: 30000 }, async () => {
      // Session 1: Bob receives and unseals a frame — CTR recorded durably
      // in the sframe-replay/<DURABLE_NS> IDB database.
      const alice1 = await makeProvider('alice', new InMemoryMlsStateStore(), DURABLE_NS);
      const bob1 = await makeProvider('bob', new IdbMlsStateStore(MLS_DB), DURABLE_NS);
      await alice1.manager.publishKeyPackage();
      await bob1.manager.publishKeyPackage();
      await alice1.manager.createGroup(roomId, ['bob']);
      const welcomeEntry = ds.welcomeQueue.get('bob')?.[0];
      if (!welcomeEntry) throw new Error('T3: no welcome queued for bob');
      await bob1.manager.processWelcome(roomId, b64ToBytes(welcomeEntry.welcome_b64));

      const sealed = await alice1.seal(strToBuf('T3 durable'), { roomId, senderUid: 'alice' });
      const opened = await bob1.unseal(sealed, { roomId, senderUid: 'alice' });
      expect(dec.decode(opened)).toBe('T3 durable');

      // Simulate reload: dispose Bob1, create Bob2 with the same IDB stores.
      // The durable replay guard's IDB data persists across provider instances.
      bob1.dispose();
      alice1.dispose();

      const bob2 = await makeProvider('bob', new IdbMlsStateStore(MLS_DB), DURABLE_NS);
      // restoreAll loads Bob's MLS ClientState from IDB and calls setEpoch,
      // installing the same AEAD keys Bob1 had.
      await bob2.manager.restoreAll();

      // Bob2 has a fresh in-memory window — only the durable guard can catch
      // this. Assert the error is a ReplayError with the DURABLE message,
      // not the in-memory one.
      await expect(
        bob2.unseal(sealed, { roomId, senderUid: 'alice' }),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof ReplayError)) return false;
        return String((err as Error).message).includes('durable cross-reload');
      });

      bob2.dispose();
    });
  });

  // ---- T4: handshake message (commit) cannot be applied twice -------------

  it('T4 — a handshake message (commit) cannot be applied twice', async () => {
    const roomId = 'room-t4';
    const { alice, bob } = await setupTwoMembers(roomId);

    // Add Carol to generate a commit that Bob must process.
    const carol = await makeProvider('carol', new InMemoryMlsStateStore());
    await carol.manager.publishKeyPackage();
    await alice.manager.addMember(roomId, 'carol');

    // The commit is the last MLS message in the DS queue for this room.
    // createGroup broadcast one commit (adding Bob); addMember broadcast
    // another (adding Carol). We want the addMember commit.
    const msgs = ds.mlsMessages.get(roomId) ?? [];
    const commitB64 = msgs[msgs.length - 1];
    if (!commitB64) throw new Error('T4: no commit in DS queue');
    const commitBytes = b64ToBytes(commitB64);

    const epochBefore = bob.manager.getEpoch(roomId);
    expect(epochBefore).not.toBeNull();

    // First process — epoch advances.
    await bob.manager.processMessage(roomId, commitBytes);
    const epochAfter = bob.manager.getEpoch(roomId);
    expect(epochAfter).not.toBeNull();
    expect(epochAfter!).toBeGreaterThan(epochBefore!);

    // Second process — same commit. ts-mls rejects a commit whose
    // previous_epoch doesn't match the current state epoch (the state has
    // already advanced past it). The epoch must NOT advance.
    //
    // Measured behaviour: ts-mls throws (the commit's epoch is stale relative
    // to the current state). MLSGroupManager.processMessage does not catch
    // this, so the error propagates.
    await expect(
      bob.manager.processMessage(roomId, commitBytes),
    ).rejects.toThrow();

    const epochFinal = bob.manager.getEpoch(roomId);
    expect(epochFinal).toBe(epochAfter);

    alice.dispose();
    bob.dispose();
    carol.dispose();
  });
});
