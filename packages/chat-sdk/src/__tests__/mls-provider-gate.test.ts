// Mutation gate for the MLS group lifecycle.
//
// Deliberately separate from mls-provider.test.ts and sharing nothing with it.
// That file covers construction, the AEAD round-trip and the state store; this
// one exists for a narrower job: to FAIL when MLSGroupManager stops doing what
// the plan's forward-secrecy acceptance criteria claim it does.
//
// Two suites on this branch have asserted forward secrecy while `removeMember`
// could be replaced by `throw` with nothing going red, because they built their
// own group with ts-mls and re-implemented the manager's logic inline. A test
// that reimplements the code under test cannot falsify it. So every test here:
//
//   - drives the REAL manager (createGroup / addMember / removeMember /
//     processMessage) through a mock Delivery Service,
//   - takes its oracle from ts-mls's own getGroupMembers, read as identities —
//     no nodeIndex arithmetic anywhere in this file,
//   - proves a removed member's exclusion from HER OWN state after she has
//     honestly processed the commit, never from the test withholding a key,
//   - pairs every negative with a surviving member reading the same ciphertext,
//     so "she cannot decrypt" is distinguishable from "nobody can".
//
// Mutations that MUST turn tests here red (run before trusting a green):
//   G1  `throw new Error('x')` as the first statement of MLSGroupManager.removeMember
//         → "targets the correct leaf" AND both forward-secrecy tests
//   G2  removeMember's ratchetTree loop → getGroupMembers(state).findIndex(...)
//         → "targets the correct leaf" (needs TWO removals to bite)
//   G3  removeMember's `extraProposals` → []
//         → "targets the correct leaf" AND "a removed member cannot decrypt"
//   G4  drop `version` from the MLSMessage in publishKeyPackage
//         → "a published KeyPackage carries protocol version mls10"
//         Note: on ts-mls 2.0 this mutant does NOT break the round trip — the
//         message still decodes, just with version 0. Asserting the version
//         byte is what makes it detectable, which is why that test checks the
//         field rather than only that createGroup succeeded.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMlsProvider } from '../mls-provider.js';
import { InMemoryMlsStateStore } from '../mls-state-store.js';
import type { MlsProvider } from '../mls-provider.js';

// ---- Mock Delivery Service --------------------------------------------------

const KP_URL = 'http://mock/api/sdk/keys';

/**
 * Minimal stand-in for the server DS. A relay, exactly as the real one is
 * specified to be: it stores and hands back bytes and never parses MLS.
 */
class GateDeliveryService {
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
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url.endsWith('/keys/publish') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { key_package_b64: string };
      const uid = (headers['Authorization'] ?? '').replace('Bearer mock-jwt-', '') || 'unknown';
      const kps = this.keyPackages.get(uid) ?? [];
      kps.push(body.key_package_b64);
      this.keyPackages.set(uid, kps);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    const getKp = url.match(/\/keys\/([^/]+)$/);
    if (getKp && method === 'GET') {
      const kps = this.keyPackages.get(getKp[1]!) ?? [];
      return new Response(JSON.stringify({
        key_packages: kps.map((b64) => ({ key_package_b64: b64 })),
      }), { status: 200 });
    }

    const welcome = url.match(/\/rooms\/([^/]+)\/mls-welcome$/);
    if (welcome && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { welcome_b64: string; target_uid: string };
      const queue = this.welcomeQueue.get(body.target_uid) ?? [];
      queue.push({ roomId: welcome[1]!, welcome_b64: body.welcome_b64 });
      this.welcomeQueue.set(body.target_uid, queue);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    const msg = url.match(/\/rooms\/([^/]+)\/mls-messages$/);
    if (msg && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { message_b64: string };
      const list = this.mlsMessages.get(msg[1]!) ?? [];
      list.push(body.message_b64);
      this.mlsMessages.set(msg[1]!, list);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ---- Helpers ----------------------------------------------------------------

type TsMls = typeof import('ts-mls');
type TsState = import('ts-mls').ClientState;
type RawKp = {
  publicPackage: import('ts-mls').KeyPackage;
  privatePackage: import('ts-mls').PrivateKeyPackage;
};

const CS_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
const AEAD_SUITE = 'AES_128_GCM_SHA256' as const;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function tsmls(): Promise<TsMls> {
  return import('ts-mls');
}

async function makeContext(): Promise<import('ts-mls').MlsContext> {
  const t = await tsmls();
  return {
    cipherSuite: await t.getCiphersuiteImpl(CS_NAME, t.nobleCryptoProvider),
    authService: t.unsafeTestingAuthenticationService,
  };
}

async function makeProvider(uid: string): Promise<MlsProvider> {
  const t = await tsmls();
  return createMlsProvider({
    identityKey: await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
    credential: 'basic',
    uid,
    keyPackageDirectoryUrl: KP_URL,
    jwt: `mock-jwt-${uid}`,
    stateStore: new InMemoryMlsStateStore(),
    authService: t.unsafeTestingAuthenticationService,
  });
}

/**
 * Put a KeyPackage for `uid` in the directory the way the server would, and
 * keep the private half so this member can join for real. It cannot go through
 * publishKeyPackage(), whose private package stays inside its own manager.
 */
async function seedKeyPackage(
  ds: GateDeliveryService,
  uid: string,
  ctx: import('ts-mls').MlsContext,
): Promise<RawKp> {
  const t = await tsmls();
  const kp = await t.generateKeyPackage({
    credential: { credentialType: t.defaultCredentialTypes.basic, identity: bytes(uid) },
    capabilities: t.defaultCapabilities(),
    lifetime: t.defaultLifetime(),
    cipherSuite: ctx.cipherSuite,
  });
  const encoded = t.encode(t.mlsMessageEncoder, {
    version: t.protocolVersions.mls10,
    wireformat: t.wireformats.mls_key_package,
    keyPackage: kp.publicPackage,
  });
  const list = ds.keyPackages.get(uid) ?? [];
  list.push(t.bytesToBase64(encoded));
  ds.keyPackages.set(uid, list);
  return kp;
}

/** Join from the Welcome the manager actually relayed through the DS. */
async function joinFromWelcome(
  ds: GateDeliveryService,
  uid: string,
  kp: RawKp,
  ctx: import('ts-mls').MlsContext,
): Promise<TsState> {
  const t = await tsmls();
  const queue = ds.welcomeQueue.get(uid);
  if (!queue?.length) throw new Error(`joinFromWelcome: no Welcome queued for ${uid}`);
  const entry = queue.shift()!;
  const decoded = t.decode(t.mlsMessageDecoder, b64ToBytes(entry.welcome_b64));
  if (!decoded || decoded.wireformat !== t.wireformats.mls_welcome) {
    throw new Error(`joinFromWelcome: expected a Welcome for ${uid}`);
  }
  return t.joinGroup({
    context: ctx,
    welcome: decoded.welcome,
    keyPackage: kp.publicPackage,
    privateKeys: kp.privatePackage,
  });
}

/**
 * Replay commits the manager broadcast, from `from` onward, onto an
 * independently-held ClientState. This is how a peer's view is built from what
 * the manager actually sent rather than from what the test believes it sent.
 */
async function drainCommits(
  ds: GateDeliveryService,
  roomId: string,
  from: number,
  state: TsState,
  ctx: import('ts-mls').MlsContext,
): Promise<{ state: TsState; cursor: number }> {
  const t = await tsmls();
  const msgs = ds.mlsMessages.get(roomId) ?? [];
  let current = state;
  for (let i = from; i < msgs.length; i++) {
    const message = t.decode(t.mlsMessageDecoder, b64ToBytes(msgs[i]!));
    if (!message) throw new Error(`drainCommits: undecodable message at ${i}`);
    const result = await t.processMessage({
      context: ctx,
      state: current,
      message: message as Parameters<typeof t.processMessage>[0]['message'],
      callback: t.acceptAll,
    });
    if (result.kind !== 'newState') {
      throw new Error(`drainCommits: expected newState at ${i}, got ${result.kind}`);
    }
    current = result.newState;
  }
  return { state: current, cursor: msgs.length };
}

/**
 * Sorted basic-credential identities, read with ts-mls's own getGroupMembers.
 * The oracle is deliberately NOT the computation removeMember performs: this
 * reads names out of a compacted array and never touches a leaf index.
 */
async function memberIdentities(state: TsState): Promise<string[]> {
  const t = await tsmls();
  return t.getGroupMembers(state)
    .map((leaf) => {
      const cred = leaf.credential;
      return cred.credentialType === t.defaultCredentialTypes.basic
        ? text((cred as { identity: Uint8Array }).identity)
        : `<${String(cred.credentialType)}>`;
    })
    .sort();
}

// ---- Tests -------------------------------------------------------------------

describe('MLSGroupManager — lifecycle gate', () => {
  let ds: GateDeliveryService;

  beforeEach(() => {
    ds = new GateDeliveryService();
    ds.install();
  });

  afterEach(() => {
    ds.restore();
  });

  it('a published KeyPackage carries protocol version mls10 and reads back', async () => {
    // Guards a defect that shipped once: the MLSMessage wrapper was built
    // without `version` and cast past the type check. On ts-mls 1.6.2 that was
    // loud — decodeMlsMessage rejected the bytes, so every createGroup died in
    // #fetchKeyPackage and every Welcome in processWelcome. The old suite
    // missed it by asserting only that the DS had stored SOMETHING.
    //
    // On 2.0 the same omission is SILENT: measured, it encodes to the same 321
    // bytes and decodes cleanly with `version: 0` instead of mls10. Our own SDK
    // would never notice; a peer that checks the version would refuse us. So
    // the round trip alone is no longer a gate — the version byte has to be
    // asserted explicitly.
    const t = await tsmls();
    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');
    await alice.manager.publishKeyPackage(); // createGroup consumes the creator's own
    await bob.manager.publishKeyPackage();

    const published = ds.keyPackages.get('bob');
    expect(published).toHaveLength(1);
    const decoded = t.decode(t.mlsMessageDecoder, b64ToBytes(published![0]!));
    expect(decoded).toBeDefined();
    expect(decoded!.wireformat).toBe(t.wireformats.mls_key_package);
    expect(decoded!.version).toBe(t.protocolVersions.mls10);

    // And it is usable: createGroup can only succeed if the directory bytes
    // decode back into a KeyPackage the commit can add.
    await expect(alice.manager.createGroup('room-wire', ['bob'])).resolves.toBeUndefined();
    expect(ds.welcomeQueue.get('bob') ?? []).toHaveLength(1);

    alice.dispose();
    bob.dispose();
  });

  it('removeMember targets the correct leaf across two sequential removals', async () => {
    const ctx = await makeContext();
    const roomId = 'room-leaf';
    const alice = await makeProvider('alice');
    await alice.manager.publishKeyPackage();

    // `observer` is the oracle: leaf 1, never removed, and below every leaf the
    // compacted-index defect could mis-target — so it survives in both the
    // correct and the broken world and can report on either.
    const observerKp = await seedKeyPackage(ds, 'observer', ctx);
    await seedKeyPackage(ds, 'bob', ctx);
    await seedKeyPackage(ds, 'carol', ctx);
    await seedKeyPackage(ds, 'mallory', ctx);

    await alice.manager.createGroup(roomId, ['observer']); // alice=0, observer=1
    let observerState = await joinFromWelcome(ds, 'observer', observerKp, ctx);
    let cursor = ds.mlsMessages.get(roomId)?.length ?? 0;

    await alice.manager.addMember(roomId, 'bob');      // leaf 2
    await alice.manager.addMember(roomId, 'carol');    // leaf 3
    await alice.manager.addMember(roomId, 'mallory');  // leaf 4

    // The first removal blanks leaf 2. From here the compacted array index and
    // the leaf index disagree, which is what makes the SECOND removal the test.
    await alice.manager.removeMember(roomId, 'bob');
    // Correct: leaf 4. Compacted-index defect: getGroupMembers is
    // [alice, observer, carol, mallory], findIndex(mallory) === 3 → removes
    // leaf 3, which is Carol.
    await alice.manager.removeMember(roomId, 'mallory');

    const drained = await drainCommits(ds, roomId, cursor, observerState, ctx);
    observerState = drained.state;
    cursor = drained.cursor;

    expect(await memberIdentities(observerState)).toEqual(['alice', 'carol', 'observer']);

    alice.dispose();
  }, 30_000);

  it('a removed member cannot decrypt epoch N+1 from her own state', async () => {
    const t = await tsmls();
    const ctx = await makeContext();
    const { deriveMlsEpochMaterial } = await import('sframe-ratchet/mls');
    const { createMlsChatProvider } = await import('sframe-ratchet/chat/mls');
    const roomId = 'room-fs';
    const uidToPeerId = (uid: string): string => t.bytesToBase64(bytes(uid));

    const alice = await makeProvider('alice');
    await alice.manager.publishKeyPackage();
    const observerKp = await seedKeyPackage(ds, 'observer', ctx);
    const malloryKp = await seedKeyPackage(ds, 'mallory', ctx);

    await alice.manager.createGroup(roomId, ['observer']);
    let observerState = await joinFromWelcome(ds, 'observer', observerKp, ctx);
    let observerCursor = ds.mlsMessages.get(roomId)?.length ?? 0;

    await alice.manager.addMember(roomId, 'mallory');
    let malloryState = await joinFromWelcome(ds, 'mallory', malloryKp, ctx);
    const malloryCursor = ds.mlsMessages.get(roomId)?.length ?? 0;

    const o1 = await drainCommits(ds, roomId, observerCursor, observerState, ctx);
    observerState = o1.state;
    observerCursor = o1.cursor;

    const malloryAead = createMlsChatProvider({ uidToPeerId });
    const observerAead = createMlsChatProvider({ uidToPeerId });
    const malloryGid = malloryState.groupContext.groupId;
    const observerGid = observerState.groupContext.groupId;

    // Baseline: while she is a member, Mallory reads Alice's traffic. Without
    // this the negative below would say nothing about the removal.
    const m0 = await deriveMlsEpochMaterial(malloryState, ctx.cipherSuite, AEAD_SUITE, malloryGid);
    await malloryAead.setEpoch(roomId, {
      epoch: m0.epoch, peerIndexMap: m0.peerIndexMap, chainKey: m0.chainKey,
    });
    const before = await alice.seal(bytes('before removal').buffer as ArrayBuffer, {
      roomId, senderUid: 'alice',
    });
    expect(text(await malloryAead.unseal(new Uint8Array(before), { roomId, senderUid: 'alice' })))
      .toBe('before removal');

    await alice.manager.removeMember(roomId, 'mallory');

    // Mallory plays the protocol honestly and processes the commit that removed
    // her. She is not merely denied a key by the test.
    try {
      const drained = await drainCommits(ds, roomId, malloryCursor, malloryState, ctx);
      malloryState = drained.state;
    } catch {
      // A removed member may be unable to process her own removal at all.
      // Either way she must not reach the new epoch — asserted below.
    }

    const o2 = await drainCommits(ds, roomId, observerCursor, observerState, ctx);
    observerState = o2.state;

    const after = await alice.seal(bytes('after removal').buffer as ArrayBuffer, {
      roomId, senderUid: 'alice',
    });

    // CONTROL — a surviving member reads epoch N+1. This separates "Mallory is
    // locked out" from "the ciphertext is broken for everyone".
    const o = await deriveMlsEpochMaterial(observerState, ctx.cipherSuite, AEAD_SUITE, observerGid);
    await observerAead.setEpoch(roomId, {
      epoch: o.epoch, peerIndexMap: o.peerIndexMap, chainKey: o.chainKey,
    });
    expect(text(await observerAead.unseal(new Uint8Array(after), { roomId, senderUid: 'alice' })))
      .toBe('after removal');
    expect(o.epoch).toBeGreaterThan(m0.epoch);

    // THE PROPERTY — Mallory's best honest effort from her own state yields
    // nothing: she cannot derive epoch N+1 material, or derives the wrong key
    // and the AEAD rejects the frame.
    let malloryRead: string | null = null;
    try {
      const m1 = await deriveMlsEpochMaterial(malloryState, ctx.cipherSuite, AEAD_SUITE, malloryGid);
      await malloryAead.setEpoch(roomId, {
        epoch: m1.epoch, peerIndexMap: m1.peerIndexMap, chainKey: m1.chainKey,
      });
      malloryRead = text(await malloryAead.unseal(new Uint8Array(after), {
        roomId, senderUid: 'alice',
      }));
    } catch {
      malloryRead = null;
    }
    expect(malloryRead).toBeNull();

    malloryAead.dispose();
    observerAead.dispose();
    alice.dispose();
  }, 30_000);

  it('a REMAINING member never seals under an epoch the removed member can compute', async () => {
    // The committer skips an exposed epoch for free, by applying the AEAD epoch
    // once at the end. A receiver only does so if the receive path handles it —
    // and receivers get each commit as a separate relay. This test is the one
    // that distinguishes the two; it caught a real gap on ts-mls 1.6.2, where
    // the removal commit carried no UpdatePath.
    const t = await tsmls();
    const ctx = await makeContext();
    const { deriveMlsEpochMaterial } = await import('sframe-ratchet/mls');
    const { createMlsChatProvider } = await import('sframe-ratchet/chat/mls');
    const roomId = 'room-window';
    const uidToPeerId = (uid: string): string => t.bytesToBase64(bytes(uid));

    const alice = await makeProvider('alice');
    const bob = await makeProvider('bob');
    await alice.manager.publishKeyPackage();
    await bob.manager.publishKeyPackage();
    const malloryKp = await seedKeyPackage(ds, 'mallory', ctx);

    await alice.manager.createGroup(roomId, ['bob']);
    const bobWelcome = ds.welcomeQueue.get('bob')?.[0];
    if (!bobWelcome) throw new Error('no Welcome relayed for bob');
    await bob.manager.processWelcome(roomId, b64ToBytes(bobWelcome.welcome_b64));
    let cursor = ds.mlsMessages.get(roomId)?.length ?? 0;

    await alice.manager.addMember(roomId, 'mallory');
    const afterAdd = ds.mlsMessages.get(roomId) ?? [];
    for (let i = cursor; i < afterAdd.length; i++) {
      await bob.manager.processMessage(roomId, b64ToBytes(afterAdd[i]!));
    }
    cursor = afterAdd.length;
    let malloryState = await joinFromWelcome(ds, 'mallory', malloryKp, ctx);

    await alice.manager.removeMember(roomId, 'mallory');
    const msgs = ds.mlsMessages.get(roomId) ?? [];
    expect(msgs.length).toBeGreaterThan(cursor);

    // Bob receives the FIRST relay only — the state an SSE consumer is in
    // between deliveries. Mallory receives exactly the same one. Any failure
    // here is a broken test, not a security property, so it is not swallowed.
    await bob.manager.processMessage(roomId, b64ToBytes(msgs[cursor]!));
    const decoded = t.decode(t.mlsMessageDecoder, b64ToBytes(msgs[cursor]!));
    if (!decoded) throw new Error('undecodable removal commit');
    const result = await t.processMessage({
      context: ctx,
      state: malloryState,
      message: decoded as Parameters<typeof t.processMessage>[0]['message'],
      callback: t.acceptAll,
    });
    if (result.kind !== 'newState') throw new Error(`mallory: expected newState, got ${result.kind}`);
    malloryState = result.newState;

    const sealed = await bob.seal(bytes('bob mid-removal').buffer as ArrayBuffer, {
      roomId, senderUid: 'bob',
    });

    let malloryRead: string | null = null;
    try {
      const m = await deriveMlsEpochMaterial(
        malloryState, ctx.cipherSuite, AEAD_SUITE, malloryState.groupContext.groupId,
      );
      const aead = createMlsChatProvider({ uidToPeerId });
      await aead.setEpoch(roomId, { epoch: m.epoch, peerIndexMap: m.peerIndexMap, chainKey: m.chainKey });
      malloryRead = text(await aead.unseal(new Uint8Array(sealed), { roomId, senderUid: 'bob' }));
      aead.dispose();
    } catch {
      malloryRead = null;
    }
    expect(malloryRead).toBeNull();

    alice.dispose();
    bob.dispose();
  }, 30_000);
});
