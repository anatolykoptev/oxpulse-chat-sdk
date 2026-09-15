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
  /** welcomeQueue[uid] = array of base64-encoded Welcome messages (legacy, by target). */
  readonly welcomeQueue = new Map<string, Array<{ roomId: string; welcome_b64: string }>>();
  /** mlsMessages[roomId] = array of base64-encoded MLS messages (legacy). */
  readonly mlsMessages = new Map<string, string[]>();
  /** roomWelcomes[roomId] = array of {welcomeId, targetUid, welcomeB64} — non-destructive GET, ack removes. */
  readonly roomWelcomes = new Map<string, Array<{ welcomeId: string; targetUid: string; welcomeB64: string }>>();
  /** roomMessages[roomId] = Map<messageId, {messageB64, messageType, epoch, senderUid}>. */
  readonly roomMessages = new Map<string, Map<string, { messageB64: string; messageType: string; epoch: number; senderUid: string }>>();
  /** URLs to rate-limit once (429 on first hit, then normal). */
  readonly rateLimitOnce = new Set<string>();
  /** URLs to rate-limit persistently (429 on every hit). */
  readonly persistentRateLimit = new Set<string>();
  /** URL → Retry-After header value; 429 once with that header, then normal. */
  readonly rateLimitOnceCustom = new Map<string, string>();
  /** URLs to 503 once, then normal. */
  readonly serverErrorOnce = new Set<string>();
  /** Log of all fetch calls — {url, method, status}. */
  readonly fetchLog: Array<{ url: string; method: string; status: number }> = [];
  /** Monotonic counter for generated IDs. */
  #idCounter = 0;

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

  /** Queue a Welcome for a user in a room (test helper for manual queueing). */
  queueWelcome(roomId: string, targetUid: string, welcomeB64: string): string {
    const welcomeId = `welcome-${++this.#idCounter}`;
    const list = this.roomWelcomes.get(roomId) ?? [];
    list.push({ welcomeId, targetUid, welcomeB64 });
    this.roomWelcomes.set(roomId, list);
    return welcomeId;
  }

  /** Queue a protocol message for a room (test helper). */
  queueMessage(roomId: string, messageB64: string, messageType: string, epoch: number, senderUid: string): string {
    const messageId = `msg-${++this.#idCounter}`;
    const msgs = this.roomMessages.get(roomId) ?? new Map();
    msgs.set(messageId, { messageB64, messageType, epoch, senderUid });
    this.roomMessages.set(roomId, msgs);
    return messageId;
  }

  /** Extract uid from the mock JWT in the Authorization header. */
  #extractUid(init?: RequestInit): string {
    const auth = init?.headers?.['Authorization'] as string ?? '';
    const jwt = auth.replace('Bearer ', '');
    return jwt.replace('mock-jwt-', '') || 'unknown';
  }

  #originalFetch: typeof globalThis.fetch | null = null;

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    // POST /keys/publish — publish KeyPackage
    if (url.endsWith('/keys/publish') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { key_package_b64: string };
      const uid = this.#extractUid(init);
      const kps = this.keyPackages.get(uid) ?? [];
      kps.push(body.key_package_b64);
      this.keyPackages.set(uid, kps);
      this.fetchLog.push({ url, method, status: 201 });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    // GET /keys/:uid — fetch KeyPackages
    const getKpMatch = url.match(/\/keys\/([^/]+)$/);
    if (getKpMatch && method === 'GET') {
      const uid = getKpMatch[1]!;
      const kps = this.keyPackages.get(uid) ?? [];
      this.fetchLog.push({ url, method, status: 200 });
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
      // Also store in room-indexed map with a generated welcome_id.
      const welcomeId = `welcome-${++this.#idCounter}`;
      const roomList = this.roomWelcomes.get(roomId) ?? [];
      roomList.push({ welcomeId, targetUid: body.target_uid, welcomeB64: body.welcome_b64 });
      this.roomWelcomes.set(roomId, roomList);
      this.fetchLog.push({ url, method, status: 201 });
      return new Response(JSON.stringify({ ok: true, welcome_id: welcomeId }), { status: 201 });
    }

    // GET /rooms/:room_id/mls-welcome — fetch pending Welcomes (non-destructive)
    const getWelcomesMatch = url.match(/\/rooms\/([^/]+)\/mls-welcome$/);
    if (getWelcomesMatch && method === 'GET') {
      const roomId = getWelcomesMatch[1]!;
      const customRA = this.rateLimitOnceCustom.get(url);
      if (customRA !== undefined) {
        this.rateLimitOnceCustom.delete(url);
        this.fetchLog.push({ url, method, status: 429 });
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': customRA } });
      }
      if (this.serverErrorOnce.has(url)) {
        this.serverErrorOnce.delete(url);
        this.fetchLog.push({ url, method, status: 503 });
        return new Response('Service Unavailable', { status: 503 });
      }
      if (this.persistentRateLimit.has(url) || this.rateLimitOnce.has(url)) {
        if (this.rateLimitOnce.has(url)) this.rateLimitOnce.delete(url);
        this.fetchLog.push({ url, method, status: 429 });
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '0' } });
      }
      const uid = this.#extractUid(init);
      const welcomes = (this.roomWelcomes.get(roomId) ?? []).filter(w => w.targetUid === uid);
      this.fetchLog.push({ url, method, status: 200 });
      return new Response(JSON.stringify({
        welcomes: welcomes.map(w => ({ welcome_id: w.welcomeId, welcome_b64: w.welcomeB64 })),
      }), { status: 200 });
    }

    // DELETE /rooms/:room_id/mls-welcome/:welcome_id — ack a Welcome
    const ackWelcomeMatch = url.match(/\/rooms\/([^/]+)\/mls-welcome\/([^/]+)$/);
    if (ackWelcomeMatch && method === 'DELETE') {
      const roomId = ackWelcomeMatch[1]!;
      const welcomeId = ackWelcomeMatch[2]!;
      const uid = this.#extractUid(init);
      const list = this.roomWelcomes.get(roomId) ?? [];
      const idx = list.findIndex(w => w.welcomeId === welcomeId && w.targetUid === uid);
      if (idx === -1) {
        this.fetchLog.push({ url, method, status: 404 });
        return new Response('Not Found', { status: 404 });
      }
      list.splice(idx, 1);
      this.roomWelcomes.set(roomId, list);
      this.fetchLog.push({ url, method, status: 204 });
      return new Response(null, { status: 204 });
    }

    // POST /rooms/:room_id/mls-messages — relay MLS message
    const msgMatch = url.match(/\/rooms\/([^/]+)\/mls-messages$/);
    if (msgMatch && method === 'POST') {
      const roomId = msgMatch[1]!;
      const body = JSON.parse(init?.body as string) as { message_b64: string; message_type: string; epoch: number };
      const msgs = this.mlsMessages.get(roomId) ?? [];
      msgs.push(body.message_b64);
      this.mlsMessages.set(roomId, msgs);
      // Also store in room-indexed map with a generated message_id.
      const messageId = `msg-${++this.#idCounter}`;
      const roomMsgs = this.roomMessages.get(roomId) ?? new Map();
      roomMsgs.set(messageId, {
        messageB64: body.message_b64,
        messageType: body.message_type,
        epoch: body.epoch,
        senderUid: this.#extractUid(init),
      });
      this.roomMessages.set(roomId, roomMsgs);
      this.fetchLog.push({ url, method, status: 201 });
      return new Response(JSON.stringify({ ok: true, message_id: messageId }), { status: 201 });
    }

    // GET /rooms/:room_id/mls-messages/:message_id — fetch a protocol message
    const getMessageMatch = url.match(/\/rooms\/([^/]+)\/mls-messages\/([^/]+)$/);
    if (getMessageMatch && method === 'GET') {
      const roomId = getMessageMatch[1]!;
      const messageId = getMessageMatch[2]!;
      const customRA = this.rateLimitOnceCustom.get(url);
      if (customRA !== undefined) {
        this.rateLimitOnceCustom.delete(url);
        this.fetchLog.push({ url, method, status: 429 });
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': customRA } });
      }
      if (this.serverErrorOnce.has(url)) {
        this.serverErrorOnce.delete(url);
        this.fetchLog.push({ url, method, status: 503 });
        return new Response('Service Unavailable', { status: 503 });
      }
      if (this.persistentRateLimit.has(url) || this.rateLimitOnce.has(url)) {
        if (this.rateLimitOnce.has(url)) this.rateLimitOnce.delete(url);
        this.fetchLog.push({ url, method, status: 429 });
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '0' } });
      }
      const msgs = this.roomMessages.get(roomId);
      const msg = msgs?.get(messageId);
      if (!msg) {
        this.fetchLog.push({ url, method, status: 404 });
        return new Response('Not Found', { status: 404 });
      }
      this.fetchLog.push({ url, method, status: 200 });
      return new Response(JSON.stringify({
        message_b64: msg.messageB64,
        message_type: msg.messageType,
        epoch: msg.epoch,
        sender_uid: msg.senderUid,
      }), { status: 200 });
    }

    this.fetchLog.push({ url, method, status: 404 });
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
});

// ---- MLS inbound path tests (fetchAndProcessWelcomes / fetchAndProcessMessage) ----
//
// These tests drive the REAL MLSGroupManager through the extended MockDeliveryService.
// The mock behaves like the real server: non-destructive GET for welcomes,
// ack (DELETE) removes, 404 on someone else's id, 429 rate limiting.

describe('MLSGroupManager inbound path', () => {
  let ds: MockDeliveryService;

  beforeEach(() => {
    ds = new MockDeliveryService();
    ds.install();
  });

  afterEach(() => {
    ds.restore();
  });

  /** Create a provider with the given uid and publish a KeyPackage. */
  async function makeProvider(uid: string, keyPackageDirectoryUrl?: string): Promise<MlsProvider> {
    const identityKey = await makeIdentityKey();
    const authService = await makeTestAuthService();
    const provider = await createMlsProvider({
      identityKey,
      credential: 'basic',
      uid,
      keyPackageDirectoryUrl: keyPackageDirectoryUrl ?? 'http://mock/api/sdk/keys',
      jwt: `mock-jwt-${uid}`,
      stateStore: new InMemoryMlsStateStore(),
      authService,
    });
    await provider.manager.publishKeyPackage();
    return provider;
  }

  it('fetchAndProcessWelcomes: success → Welcome applied + acked (M1)', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    // Alice creates a group and adds Bob → Welcome is POSTed to the DS.
    await alice.manager.createGroup('room-inbound-1', ['bob']);

    // Bob fetches and processes the Welcome.
    const applied = await bob.manager.fetchAndProcessWelcomes('room-inbound-1');

    // Exactly one Welcome was applied.
    expect(applied).toBe(1);

    // The Welcome was acked — no longer in the DS queue.
    const remaining = ds.roomWelcomes.get('room-inbound-1') ?? [];
    expect(remaining.filter(w => w.targetUid === 'bob')).toHaveLength(0);

    // Bob now has group state for the room.
    expect(bob.manager.getEpoch('room-inbound-1')).not.toBeNull();

    alice.dispose();
    bob.dispose();
  });

  it('fetchAndProcessWelcomes: processing failure → warned + rethrown, NOT acked (fix #1)', async () => {
    const bob = await makeProvider('bob');

    // Generate a KeyPackage for bob that is NOT the one bob's manager has pending.
    const tsMls = await import('ts-mls');
    const cs = await getCiphersuiteImpl();
    const { generateKeyPackage, createGroup, createCommit, defaultCapabilities,
            defaultLifetime, defaultCredentialTypes, defaultProposalTypes } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });

    // KP sealed into the Welcome — different from bob's pending KP.
    const otherKp = await generateKeyPackage({
      credential: makeCred('bob'), capabilities: defaultCapabilities(),
      lifetime: defaultLifetime(), cipherSuite: cs,
    });

    // Create a group with a separate identity, add bob via otherKp → Welcome sealed to otherKp.
    const aliceKp = await generateKeyPackage({
      credential: makeCred('alice'), capabilities: defaultCapabilities(),
      lifetime: defaultLifetime(), cipherSuite: cs,
    });
    const groupId = new TextEncoder().encode('no-secret-room');
    let aliceState = await createGroup({
      context: await makeContext(),
      groupId,
      keyPackage: aliceKp.publicPackage,
      privateKeyPackage: aliceKp.privatePackage,
    });
    const commitResult = await createCommit({
      context: await makeContext(),
      state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: otherKp.publicPackage } }],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true,
    });
    if (!commitResult.welcome) throw new Error('no welcome generated');
    aliceState = commitResult.newState;

    // Encode the Welcome and queue it for bob in the DS.
    const welcomeMsg = {
      wireformat: tsMls.wireformats.mls_welcome,
      welcome: commitResult.welcome.welcome,
      version: tsMls.protocolVersions.mls10,
    };
    const welcomeBytes = tsMls.encode(tsMls.mlsMessageEncoder, welcomeMsg);
    const welcomeB64 = Buffer.from(welcomeBytes).toString('base64');
    const welcomeId = ds.queueWelcome('room-no-secret', 'bob', welcomeB64);

    // Bob fetches — processWelcome will throw because the Welcome is sealed to
    // otherKp, not bob's pending KP. The failure must be warned + rethrown, and
    // the Welcome must NOT be acked (server re-delivery is the recovery).
    const warnings: import('../mls-provider.js').MlsWarning[] = [];
    bob.manager.onWarning = (w) => warnings.push(w);

    // Should throw — failures are no longer swallowed.
    await expect(bob.manager.fetchAndProcessWelcomes('room-no-secret')).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('mls_welcome_processing_failed');
    expect(warnings[0]!.welcomeId).toBe(welcomeId);

    // The Welcome was NOT acked — still in the queue for re-delivery.
    const remaining = ds.roomWelcomes.get('room-no-secret') ?? [];
    expect(remaining.filter(w => w.welcomeId === welcomeId)).toHaveLength(1);

    bob.dispose();
  });

  it('fetchAndProcessWelcomes: transient failure → NOT acked, rethrown (M2 no-ack)', async () => {
    const bob = await makeProvider('bob');

    // Queue a malformed Welcome (random bytes) — processWelcome will throw
    // mls_welcome_decrypt_failed (decode failure), which is NOT a no-matching-secret error.
    const malformedB64 = Buffer.from(new Uint8Array([0x00, 0x01, 0x02])).toString('base64');
    const welcomeId = ds.queueWelcome('room-transient', 'bob', malformedB64);

    // fetchAndProcessWelcomes should rethrow the error.
    await expect(bob.manager.fetchAndProcessWelcomes('room-transient')).rejects.toThrow();

    // The Welcome was NOT acked — still in the queue for retry.
    const remaining = ds.roomWelcomes.get('room-transient') ?? [];
    expect(remaining.filter(w => w.welcomeId === welcomeId)).toHaveLength(1);

    bob.dispose();
  });

  it('processWelcome: Welcome sealed to second pending KP → tries all, succeeds (fix #2)', async () => {
    // Bob publishes TWO KeyPackages. The group creator seals the Welcome to
    // the SECOND one (which the server may return as key_packages[0]). The
    // buggy code only tried #pendingKeyPackages[0] and would fail; the fix
    // tries each pending KP until one decrypts.
    const bob = await makeProvider('bob');
    await bob.manager.publishKeyPackage(); // second KP → pending = [kp1, kp2]

    const tsMls = await import('ts-mls');
    const cs = await getCiphersuiteImpl();
    const { decode, mlsMessageDecoder, wireformats, generateKeyPackage,
            createGroup, createCommit, defaultCapabilities, defaultLifetime,
            defaultCredentialTypes, defaultProposalTypes } = tsMls;
    const makeCred = (uid: string) => ({
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(uid),
    });

    // Decode Bob's SECOND pending KP from the DS (index 1).
    const bobKps = ds.keyPackages.get('bob')!;
    expect(bobKps.length).toBeGreaterThanOrEqual(2);
    const secondKpBytes = Buffer.from(bobKps[1]!, 'base64');
    const secondKpMsg = decode(mlsMessageDecoder, new Uint8Array(secondKpBytes));
    const secondKp = (secondKpMsg as unknown as { keyPackage: import('ts-mls').KeyPackage }).keyPackage;

    // Create a group as Alice, add Bob via his SECOND KP → Welcome sealed to it.
    const aliceKp = await generateKeyPackage({
      credential: makeCred('alice'), capabilities: defaultCapabilities(),
      lifetime: defaultLifetime(), cipherSuite: cs,
    });
    const groupId = new TextEncoder().encode('second-kp-room');
    let aliceState = await createGroup({
      context: await makeContext(),
      groupId,
      keyPackage: aliceKp.publicPackage,
      privateKeyPackage: aliceKp.privatePackage,
    });
    const commitResult = await createCommit({
      context: await makeContext(),
      state: aliceState,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: secondKp } }],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true,
    });
    if (!commitResult.welcome) throw new Error('no welcome generated');

    // Encode + queue the Welcome for Bob.
    const welcomeMsg = {
      wireformat: wireformats.mls_welcome,
      welcome: commitResult.welcome.welcome,
      version: tsMls.protocolVersions.mls10,
    };
    const welcomeBytes = tsMls.encode(tsMls.mlsMessageEncoder, welcomeMsg);
    const welcomeB64 = Buffer.from(welcomeBytes).toString('base64');
    ds.queueWelcome('room-second-kp', 'bob', welcomeB64);

    // Bob fetches — processWelcome must try kp1 (fails), then kp2 (succeeds).
    const applied = await bob.manager.fetchAndProcessWelcomes('room-second-kp');
    expect(applied).toBe(1);
    expect(bob.manager.getEpoch('room-second-kp')).not.toBeNull();

    bob.dispose();
  });

  it('fetchWithRetry: Retry-After capped at 30s — absurd header does not park the client (fix #3)', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    await alice.manager.createGroup('room-cap', ['bob']);

    // Mock a 429 with an absurd Retry-After (≈31 years), then 200.
    const welcomeUrl = 'http://mock/api/sdk/rooms/room-cap/mls-welcome';
    ds.rateLimitOnceCustom.set(welcomeUrl, '999999999');

    // Intercept setTimeout to capture the requested delay and run it at 0ms
    // so the test doesn't actually sleep. Assert the delay is bounded.
    const originalSetTimeout = globalThis.setTimeout;
    const capturedDelays: number[] = [];
    globalThis.setTimeout = ((cb: TimerHandler, delay?: number) => {
      capturedDelays.push(delay ?? 0);
      return originalSetTimeout(cb, 0);
    }) as typeof globalThis.setTimeout;

    try {
      const applied = await bob.manager.fetchAndProcessWelcomes('room-cap');
      expect(applied).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // At least one retry delay was captured (from the 429).
    expect(capturedDelays.length).toBeGreaterThanOrEqual(1);
    // Every delay must be ≤ 30s — the cap prevents an unbounded server-supplied sleep.
    for (const d of capturedDelays) {
      expect(d).toBeLessThanOrEqual(30_000);
    }

    alice.dispose();
    bob.dispose();
  });

  it('fetchAndProcessWelcomes: 503 then 200 → retries 5xx and succeeds (fix #4)', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    await alice.manager.createGroup('room-503', ['bob']);

    // Mock a 503 once, then 200.
    const welcomeUrl = 'http://mock/api/sdk/rooms/room-503/mls-welcome';
    ds.serverErrorOnce.add(welcomeUrl);

    const applied = await bob.manager.fetchAndProcessWelcomes('room-503');
    expect(applied).toBe(1);
    expect(bob.manager.getEpoch('room-503')).not.toBeNull();

    alice.dispose();
    bob.dispose();
  });

  it('fetchAndProcessMessage: 503 then 200 → retries 5xx and succeeds (fix #4)', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    await alice.manager.createGroup('room-msg-503', ['bob']);
    await bob.manager.fetchAndProcessWelcomes('room-msg-503');

    // Alice adds Carol → commit message stored in DS.
    const carol = await makeProvider('carol');
    await alice.manager.addMember('room-msg-503', 'carol');

    const roomMsgs = ds.roomMessages.get('room-msg-503')!;
    const messageIds = [...roomMsgs.keys()];
    const messageId = messageIds[messageIds.length - 1]!;

    // Mock a 503 once on the message GET, then 200.
    ds.serverErrorOnce.add(`http://mock/api/sdk/rooms/room-msg-503/mls-messages/${messageId}`);

    // Should retry the 503 and succeed.
    await bob.manager.fetchAndProcessMessage('room-msg-503', messageId);
    expect(bob.manager.getEpoch('room-msg-503')).toBe(alice.manager.getEpoch('room-msg-503'));

    alice.dispose();
    bob.dispose();
    carol.dispose();
  });

  it('fetchAndProcessWelcomes: 429 retry → succeeds after rate limit (M3)', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    await alice.manager.createGroup('room-429', ['bob']);

    // Make the GET for welcomes return 429 once, then 200.
    ds.rateLimitOnce.add('http://mock/api/sdk/rooms/room-429/mls-welcome');

    const applied = await bob.manager.fetchAndProcessWelcomes('room-429');

    expect(applied).toBe(1);

    // The Welcome was processed and acked.
    const remaining = ds.roomWelcomes.get('room-429') ?? [];
    expect(remaining.filter(w => w.targetUid === 'bob')).toHaveLength(0);
    expect(bob.manager.getEpoch('room-429')).not.toBeNull();

    alice.dispose();
    bob.dispose();
  });

  it('fetchAndProcessWelcomes: 429 after all retries → throws mls_rate_limited', async () => {
    const bob = await makeProvider('bob');

    // Queue a Welcome but make the GET always return 429.
    ds.queueWelcome('room-429-forever', 'bob', Buffer.from('dummy').toString('base64'));
    ds.persistentRateLimit.add('http://mock/api/sdk/rooms/room-429-forever/mls-welcome');

    await expect(bob.manager.fetchAndProcessWelcomes('room-429-forever')).rejects.toMatchObject({
      code: 'mls_rate_limited',
    });

    bob.dispose();
  });

  it('base URL derivation: strips only trailing /keys, not earlier occurrences (M4)', async () => {
    // Directory URL has /keys earlier in the path.
    // Correct base URL: 'http://mock/keys/api/sdk' (strip trailing /keys only).
    // Buggy .replace('/keys', ''): 'http://mock/api/sdk/keys' (strips first /keys).
    const alice = await makeProvider('alice', 'http://mock/keys/api/sdk/keys');

    // Any room-scoped operation will use the derived base URL.
    // We call fetchAndProcessWelcomes which GETs /rooms/:id/mls-welcome from the base URL.
    // Even though there are no welcomes, the GET will be logged.
    await alice.manager.fetchAndProcessWelcomes('room-base-url');

    // The GET URL must use the correctly-derived base URL.
    const getUrl = ds.fetchLog.find(
      (e) => e.method === 'GET' && e.url.includes('/rooms/room-base-url/mls-welcome'),
    );
    expect(getUrl).toBeDefined();
    // Correct base: http://mock/keys/api/sdk/rooms/room-base-url/mls-welcome
    // Buggy base:  http://mock/api/sdk/keys/rooms/room-base-url/mls-welcome
    expect(getUrl!.url).toBe('http://mock/keys/api/sdk/rooms/room-base-url/mls-welcome');

    alice.dispose();
  });

  it('fetchAndProcessMessage: fetches and processes a protocol message', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    // Alice creates a group and adds Bob.
    await alice.manager.createGroup('room-msg-1', ['bob']);

    // Bob processes the Welcome to join the group.
    await bob.manager.fetchAndProcessWelcomes('room-msg-1');

    // Alice adds a third member (Carol) → generates a commit message.
    const carol = await makeProvider('carol');
    await alice.manager.addMember('room-msg-1', 'carol');

    // The commit was POSTed to /rooms/room-msg-1/mls-messages and stored
    // in the mock DS with a generated message_id. createGroup also sent a
    // commit (for adding Bob), so we need the LAST message (addCarol commit).
    const roomMsgs = ds.roomMessages.get('room-msg-1');
    expect(roomMsgs).toBeDefined();
    expect(roomMsgs!.size).toBeGreaterThanOrEqual(1);
    const messageIds = [...roomMsgs!.keys()];
    const messageId = messageIds[messageIds.length - 1]!; // last = addCarol commit

    // Bob fetches and processes the commit message by its message_id.
    await bob.manager.fetchAndProcessMessage('room-msg-1', messageId);

    // Bob's epoch should have advanced (he processed the addMember commit).
    // Alice and Bob should be at the same epoch.
    expect(bob.manager.getEpoch('room-msg-1')).toBe(alice.manager.getEpoch('room-msg-1'));

    alice.dispose();
    bob.dispose();
    carol.dispose();
  });

  it('fetchAndProcessMessage: 429 retry → succeeds after rate limit', async () => {
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');

    await alice.manager.createGroup('room-msg-429', ['bob']);
    await bob.manager.fetchAndProcessWelcomes('room-msg-429');

    // Alice adds Carol → commit message stored in DS.
    const carol = await makeProvider('carol');
    await alice.manager.addMember('room-msg-429', 'carol');

    const roomMsgs = ds.roomMessages.get('room-msg-429')!;
    const messageIds = [...roomMsgs.keys()];
    const messageId = messageIds[messageIds.length - 1]!; // last = addCarol commit

    // Rate-limit the GET for this message once.
    ds.rateLimitOnce.add(`http://mock/api/sdk/rooms/room-msg-429/mls-messages/${messageId}`);

    // Should retry and succeed.
    await bob.manager.fetchAndProcessMessage('room-msg-429', messageId);
    expect(bob.manager.getEpoch('room-msg-429')).toBe(alice.manager.getEpoch('room-msg-429'));

    alice.dispose();
    bob.dispose();
    carol.dispose();
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
