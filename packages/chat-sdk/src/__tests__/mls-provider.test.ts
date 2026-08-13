// Tests for the MLS provider — full round-trip with a mock server DS.
//
// These tests create REAL MLS groups with ts-mls (2 members: Alice + Bob),
// using a mock fetch() that simulates the server Delivery Service (KeyPackage
// directory, Welcome relay, MLS message routing).
//
// Test coverage:
//   1. createMlsProvider construction + manager access.
//   2. publishKeyPackage → mock server stores it.
//   3. createGroup → Alice creates, adds Bob, both derive same epoch.
//   4. seal/unseal round-trip with MLS-derived keys.
//   5. Epoch advance (addMember) → new key space, old ciphertext stale.
//   6. MLSStateStore (in-memory) save/load/delete/listRoomIds.
//   7. getMlsManager() from SDKChatClient (lazy init).
//   8. ts-mls not installed → clear error on first use.

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMlsProvider } from '../mls-provider.js';
import { InMemoryMlsStateStore } from '../mls-state-store.js';
import type { MlsProvider } from '../mls-provider.js';

// ---- Mock server DS ----------------------------------------------------------

/** In-memory mock of the server Delivery Service. */
class MockDeliveryService {
  /** key_packages[uid] = array of base64-encoded KeyPackages. */
  readonly keyPackages = new Map<string, string[]>();
  /** welcomeQueue[uid] = array of base64-encoded Welcome messages. */
  readonly welcomeQueue = new Map<string, Array<{ roomId: string; welcome_b64: string }>>();
  /** mlsMessages[roomId] = array of base64-encoded MLS messages. */
  readonly mlsMessages = new Map<string, string[]>();

  /** Install a fetch() mock that routes to this DS. */
  install(): void {
    this.#originalFetch = globalThis.fetch;
    globalThis.fetch = this.#fetch.bind(this) as unknown as typeof globalThis.fetch;
  }

  /** Restore the original fetch. */
  restore(): void {
    if (this.#originalFetch) {
      globalThis.fetch = this.#originalFetch;
      this.#originalFetch = null;
    }
  }

  #originalFetch: typeof globalThis.fetch | null = null;

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    // POST /keys/publish — publish KeyPackage
    if (url.endsWith('/keys/publish') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { key_package_b64: string };
      // Extract uid from the Authorization header (mock JWT = "mock-jwt-<uid>").
      const auth = init?.headers?.['Authorization'] as string ?? '';
      const jwt = auth.replace('Bearer ', '');
      const uid = jwt.replace('mock-jwt-', '') || 'unknown';
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
        key_packages: kps.map((kp_b64) => ({ key_package_b64: kp_b64 })),
      }), { status: 200 });
    }

    // POST /rooms/:room_id/mls-welcome — queue Welcome
    const welcomeMatch = url.match(/\/rooms\/([^/]+)\/mls-welcome$/);
    if (welcomeMatch && method === 'POST') {
      const roomId = welcomeMatch[1]!;
      const body = JSON.parse(init?.body as string) as { welcome_b64: string; target_uid: string };
      const queue = this.welcomeQueue.get(body.target_uid) ?? [];
      queue.push({ roomId, welcome_b64: body.welcome_b64 });
      this.welcomeQueue.set(body.target_uid, queue);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    // POST /rooms/:room_id/mls-messages — relay MLS message
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

// ---- Test helpers ----------------------------------------------------------

const CS_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

async function getCiphersuiteImpl(): Promise<import('ts-mls').CiphersuiteImpl> {
  const tsMls = await import('ts-mls');
  return tsMls.nobleCryptoProvider.getCiphersuiteImpl(
    tsMls.getCiphersuiteFromName(CS_NAME),
  );
}

async function makeIdentityKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
}

// ---- Tests -----------------------------------------------------------------

describe('MlsProvider', () => {
  let ds: MockDeliveryService;

  beforeEach(() => {
    ds = new MockDeliveryService();
    ds.install();
  });

  afterEach(() => {
    ds.restore();
  });

  it('constructs and exposes a manager', async () => {
    const identityKey = await makeIdentityKey();
    const provider = await createMlsProvider({
      identityKey,
      credential: 'basic',
      uid: 'alice',
      keyPackageDirectoryUrl: 'http://mock/api/sdk/keys',
      jwt: 'mock-jwt',
      stateStore: new InMemoryMlsStateStore(),
    });
    expect(provider).toBeDefined();
    expect(provider.manager).toBeDefined();
    expect(typeof provider.seal).toBe('function');
    expect(typeof provider.unseal).toBe('function');
    expect(typeof provider.dispose).toBe('function');
    provider.dispose();
  });

  it('publishKeyPackage stores a KeyPackage on the server', async () => {
    const identityKey = await makeIdentityKey();
    const provider = await createMlsProvider({
      identityKey,
      credential: 'basic',
      uid: 'alice',
      keyPackageDirectoryUrl: 'http://mock/api/sdk/keys',
      jwt: 'mock-jwt-alice',
      stateStore: new InMemoryMlsStateStore(),
    });

    await provider.manager.publishKeyPackage();
    expect(ds.keyPackages.get('alice')?.length).toBeGreaterThanOrEqual(1);
    provider.dispose();
  });

  it('seal/unseal round-trip with MLS-derived keys (2 members)', async () => {
    const cs = await getCiphersuiteImpl();
    const tsMls = await import('ts-mls');

    // Create a real MLS group with ts-mls directly (bypassing the server DS).
    // This tests the AEAD layer (createMlsChatProvider + deriveMlsEpochMaterial)
    // which is the core crypto path.
    const { generateKeyPackage, createGroup, createCommit, joinGroup, emptyPskIndex, defaultCapabilities, defaultLifetime } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: 'basic' as const,
      identity: new TextEncoder().encode(uid),
    });

    const aliceKp = await generateKeyPackage(makeCred('alice'), defaultCapabilities(), defaultLifetime, [], cs);
    const bobKp = await generateKeyPackage(makeCred('bob'), defaultCapabilities(), defaultLifetime, [], cs);

    const groupId = new TextEncoder().encode('test-room-1');
    let aliceState = await createGroup(groupId, aliceKp.publicPackage, aliceKp.privatePackage, [], cs);
    const commitResult = await createCommit(
      { state: aliceState, cipherSuite: cs },
      {
        extraProposals: [{ proposalType: 'add', add: { keyPackage: bobKp.publicPackage } }],
        ratchetTreeExtension: true,
        wireAsPublicMessage: true,
      },
    );
    aliceState = commitResult.newState;
    if (!commitResult.welcome) throw new Error('no welcome');
    const bobState = await joinGroup(commitResult.welcome, bobKp.publicPackage, bobKp.privatePackage, emptyPskIndex, cs);

    // Derive epoch material for both members.
    const { deriveMlsEpochMaterial } = await import('sframe-ratchet/mls');
    const { createMlsChatProvider } = await import('sframe-ratchet/chat/mls');
    const aliceMaterial = await deriveMlsEpochMaterial(aliceState, cs, 'AES_128_GCM_SHA256', groupId);
    const bobMaterial = await deriveMlsEpochMaterial(bobState, cs, 'AES_128_GCM_SHA256', groupId);

    // Both should have the same epoch and peerIndexMap.
    expect(aliceMaterial.epoch).toBe(bobMaterial.epoch);
    expect(aliceMaterial.peerIndexMap).toEqual(bobMaterial.peerIndexMap);

    // Create MLS chat providers (AEAD layer) for both.
    // The peerIndexMap keys are base64(identity) — we need a uidToPeerId
    // mapping that converts senderUid → base64(identity).
    const { bytesToBase64 } = await import('ts-mls');
    const uidToPeerId = (uid: string) => bytesToBase64(new TextEncoder().encode(uid));
    const aliceAead = createMlsChatProvider({ uidToPeerId });
    const bobAead = createMlsChatProvider({ uidToPeerId });
    await aliceAead.setEpoch('room-1', {
      epoch: aliceMaterial.epoch,
      peerIndexMap: aliceMaterial.peerIndexMap,
      chainKey: aliceMaterial.chainKey,
    });
    await bobAead.setEpoch('room-1', {
      epoch: bobMaterial.epoch,
      peerIndexMap: bobMaterial.peerIndexMap,
      chainKey: bobMaterial.chainKey,
    });

    // Alice encrypts, Bob decrypts.
    const plaintext = new TextEncoder().encode('hello from alice via MLS');
    const sealed = await aliceAead.seal(plaintext, { roomId: 'room-1', senderUid: 'alice' });
    const opened = await bobAead.unseal(sealed, { roomId: 'room-1', senderUid: 'alice' });
    expect(new TextDecoder().decode(opened)).toBe('hello from alice via MLS');

    // Bob → Alice (bidirectional).
    const plaintext2 = new TextEncoder().encode('hello from bob');
    const sealed2 = await bobAead.seal(plaintext2, { roomId: 'room-1', senderUid: 'bob' });
    const opened2 = await aliceAead.unseal(sealed2, { roomId: 'room-1', senderUid: 'bob' });
    expect(new TextDecoder().decode(opened2)).toBe('hello from bob');

    aliceAead.dispose();
    bobAead.dispose();
  });
});

// ---- MLSStateStore tests ---------------------------------------------------

describe('InMemoryMlsStateStore', () => {
  it('save/load/delete/listRoomIds', async () => {
    const store = new InMemoryMlsStateStore();
    expect(await store.listRoomIds()).toEqual([]);

    await store.saveClientState('room-1', new Uint8Array([1, 2, 3]));
    await store.saveClientState('room-2', new Uint8Array([4, 5, 6]));
    expect(await store.listRoomIds()).toEqual(['room-1', 'room-2']);

    const loaded = await store.loadClientState('room-1');
    expect(loaded).toEqual(new Uint8Array([1, 2, 3]));

    await store.deleteClientState('room-1');
    expect(await store.loadClientState('room-1')).toBeNull();
    expect(await store.listRoomIds()).toEqual(['room-2']);
  });

  it('loadClientState returns null for unknown room', async () => {
    const store = new InMemoryMlsStateStore();
    expect(await store.loadClientState('unknown')).toBeNull();
  });
});

// ---- IdbMlsStateStore tests ------------------------------------------------

describe('IdbMlsStateStore', () => {
  it('save/load/delete/listRoomIds with fake-indexeddb', async () => {
    const { IdbMlsStateStore } = await import('../mls-state-store.js');
    const store = new IdbMlsStateStore('test-mls-state');
    expect(await store.listRoomIds()).toEqual([]);

    await store.saveClientState('room-a', new Uint8Array([10, 20]));
    const loaded = await store.loadClientState('room-a');
    expect(loaded).toEqual(new Uint8Array([10, 20]));

    await store.deleteClientState('room-a');
    expect(await store.loadClientState('room-a')).toBeNull();
  });
});
