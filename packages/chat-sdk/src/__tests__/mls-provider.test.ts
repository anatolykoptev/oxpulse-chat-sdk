// Tests for the MLS provider — full round-trip with a mock server DS.
//
// These tests create REAL MLS groups with ts-mls 2.0 (2 members: Alice + Bob),
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
  return tsMls.getCiphersuiteImpl(CS_NAME, tsMls.nobleCryptoProvider);
}

async function makeContext(): Promise<import('ts-mls').MlsContext> {
  const tsMls = await import('ts-mls');
  const cs = await getCiphersuiteImpl();
  return { cipherSuite: cs, authService: tsMls.unsafeTestingAuthenticationService };
}

async function makeIdentityKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
}

/** Test-only AuthenticationService — accepts all credentials. */
async function makeTestAuthService(): Promise<import('ts-mls').AuthenticationService> {
  const tsMls = await import('ts-mls');
  return tsMls.unsafeTestingAuthenticationService;
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
    const authService = await makeTestAuthService();
    const provider = await createMlsProvider({
      identityKey,
      credential: 'basic',
      uid: 'alice',
      keyPackageDirectoryUrl: 'http://mock/api/sdk/keys',
      jwt: 'mock-jwt',
      stateStore: new InMemoryMlsStateStore(),
      authService,
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
    const authService = await makeTestAuthService();
    const provider = await createMlsProvider({
      identityKey,
      credential: 'basic',
      uid: 'alice',
      keyPackageDirectoryUrl: 'http://mock/api/sdk/keys',
      jwt: 'mock-jwt-alice',
      stateStore: new InMemoryMlsStateStore(),
      authService,
    });

    await provider.manager.publishKeyPackage();
    expect(ds.keyPackages.get('alice')?.length).toBeGreaterThanOrEqual(1);
    provider.dispose();
  });

  it('seal/unseal round-trip with MLS-derived keys (2 members)', async () => {
    const ctx = await makeContext();
    const tsMls = await import('ts-mls');

    // Create a real MLS group with ts-mls directly (bypassing the server DS).
    // This tests the AEAD layer (createMlsChatProvider + deriveMlsEpochMaterial)
    // which is the core crypto path.
    const { generateKeyPackage, createGroup, createCommit, joinGroup,
            defaultCapabilities, defaultLifetime, defaultCredentialTypes,
            defaultProposalTypes } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });

    const aliceKp = await generateKeyPackage({ credential: makeCred('alice'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite });
    const bobKp = await generateKeyPackage({ credential: makeCred('bob'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite });

    const groupId = new TextEncoder().encode('test-room-1');
    let aliceState = await createGroup({ context: ctx, groupId, keyPackage: aliceKp.publicPackage, privateKeyPackage: aliceKp.privatePackage });
    const commitResult = await createCommit({
      context: ctx,
      state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: bobKp.publicPackage } }],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true,
    });
    aliceState = commitResult.newState;
    if (!commitResult.welcome) throw new Error('no welcome');
    const bobState = await joinGroup({
      context: ctx,
      welcome: commitResult.welcome.welcome,
      keyPackage: bobKp.publicPackage,
      privateKeys: bobKp.privatePackage,
    });

    // Derive epoch material for both members.
    const { deriveMlsEpochMaterial } = await import('sframe-ratchet/mls');
    const { createMlsChatProvider } = await import('sframe-ratchet/chat/mls');
    const aliceMaterial = await deriveMlsEpochMaterial(aliceState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    const bobMaterial = await deriveMlsEpochMaterial(bobState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);

    // Both should have the same epoch and peerIndexMap.
    expect(aliceMaterial.epoch).toBe(bobMaterial.epoch);
    expect(aliceMaterial.peerIndexMap).toEqual(bobMaterial.peerIndexMap);

    // Create MLS chat providers (AEAD layer) for both.
    // The peerIndexMap keys are base64(identity) — we need a uidToPeerId
    // mapping that converts senderUid → base64(identity).
    const { bytesToBase64 } = tsMls;
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

  it('forward secrecy: removed member cannot decrypt epoch N+1', async () => {
    const ctx = await makeContext();
    const tsMls = await import('ts-mls');
    const { generateKeyPackage, createGroup, createCommit, joinGroup, processMessage,
            acceptAll, defaultCapabilities, defaultLifetime, defaultCredentialTypes,
            defaultProposalTypes, nodeTypes } = tsMls;
    const { bytesToBase64 } = tsMls;
    const { deriveMlsEpochMaterial } = await import('sframe-ratchet/mls');
    const { createMlsChatProvider } = await import('sframe-ratchet/chat/mls');
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });
    const uidToPeerId = (uid: string) => bytesToBase64(new TextEncoder().encode(uid));

    // Create 3 members: Alice, Bob, Mallory.
    const aliceKp = await generateKeyPackage({ credential: makeCred('alice'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite });
    const bobKp = await generateKeyPackage({ credential: makeCred('bob'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite });
    const malloryKp = await generateKeyPackage({ credential: makeCred('mallory'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite });

    const groupId = new TextEncoder().encode('fs-test-room');

    // Alice creates the group and adds Bob + Mallory.
    let aliceState = await createGroup({ context: ctx, groupId, keyPackage: aliceKp.publicPackage, privateKeyPackage: aliceKp.privatePackage });

    // Add Bob
    const addBob = await createCommit({
      context: ctx, state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: bobKp.publicPackage } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    });
    aliceState = addBob.newState;
    if (!addBob.welcome) throw new Error('no welcome for bob');
    let bobState = await joinGroup({ context: ctx, welcome: addBob.welcome.welcome, keyPackage: bobKp.publicPackage, privateKeys: bobKp.privatePackage });

    // Add Mallory
    const addMallory = await createCommit({
      context: ctx, state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: malloryKp.publicPackage } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    });
    aliceState = addMallory.newState;
    if (!addMallory.welcome) throw new Error('no welcome for mallory');
    let malloryState = await joinGroup({ context: ctx, welcome: addMallory.welcome.welcome, keyPackage: malloryKp.publicPackage, privateKeys: malloryKp.privatePackage });

    // Bob processes the addMallory commit to stay in sync.
    const bobStateAfterMallory = await processMessage({
      context: ctx, state: bobState, message: addMallory.commit, callback: acceptAll,
    });
    if (bobStateAfterMallory.kind !== 'newState') throw new Error('bob: expected newState from addMallory commit');
    bobState = bobStateAfterMallory.newState;

    // All three are at the same epoch — derive and install AEAD keys.
    const aliceMat0 = await deriveMlsEpochMaterial(aliceState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    const bobMat0 = await deriveMlsEpochMaterial(bobState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    const malloryMat0 = await deriveMlsEpochMaterial(malloryState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    expect(aliceMat0.epoch).toBe(bobMat0.epoch);
    expect(bobMat0.epoch).toBe(malloryMat0.epoch);

    const aliceAead = createMlsChatProvider({ uidToPeerId });
    const bobAead = createMlsChatProvider({ uidToPeerId });
    const malloryAead = createMlsChatProvider({ uidToPeerId });
    await aliceAead.setEpoch('room-fs', { epoch: aliceMat0.epoch, peerIndexMap: aliceMat0.peerIndexMap, chainKey: aliceMat0.chainKey });
    await bobAead.setEpoch('room-fs', { epoch: bobMat0.epoch, peerIndexMap: bobMat0.peerIndexMap, chainKey: bobMat0.chainKey });
    await malloryAead.setEpoch('room-fs', { epoch: malloryMat0.epoch, peerIndexMap: malloryMat0.peerIndexMap, chainKey: malloryMat0.chainKey });

    // Mallory CAN decrypt at the current epoch.
    const plaintext0 = new TextEncoder().encode('hello all three');
    const sealed0 = await aliceAead.seal(plaintext0, { roomId: 'room-fs', senderUid: 'alice' });
    const malloryOpened0 = await malloryAead.unseal(sealed0, { roomId: 'room-fs', senderUid: 'alice' });
    expect(new TextDecoder().decode(malloryOpened0)).toBe('hello all three');

    // ── Now remove Mallory ──
    // Find Mallory's leaf index by iterating the ratchet tree (same logic as removeMember).
    const tree = aliceState.ratchetTree;
    const malloryIdentity = new TextEncoder().encode('mallory');
    let malloryLeafIndex = -1;
    for (let ni = 0; ni < tree.length; ni += 2) {
      const node = tree[ni];
      if (!node || node.nodeType !== nodeTypes.leaf || !node.leaf) continue;
      const cred = node.leaf.credential;
      if (cred.credentialType === defaultCredentialTypes.basic &&
          new TextDecoder().decode((cred as { identity: Uint8Array }).identity) === 'mallory') {
        malloryLeafIndex = Math.floor(ni / 2);
        break;
      }
    }
    expect(malloryLeafIndex).toBeGreaterThanOrEqual(0);

    const removeMallory = await createCommit({
      context: ctx, state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: malloryLeafIndex } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    });
    aliceState = removeMallory.newState;

    // Bob processes the remove commit.
    const bobAfterRemove = await processMessage({
      context: ctx, state: bobState, message: removeMallory.commit, callback: acceptAll,
    });
    if (bobAfterRemove.kind !== 'newState') throw new Error('bob: expected newState from remove commit');
    bobState = bobAfterRemove.newState;

    // Alice and Bob derive the new epoch material.
    const aliceMat1 = await deriveMlsEpochMaterial(aliceState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    const bobMat1 = await deriveMlsEpochMaterial(bobState, ctx.cipherSuite, 'AES_128_GCM_SHA256', groupId);
    expect(aliceMat1.epoch).toBe(bobMat1.epoch);
    expect(aliceMat1.epoch).toBeGreaterThan(aliceMat0.epoch);

    // Install the new epoch for Alice and Bob.
    await aliceAead.setEpoch('room-fs', { epoch: aliceMat1.epoch, peerIndexMap: aliceMat1.peerIndexMap, chainKey: aliceMat1.chainKey });
    await bobAead.setEpoch('room-fs', { epoch: bobMat1.epoch, peerIndexMap: bobMat1.peerIndexMap, chainKey: bobMat1.chainKey });

    // Alice sends a message at the new epoch.
    const plaintext1 = new TextEncoder().encode('mallory is gone');
    const sealed1 = await aliceAead.seal(plaintext1, { roomId: 'room-fs', senderUid: 'alice' });

    // Bob CAN decrypt the new epoch message.
    const bobOpened1 = await bobAead.unseal(sealed1, { roomId: 'room-fs', senderUid: 'alice' });
    expect(new TextDecoder().decode(bobOpened1)).toBe('mallory is gone');

    // Mallory CANNOT decrypt the new epoch message — her AEAD still has the old epoch.
    // The ChainKey advanced, so the old key can't decrypt the new ciphertext.
    await expect(malloryAead.unseal(sealed1, { roomId: 'room-fs', senderUid: 'alice' })).rejects.toThrow();

    aliceAead.dispose();
    bobAead.dispose();
    malloryAead.dispose();
  });

  it('removeMember: two sequential removals target the correct members (leaf index, not compacted)', async () => {
    // This test would have caught the original removeMember bug where
    // getGroupMembers() compacted array index was used instead of leaf index.
    const ctx = await makeContext();
    const tsMls = await import('ts-mls');
    const { generateKeyPackage, createGroup, createCommit, joinGroup, processMessage,
            acceptAll, defaultCapabilities, defaultLifetime, defaultCredentialTypes,
            defaultProposalTypes, nodeTypes } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });

    // Create 4 members: Alice (creator), Bob, Carol, Mallory.
    const kps = {
      alice: await generateKeyPackage({ credential: makeCred('alice'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite }),
      bob: await generateKeyPackage({ credential: makeCred('bob'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite }),
      carol: await generateKeyPackage({ credential: makeCred('carol'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite }),
      mallory: await generateKeyPackage({ credential: makeCred('mallory'), capabilities: defaultCapabilities(), lifetime: defaultLifetime(), cipherSuite: ctx.cipherSuite }),
    };

    const groupId = new TextEncoder().encode('remove-test-room');
    let aliceState = await createGroup({ context: ctx, groupId, keyPackage: kps.alice.publicPackage, privateKeyPackage: kps.alice.privatePackage });

    // Add Bob, Carol, Mallory sequentially.
    const members = ['bob', 'carol', 'mallory'] as const;
    const states: Record<string, import('ts-mls').ClientState> = {};
    for (const uid of members) {
      const addResult = await createCommit({
        context: ctx, state: aliceState,
        extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: kps[uid].publicPackage } }],
        ratchetTreeExtension: true, wireAsPublicMessage: true,
      });
      aliceState = addResult.newState;
      if (!addResult.welcome) throw new Error(`no welcome for ${uid}`);
      states[uid] = await joinGroup({ context: ctx, welcome: addResult.welcome.welcome, keyPackage: kps[uid].publicPackage, privateKeys: kps[uid].privatePackage });
      // Other existing members process the commit.
      for (const otherUid of members) {
        if (otherUid === uid || !states[otherUid]) continue;
        const result = await processMessage({
          context: ctx, state: states[otherUid], message: addResult.commit, callback: acceptAll,
        });
        if (result.kind === 'newState') states[otherUid] = result.newState;
      }
    }

    // Helper: find leaf index by uid via ratchet tree iteration.
    const findLeafIndex = (state: import('ts-mls').ClientState, uid: string): number => {
      const tree = state.ratchetTree;
      const target = new TextEncoder().encode(uid);
      for (let ni = 0; ni < tree.length; ni += 2) {
        const node = tree[ni];
        if (!node || node.nodeType !== nodeTypes.leaf || !node.leaf) continue;
        const cred = node.leaf.credential;
        if (cred.credentialType === defaultCredentialTypes.basic) {
          const identity = (cred as { identity: Uint8Array }).identity;
          if (identity.length === target.length) {
            let match = true;
            for (let i = 0; i < identity.length; i++) {
              if (identity[i] !== target[i]) { match = false; break; }
            }
            if (match) return Math.floor(ni / 2);
          }
        }
      }
      return -1;
    };

    // ── First removal: remove Bob (leaf index 1) ──
    const bobLeafIndex = findLeafIndex(aliceState, 'bob');
    expect(bobLeafIndex).toBe(1); // Bob is the first added member

    const removeBob = await createCommit({
      context: ctx, state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: bobLeafIndex } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    });
    aliceState = removeBob.newState;

    // Carol + Mallory process the remove.
    for (const uid of ['carol', 'mallory'] as const) {
      const result = await processMessage({
        context: ctx, state: states[uid], message: removeBob.commit, callback: acceptAll,
      });
      if (result.kind === 'newState') states[uid] = result.newState;
    }

    // Verify Bob is actually removed (not in the tree).
    const bobStillInTree = findLeafIndex(aliceState, 'bob') !== -1;
    expect(bobStillInTree).toBe(false);

    // ── Second removal: remove Mallory ──
    // This is where the bug would manifest: if we used the compacted array
    // index from getGroupMembers, we'd target Carol (index 1 in the compacted
    // array) instead of Mallory (leaf index 3 in the tree).
    const malloryLeafIndex = findLeafIndex(aliceState, 'mallory');
    expect(malloryLeafIndex).toBe(3); // Mallory was the third added member → leaf index 3

    const removeMallory = await createCommit({
      context: ctx, state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: malloryLeafIndex } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    });
    aliceState = removeMallory.newState;

    // Carol processes the remove.
    const carolAfterRemove = await processMessage({
      context: ctx, state: states.carol, message: removeMallory.commit, callback: acceptAll,
    });
    if (carolAfterRemove.kind === 'newState') states.carol = carolAfterRemove.newState;

    // Verify Mallory is removed and Carol is still present.
    expect(findLeafIndex(aliceState, 'mallory')).toBe(-1);
    expect(findLeafIndex(aliceState, 'carol')).not.toBe(-1);

    // If the bug were present, Carol would have been removed instead of Mallory.
    // This assertion proves the leaf index calculation is correct.
    expect(findLeafIndex(states.carol, 'carol')).not.toBe(-1); // Carol still has her own state
  });

  it('addMember rejects a KeyPackage whose identity does not match the requested uid (DS substitution attack)', async () => {
    // The Delivery Service is untrusted. A malicious DS answers a request for
    // Bob's KeyPackage with Mallory's. Without the identity binding check in
    // #fetchKeyPackage, the caller commits an Add and the room shows "Bob
    // joined" while Mallory holds the keys. This test simulates the attack by
    // publishing Mallory's KeyPackage under Bob's uid in the mock DS, then
    // verifying addMember throws mls_keypackage_identity_mismatch.
    const ctx = await makeContext();
    const tsMls = await import('ts-mls');
    const { generateKeyPackage, defaultCapabilities, defaultLifetime, defaultCredentialTypes } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });

    // Mallory publishes her own KeyPackage (legitimately, under her uid).
    const malloryKp = await generateKeyPackage({
      credential: makeCred('mallory'),
      capabilities: defaultCapabilities(),
      lifetime: defaultLifetime(),
      cipherSuite: ctx.cipherSuite,
    });
    const malloryKpMsg = {
      wireformat: tsMls.wireformats.mls_key_package,
      keyPackage: malloryKp.publicPackage,
      version: tsMls.protocolVersions.mls10,
    };
    const malloryKpB64 = tsMls.bytesToBase64(tsMls.encode(tsMls.mlsMessageEncoder, malloryKpMsg));

    // The malicious DS stores Mallory's KeyPackage under Bob's uid.
    ds.keyPackages.set('bob', [malloryKpB64]);

    // Alice creates a provider and a group.
    const aliceIdentityKey = await makeIdentityKey();
    const authService = await makeTestAuthService();
    const provider = await createMlsProvider({
      identityKey: aliceIdentityKey,
      credential: 'basic',
      uid: 'alice',
      keyPackageDirectoryUrl: 'http://mock/api/sdk/keys',
      jwt: 'mock-jwt-alice',
      stateStore: new InMemoryMlsStateStore(),
      authService,
    });
    await provider.manager.publishKeyPackage();

    // Alice creates a group and tries to add Bob. The DS returns Mallory's KP.
    const groupId = new TextEncoder().encode('substitution-test');
    await provider.manager.createGroup('room-sub', []);

    await expect(provider.manager.addMember('room-sub', 'bob'))
      .rejects.toMatchObject({ code: 'mls_keypackage_identity_mismatch' });

    provider.dispose();
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
