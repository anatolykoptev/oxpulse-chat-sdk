/**
 * MLS E2EE adapter for @oxpulse/chat-sdk.
 *
 * Wraps sframe-ratchet/chat/mls (`createMlsChatProvider`) + sframe-ratchet/mls
 * (`deriveMlsEpochMaterial`) + ts-mls (RFC 9420 group lifecycle) into a
 * CryptoProvider consumed by SDKChatClient.
 *
 * ## Architecture
 *
 * The MLS provider has TWO layers:
 *
 * 1. **AEAD layer** (`MlsChatProvider` from sframe-ratchet/chat/mls):
 *    - `setEpoch(roomId, {epoch, peerIndexMap, chainKey})` — installs per-sender
 *      SFrame AEAD keys derived from the MLS ChainKey.
 *    - `seal(plaintext, ctx)` / `unseal(sealed, ctx)` — SFrame AEAD with replay
 *      protection, stale-epoch guard, CTR allocation. No Worker, pure WebCrypto.
 *
 * 2. **MLS group lifecycle** (`MLSGroupManager`, this file):
 *    - `createGroup(roomId, members)` — ts-mls createGroup + deriveMlsEpochMaterial
 *      + setEpoch + publish KeyPackages.
 *    - `processWelcome(roomId, welcome)` — ts-mls joinGroup + setEpoch.
 *    - `processMessage(roomId, msg)` — ts-mls processMessage + setEpoch (on commit).
 *    - `addMember/removeMember` — create proposals + commits + broadcast.
 *
 * The CryptoProvider interface (seal/unseal/dispose) is the AEAD layer only.
 * The group lifecycle is exposed via `MLSGroupManager` which SDKChatClient
 * calls directly for room creation, member changes, and SSE event handling.
 *
 * ## Threat model
 *
 * - Defends: AEAD confidentiality+integrity, in-session + cross-reload replay,
 *   forward secrecy + post-compromise security (via MLS TreeKEM — ChainKey
 *   rotates on every epoch advance).
 * - Does NOT defend: traffic analysis.
 *
 * ### Member authentication — one of three surfaces is closed
 *
 * The Delivery Service is untrusted. Three places let it influence who is in a
 * group, and only the first is guarded here:
 *
 * 1. **Outbound (guarded).** `#fetchKeyPackage` verifies the returned
 *    KeyPackage's basic-credential identity equals the uid that was requested,
 *    so the directory cannot answer a request for Bob with Mallory's package.
 * 2. **Inbound commits (OPEN).** `processMessage` passes ts-mls `acceptAll`, so
 *    an Add relayed over SSE is accepted without asking whether that identity
 *    belongs in this room. The SDK has no room roster to check against; this
 *    needs an application-supplied authorization callback.
 * 3. **Join (OPEN).** `joinGroup` runs with ts-mls's `defaultClientConfig`,
 *    whose `defaultAuthenticationService.validateCredential` returns `true`
 *    unconditionally, so a joiner validates no credential in the tree it joins.
 *
 * Surfaces 2 and 3 are tracked in #355. Until they are closed, treat group
 * membership as server-asserted and use the epoch authenticator for
 * out-of-band verification.
 *
 * ## Bundle size
 *
 * ts-mls is ~672 KB. This module uses dynamic `import('ts-mls')` so the
 * dependency is only loaded when MLS is actually used. SDK consumers must
 * `npm install ts-mls` as a peer dependency; if not installed, the MLS
 * provider throws a clear error on first use (not at import time).
 *
 * @example
 * ```ts
 * const provider = await createMlsProvider({
 *   identityKey: ed25519PrivateKey,
 *   keyPackageDirectoryUrl: 'https://api.oxpulse.chat/api/sdk/keys',
 *   jwt: token,
 *   uid: 'user-123',
 * });
 * const manager = provider.manager;
 * await manager.publishKeyPackage();
 * await manager.createGroup('room-1', ['alice', 'bob']);
 * // provider.seal/unseal now work for room-1
 * ```
 */

import { createMlsChatProvider } from 'sframe-ratchet/chat/mls';
import { deriveMlsEpochMaterial } from 'sframe-ratchet/mls';
import type { MlsChatProvider, MlsEpochParams } from 'sframe-ratchet/chat/mls';
import type { MlsEpochMaterial } from 'sframe-ratchet/mls';
import type { CryptoProvider, SealContext } from './types.js';
import type { MLSStateStore } from './mls-state-store.js';
import { SDKChatError } from './errors.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils.js';

// ---------------------------------------------------------------------------
// Types (re-exported for the public API)
// ---------------------------------------------------------------------------

/** MLS cipher suite names supported by ts-mls. */
export type MlsCipherSuite =
  | 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
  | 'MLS_256_DHKEMP521_AES256GCM_SHA512_P521';

/** Options for createMlsProvider. */
export interface MlsProviderOptions {
  /**
   * Ed25519 identity signature key (per-device). Used to sign KeyPackages
   * and MLS protocol messages. The corresponding public key is the MLS
   * credential identity.
   */
  identityKey: CryptoKey;

  /**
   * MLS credential type. v1 supports 'basic' only (identity = user UID string).
   * X509 credentials are future work.
   */
  credential: 'basic';

  /**
   * User UID — used as the MLS basic credential identity and as the
   * `senderUid` in SealContext.
   */
  uid: string;

  /**
   * MLS cipher suite. Default 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'.
   */
  ciphersuite?: MlsCipherSuite;

  /**
   * KeyPackage directory base URL (server Delivery Service).
   * e.g. 'https://api.oxpulse.chat/api/sdk/keys'
   */
  keyPackageDirectoryUrl: string;

  /**
   * Bearer JWT for authenticating to the server DS.
   */
  jwt: string;

  /**
   * Called after each epoch advance with the 32-byte authenticator.
   * Used for automated partition detection (NOT user-visible safety number).
   */
  onEpochAuthenticator?: (roomId: string, authenticator: Uint8Array) => void;

  /**
   * State store for persisting MLS ClientState to IndexedDB.
   * Defaults to IndexedDB-backed (createIdbMlsStateStore).
   */
  stateStore?: MLSStateStore;

  /**
   * Replay window size (per sender per room). Default 1024.
   */
  replayWindow?: number;

  /**
   * Durable cross-reload replay protection namespace. Defaults to 'oxpulse-mls'.
   */
  durableReplayNamespace?: string;
}

// ---------------------------------------------------------------------------
// MLSGroupManager — drives the MLS group lifecycle
// ---------------------------------------------------------------------------

// Type aliases for ts-mls types (avoided importing at module level to keep
// the dynamic import boundary clean — ts-mls is ~672 KB).
type TsMlsModule = typeof import('ts-mls');
type ClientState = import('ts-mls').ClientState;
type CiphersuiteImpl = import('ts-mls').CiphersuiteImpl;
type KeyPackage = import('ts-mls').KeyPackage;
type PrivateKeyPackage = import('ts-mls').PrivateKeyPackage;
type MLSMessage = import('ts-mls').MLSMessage;

/**
 * The only MLS protocol version RFC 9420 defines. Every MLSMessage this SDK
 * encodes must carry it — the wire format puts the version first, and a
 * message encoded without it does not decode.
 */
const MLS_PROTOCOL_VERSION: import('ts-mls').ProtocolVersionName = 'mls10';

/**
 * Manages MLS group lifecycle for rooms with cryptoMode 'mls'.
 * Created internally by createMlsProvider. Exposed via `provider.manager`.
 *
 * Uses dynamic import('ts-mls') so the dependency is only loaded when
 * MLS is actually used.
 */
export class MLSGroupManager {
  /** Lazy-loaded ts-mls module. */
  #tsMls: TsMlsModule | null = null;
  /** Lazy-loaded CiphersuiteImpl. */
  #cs: CiphersuiteImpl | null = null;
  /** The MlsChatProvider (AEAD layer). */
  readonly #aead: MlsChatProvider;
  /** Options. */
  readonly #opts: MlsProviderOptions;
  /** Per-room MLS ClientState (in-memory; persisted via stateStore). */
  readonly #roomStates = new Map<string, ClientState>();
  /** Per-room MLS group ID. */
  readonly #roomGroupIds = new Map<string, Uint8Array>();
  /** State store for persistence. */
  readonly #stateStore: MLSStateStore;
  /** Disposed flag. */
  #disposed = false;
  /** Pending (generated but not yet consumed) KeyPackages. */
  #pendingKeyPackages: Array<{
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  }> = [];

  constructor(opts: MlsProviderOptions, aead: MlsChatProvider, stateStore: MLSStateStore) {
    this.#opts = opts;
    this.#aead = aead;
    this.#stateStore = stateStore;
  }

  /** Lazy-load ts-mls. Throws a clear error if not installed. */
  async #loadTsMls(): Promise<TsMlsModule> {
    if (this.#tsMls) return this.#tsMls;
    try {
      this.#tsMls = await import('ts-mls');
      return this.#tsMls;
    } catch {
      throw new SDKChatError(
        'unsupported',
        'MLSGroupManager: ts-mls is not installed. Run `npm install ts-mls` to use MLS.',
      );
    }
  }

  /** Lazy-load the CiphersuiteImpl. */
  async #getCiphersuite(): Promise<CiphersuiteImpl> {
    if (this.#cs) return this.#cs;
    const tsMls = await this.#loadTsMls();
    const name = this.#opts.ciphersuite ?? 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
    this.#cs = await tsMls.nobleCryptoProvider.getCiphersuiteImpl(
      tsMls.getCiphersuiteFromName(name),
    );
    return this.#cs;
  }

  /** Derive epoch material from a ClientState and install it in the AEAD provider. */
  async #applyEpoch(roomId: string, state: ClientState): Promise<void> {
    const cs = await this.#getCiphersuite();
    const groupId = this.#roomGroupIds.get(roomId);
    if (!groupId) throw new SDKChatError('mls_epoch_desync', `MLSGroupManager: no groupId for room ${roomId}`);

    const material: MlsEpochMaterial = await deriveMlsEpochMaterial(
      state, cs, 'AES_128_GCM_SHA256', groupId,
    );

    const params: MlsEpochParams = {
      epoch: material.epoch,
      peerIndexMap: material.peerIndexMap,
      chainKey: material.chainKey,
    };
    await this.#aead.setEpoch(roomId, params);

    // Surface epoch authenticator for partition detection.
    this.#opts.onEpochAuthenticator?.(roomId, material.epochAuthenticator);
  }

  /**
   * Generate and publish a KeyPackage to the server directory.
   * Called on client init (and when the directory count drops below threshold).
   */
  async publishKeyPackage(): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    const { generateKeyPackage, defaultCapabilities, defaultLifetime } = tsMls;
    const credential = {
      credentialType: 'basic' as const,
      identity: new TextEncoder().encode(this.#opts.uid),
    };

    const { publicPackage, privatePackage } = await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      cs,
    );

    // Serialize and publish to the server directory.
    // The KeyPackage is a public key — safe to send over HTTPS.
    // Wrap it in an MlsKeyPackage message for encoding.
    //
    // `version` is REQUIRED: MLSMessage is MlsMessageProtocol & MlsMessageContent,
    // and encodeMlsMessage writes the version byte first. Omitting it encodes a
    // message decodeMlsMessage rejects — i.e. a KeyPackage this very SDK cannot
    // read back. Keep this object typed as MLSMessage (no `as unknown` cast) so
    // the compiler keeps catching a missing field.
    const keyPackageMsg: MLSMessage = {
      version: MLS_PROTOCOL_VERSION,
      wireformat: 'mls_key_package',
      keyPackage: publicPackage,
    };
    const keyPackageBytes = tsMls.encodeMlsMessage(keyPackageMsg);
    const keyPackageB64 = bytesToBase64(keyPackageBytes);

    const resp = await fetch(`${this.#opts.keyPackageDirectoryUrl}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#opts.jwt}`,
      },
      body: JSON.stringify({ key_package_b64: keyPackageB64 }),
    });
    if (!resp.ok) {
      throw new SDKChatError('server_error', `MLSGroupManager.publishKeyPackage: server returned ${resp.status}`);
    }

    this.#pendingKeyPackages.push({ publicPackage, privatePackage });
  }

  /**
   * Create an MLS group for a new room.
   * Called by SDKChatClient.createRoom() when cryptoMode is 'mls'.
   */
  async createGroup(roomId: string, memberUids: string[]): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    if (this.#pendingKeyPackages.length === 0) {
      throw new SDKChatError('mls_keypackage_not_found', 'MLSGroupManager.createGroup: no pending KeyPackage — call publishKeyPackage first');
    }
    // Peek without consuming — shift only after the group is created successfully
    // so a failure does not waste the KeyPackage (DoS vector).
    const myKp = this.#pendingKeyPackages[0]!;

    // Generate a random group ID.
    const groupId = crypto.getRandomValues(new Uint8Array(16));
    this.#roomGroupIds.set(roomId, groupId);

    // Create the group (epoch 0, alone).
    const { createGroup, createCommit, emptyPskIndex } = tsMls;
    let state = await createGroup(groupId, myKp.publicPackage, myKp.privatePackage, [], cs);

    // Fetch KeyPackages for all members and add them via commits.
    // v1: sequential commits (one per member). Simple, correct, slow for large groups.
    for (const uid of memberUids) {
      if (uid === this.#opts.uid) continue; // skip self

      const memberKp = await this.#fetchKeyPackage(uid);
      const commitResult = await createCommit(
        { state, cipherSuite: cs },
        {
          extraProposals: [{ proposalType: 'add', add: { keyPackage: memberKp } }],
          ratchetTreeExtension: true,
          wireAsPublicMessage: true,
        },
      );
      state = commitResult.newState;

      // Send the Welcome message to the new member via the server.
      if (commitResult.welcome) {
        await this.#sendWelcome(roomId, uid, commitResult.welcome, tsMls, cs);
      }

      // Broadcast the commit to all existing members via the server.
      await this.#sendMlsMessage(roomId, commitResult.commit, 'commit', tsMls);
    }

    this.#roomStates.set(roomId, state);
    // Consume the KeyPackage only after the group is fully created.
    this.#pendingKeyPackages.shift();
    await this.#applyEpoch(roomId, state);
    await this.#persistRoom(roomId);
  }

  /**
   * Process a Welcome message (received via SSE `mls-welcome` event).
   * Called on room join.
   */
  async processWelcome(roomId: string, welcome: Uint8Array): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    if (this.#pendingKeyPackages.length === 0) {
      throw new SDKChatError('mls_keypackage_not_found', 'MLSGroupManager.processWelcome: no pending KeyPackage');
    }
    // Peek without consuming — shift only after joinGroup succeeds.
    const myKp = this.#pendingKeyPackages[0]!;

    // decodeMlsMessage returns [MLSMessage, newOffset] | undefined.
    const decoded = tsMls.decodeMlsMessage(welcome, 0);
    if (!decoded) {
      throw new SDKChatError('mls_welcome_decrypt_failed', 'MLSGroupManager.processWelcome: failed to decode welcome message');
    }
    const [welcomeMsg] = decoded;
    if (welcomeMsg.wireformat !== 'mls_welcome') {
      throw new SDKChatError('mls_welcome_decrypt_failed', `MLSGroupManager.processWelcome: expected welcome, got ${welcomeMsg.wireformat}`);
    }

    const { joinGroup, emptyPskIndex } = tsMls;
    const state = await joinGroup(
      welcomeMsg.welcome,
      myKp.publicPackage,
      myKp.privatePackage,
      emptyPskIndex,
      cs,
    );

    // Extract groupId from the welcome's group info.
    const groupId = state.groupContext.groupId;

    // Verify the welcome's groupId is not already bound to a different room.
    // This prevents a confusion attack where a welcome for group A is sent
    // to a user expecting to join group B. The roomId → groupId mapping is
    // set by createGroup (creator) or here (joiner); if it's already set,
    // it must match.
    const existingGroupId = this.#roomGroupIds.get(roomId);
    if (existingGroupId && !arrayEquals(existingGroupId, groupId)) {
      throw new SDKChatError(
        'mls_welcome_decrypt_failed',
        `MLSGroupManager.processWelcome: welcome groupId does not match existing binding for room ${roomId}`,
      );
    }

    this.#roomGroupIds.set(roomId, groupId);
    this.#roomStates.set(roomId, state);
    // Consume the KeyPackage only after joinGroup succeeds.
    this.#pendingKeyPackages.shift();
    await this.#applyEpoch(roomId, state);
    await this.#persistRoom(roomId);
  }

  /**
   * Process an inbound MLS protocol message (proposal/commit).
   * Called from the SSE handler on `mls-protocol` event.
   */
  async processMessage(roomId: string, message: Uint8Array): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    const state = this.#roomStates.get(roomId);
    if (!state) {
      throw new SDKChatError('mls_epoch_desync', `MLSGroupManager.processMessage: no state for room ${roomId}`);
    }

    const decoded = tsMls.decodeMlsMessage(message, 0);
    if (!decoded) {
      throw new SDKChatError('mls_commit_validation_failed', 'MLSGroupManager.processMessage: failed to decode message');
    }
    const [msg] = decoded;

    // processMessage signature: (message, state, pskIndex, action, cs)
    // For received messages, we use acceptAll callback and emptyPskIndex.
    const { processMessage, emptyPskIndex, acceptAll } = tsMls;
    const result = await processMessage(
      msg as unknown as import('ts-mls').MlsPrivateMessage | import('ts-mls').MlsPublicMessage,
      state,
      emptyPskIndex,
      acceptAll,
      cs,
    );

    // If this was a commit, the state advances — apply the new epoch.
    if (result.kind === 'newState' && result.newState !== state) {
      this.#roomStates.set(roomId, result.newState);

      // ...unless this is the epoch a removed member can still compute.
      //
      // The MLS state must advance regardless — the tree and the epoch counter
      // are consensus. What must NOT happen is installing this epoch's key in
      // the AEAD, because a pathless Remove leaves the removed member holding
      // the same chainKey (see removeMember). The sender skips this epoch by
      // construction; without this branch every RECEIVER walks straight into
      // it and seals messages the person just removed can read.
      //
      // Deferring means the AEAD stays on the previous epoch until the
      // rotation commit arrives. Nothing is sealed under the exposed epoch,
      // and a peer that never receives the rotation fails closed — it cannot
      // decrypt later traffic rather than transmitting under a key the removed
      // member holds.
      if (commitRevokesWithoutPath(msg)) {
        await this.#persistRoom(roomId);
        return;
      }

      await this.#applyEpoch(roomId, result.newState);
      await this.#persistRoom(roomId);
    }
  }

  /**
   * Add a member: fetch their KeyPackage, create Add proposal + Commit, broadcast.
   */
  async addMember(roomId: string, uid: string): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    const state = this.#roomStates.get(roomId);
    if (!state) {
      throw new SDKChatError('mls_epoch_desync', `MLSGroupManager.addMember: no state for room ${roomId}`);
    }

    const memberKp = await this.#fetchKeyPackage(uid);
    const { createCommit } = tsMls;
    const commitResult = await createCommit(
      { state, cipherSuite: cs },
      {
        extraProposals: [{ proposalType: 'add', add: { keyPackage: memberKp } }],
        ratchetTreeExtension: true,
        wireAsPublicMessage: true,
      },
    );

    this.#roomStates.set(roomId, commitResult.newState);

    if (commitResult.welcome) {
      await this.#sendWelcome(roomId, uid, commitResult.welcome, tsMls, cs);
    }
    await this.#sendMlsMessage(roomId, commitResult.commit, 'commit', tsMls);

    await this.#applyEpoch(roomId, commitResult.newState);
    await this.#persistRoom(roomId);
  }

  /**
   * Remove a member: create Remove proposal + Commit, broadcast.
   */
  async removeMember(roomId: string, uid: string): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();

    const state = this.#roomStates.get(roomId);
    if (!state) {
      throw new SDKChatError('mls_epoch_desync', `MLSGroupManager.removeMember: no state for room ${roomId}`);
    }

    // Find the leaf index for the member by credential identity.
    // CRITICAL: we must iterate the ratchet tree directly and compute the
    // leaf index as nodeIndex / 2 — NOT use getGroupMembers(), which returns
    // a compacted array of non-blank leaves. After a removal that leaves an
    // interior hole, the compacted array index diverges from the leaf index,
    // causing removeMember to target the wrong member.
    const { createCommit } = tsMls;
    const targetIdentity = new TextEncoder().encode(uid);
    const tree = state.ratchetTree;
    let leafIndex = -1;
    for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex += 2) {
      const node = tree[nodeIndex];
      if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
      const cred = node.leaf.credential;
      if (cred.credentialType === 'basic' &&
          arrayEquals((cred as { identity: Uint8Array }).identity, targetIdentity)) {
        leafIndex = Math.floor(nodeIndex / 2);
        break;
      }
    }
    if (leafIndex === -1) {
      throw new SDKChatError('not_found', `MLSGroupManager.removeMember: member ${uid} not found in room ${roomId}`);
    }

    const removeCommit = await createCommit(
      { state, cipherSuite: cs },
      {
        extraProposals: [{ proposalType: 'remove', remove: { removed: leafIndex } }],
        ratchetTreeExtension: true,
        wireAsPublicMessage: true,
      },
    );

    // ── Forward secrecy: the Remove commit alone does NOT revoke access ──
    //
    // RFC 9420 §12.4 requires a Commit to carry an UpdatePath when it covers
    // any proposal that is not an Add. ts-mls 1.6.2 gets that condition wrong
    // (clientState.js:460 tests `grouped.remove.length > 1`), so a commit that
    // removes exactly ONE member ships with no path. With no path there is no
    // fresh commit secret, the next epoch's key schedule follows deterministically
    // from the previous init secret — which the removed member holds — and she
    // derives the new chainKey byte-for-byte. Removal would revoke nothing.
    //
    // The follow-up is an EMPTY commit, which ts-mls does treat as requiring a
    // path (same line: `allProposals.length === 0`). Its path secrets are
    // encrypted to the resolution of the tree that no longer contains the
    // removed leaf, so she cannot compute this epoch and cannot process the
    // commit at all. The AEAD epoch is applied ONLY after both commits land, so
    // nothing is ever sealed under the intermediate epoch she can still read.
    //
    // Remove this once ts-mls emits a path for a single Remove — the test
    // "forward secrecy: a removed member cannot decrypt epoch N+1 from her own
    // state" is what keeps the guarantee honest either way.
    const rotateCommit = await createCommit(
      { state: removeCommit.newState, cipherSuite: cs },
      { extraProposals: [], ratchetTreeExtension: true, wireAsPublicMessage: true },
    );

    this.#roomStates.set(roomId, rotateCommit.newState);
    await this.#sendMlsMessage(roomId, removeCommit.commit, 'commit', tsMls);
    await this.#sendMlsMessage(roomId, rotateCommit.commit, 'commit', tsMls);
    await this.#applyEpoch(roomId, rotateCommit.newState);
    await this.#persistRoom(roomId);
  }

  /**
   * Get the current epoch authenticator (32 bytes) for partition detection.
   * Returns null if no state exists for the room.
   */
  getEpochAuthenticator(roomId: string): Uint8Array | null {
    const state = this.#roomStates.get(roomId);
    if (!state) return null;
    return state.keySchedule.epochAuthenticator;
  }

  /** Current epoch number for a room, or null. */
  getEpoch(roomId: string): number | null {
    return this.#aead.getEpoch(roomId);
  }

  /** Persist all room states to IndexedDB. Called on client teardown/reload. */
  async persistAll(): Promise<void> {
    for (const roomId of this.#roomStates.keys()) {
      await this.#persistRoom(roomId);
    }
  }

  /**
   * Restore all room states from IndexedDB. Called on client init.
   *
   * NOTE: ts-mls exposes encodeGroupState/decodeGroupState, but
   * decodeGroupState requires a ratchet tree to be supplied separately
   * (the tree is not part of the encoded state). Full state restoration
   * is a known limitation — the interface is in place for when ts-mls
   * adds a complete serialize/deserialize API.
   */
  async restoreAll(): Promise<void> {
    const tsMls = await this.#loadTsMls();
    const cs = await this.#getCiphersuite();
    const roomIds = await this.#stateStore.listRoomIds();
    for (const roomId of roomIds) {
      const stateBytes = await this.#stateStore.loadClientState(roomId);
      if (stateBytes && stateBytes.length > 0) {
        // TODO: decodeGroupState needs the ratchet tree — not currently
        // stored separately. This is a known limitation for v1.
        // When ts-mls adds a complete state serialization API, wire it here.
      }
    }
  }

  /** Dispose all resources. */
  dispose(): void {
    this.#disposed = true;
    this.#aead.dispose();
    this.#roomStates.clear();
    this.#roomGroupIds.clear();
    this.#pendingKeyPackages = [];
  }

  // ---- Private helpers ---------------------------------------------------

  /** Fetch a KeyPackage for a user from the server directory. */
  async #fetchKeyPackage(uid: string): Promise<KeyPackage> {
    const tsMls = await this.#loadTsMls();
    const resp = await fetch(`${this.#opts.keyPackageDirectoryUrl}/${uid}`, {
      headers: { 'Authorization': `Bearer ${this.#opts.jwt}` },
    });
    if (!resp.ok) {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: KeyPackage fetch failed for ${uid}: ${resp.status}`);
    }
    const data = await resp.json() as { key_packages: Array<{ key_package_b64: string }> };
    if (!data.key_packages?.length) {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: no KeyPackages for ${uid}`);
    }
    const kpBytes = base64ToBytes(data.key_packages[0]!.key_package_b64);
    const decoded = tsMls.decodeMlsMessage(kpBytes, 0);
    if (!decoded) {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: failed to decode KeyPackage for ${uid}`);
    }
    const [kpMsg] = decoded;
    if (kpMsg.wireformat !== 'mls_key_package') {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: expected key_package, got ${kpMsg.wireformat}`);
    }
    // Extract the KeyPackage from the MlsKeyPackage message.
    const keyPackage = (kpMsg as unknown as { keyPackage: KeyPackage }).keyPackage;

    // Bind the KeyPackage to the uid we asked for.
    //
    // The Delivery Service is untrusted — that is the whole premise of MLS.
    // Nothing above this line ties the bytes it returned to `uid`: ts-mls
    // validates the KeyPackage's self-signature, which only proves whoever
    // minted it held the matching key, not that they are the person requested.
    // Without this check a hostile or compromised directory answers "give me
    // bob's KeyPackage" with mallory's, the caller commits an Add, and the room
    // shows Bob joining while Mallory holds the keys.
    const cred = keyPackage.leafNode.credential;
    if (cred.credentialType !== 'basic') {
      throw new SDKChatError(
        'mls_keypackage_identity_mismatch',
        `MLSGroupManager: KeyPackage for ${uid} uses unsupported credential type ${cred.credentialType}`,
      );
    }
    if (!arrayEquals((cred as { identity: Uint8Array }).identity, new TextEncoder().encode(uid))) {
      throw new SDKChatError(
        'mls_keypackage_identity_mismatch',
        `MLSGroupManager: directory returned a KeyPackage for a different identity than ${uid}`,
      );
    }

    return keyPackage;
  }

  /** Send a Welcome message to a specific user via the server. */
  async #sendWelcome(
    roomId: string,
    targetUid: string,
    welcome: import('ts-mls').Welcome,
    tsMls: TsMlsModule,
    _cs: CiphersuiteImpl,
  ): Promise<void> {
    // Wrap the Welcome in an MlsWelcome message for encoding.
    // `version` is REQUIRED — see the note in publishKeyPackage. Without it the
    // recipient's processWelcome fails at decodeMlsMessage.
    const welcomeMsg: MLSMessage = {
      version: MLS_PROTOCOL_VERSION,
      wireformat: 'mls_welcome',
      welcome,
    };
    const welcomeBytes = tsMls.encodeMlsMessage(welcomeMsg);
    const baseUrl = this.#opts.keyPackageDirectoryUrl.replace('/keys', '');
    const resp = await fetch(
      `${baseUrl}/rooms/${roomId}/mls-welcome`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#opts.jwt}`,
        },
        body: JSON.stringify({
          welcome_b64: bytesToBase64(welcomeBytes),
          target_uid: targetUid,
        }),
      },
    );
    if (!resp.ok) {
      throw new SDKChatError('server_error', `MLSGroupManager: sendWelcome failed: ${resp.status}`);
    }
  }

  /** Send an MLS protocol message (proposal/commit) via the server. */
  async #sendMlsMessage(
    roomId: string,
    msg: MLSMessage,
    type: 'proposal' | 'commit',
    tsMls: TsMlsModule,
  ): Promise<void> {
    const msgBytes = tsMls.encodeMlsMessage(msg);
    const baseUrl = this.#opts.keyPackageDirectoryUrl.replace('/keys', '');
    const resp = await fetch(
      `${baseUrl}/rooms/${roomId}/mls-messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#opts.jwt}`,
        },
        body: JSON.stringify({
          message_b64: bytesToBase64(msgBytes),
          message_type: type,
          epoch: this.#aead.getEpoch(roomId) ?? 0,
        }),
      },
    );
    if (!resp.ok) {
      throw new SDKChatError('server_error', `MLSGroupManager: sendMlsMessage failed: ${resp.status}`);
    }
  }

  /** Persist a room's ClientState to the state store. */
  async #persistRoom(roomId: string): Promise<void> {
    if (this.#disposed) return;
    const state = this.#roomStates.get(roomId);
    if (!state) return;
    // ts-mls exposes encodeGroupState, but the ratchet tree is needed for
    // decode. For now, we store a placeholder so listRoomIds works.
    // TODO: store the full state (encoded + ratchet tree) when ts-mls
    // adds a complete serialize/deserialize API.
    await this.#stateStore.saveClientState(roomId, new Uint8Array(0));
  }
}

// ---------------------------------------------------------------------------
// MlsProvider — CryptoProvider implementation
// ---------------------------------------------------------------------------

/**
 * The MLS crypto provider — implements CryptoProvider (seal/unseal/dispose)
 * and exposes the MLSGroupManager for group lifecycle operations.
 */
export interface MlsProvider extends CryptoProvider {
  /** The MLS group lifecycle manager. */
  readonly manager: MLSGroupManager;
}

/**
 * Create an MLS-backed CryptoProvider.
 *
 * The provider implements the CryptoProvider interface (seal/unseal/dispose)
 * via sframe-ratchet's createMlsChatProvider, and exposes an MLSGroupManager
 * for MLS group lifecycle operations (createGroup, processWelcome, etc.).
 *
 * ts-mls is loaded lazily via dynamic import — the dependency is only loaded
 * when MLS is actually used. If ts-mls is not installed, the provider throws
 * a clear error on first MLS operation (not at creation time).
 *
 * @example
 * ```ts
 * const provider = await createMlsProvider({
 *   identityKey: ed25519PrivateKey,
 *   credential: 'basic',
 *   uid: 'user-123',
 *   keyPackageDirectoryUrl: 'https://api.oxpulse.chat/api/sdk/keys',
 *   jwt: token,
 * });
 * await provider.manager.publishKeyPackage();
 * await provider.manager.createGroup('room-1', ['alice', 'bob']);
 * const sealed = await provider.seal(plaintext, { roomId: 'room-1', senderUid: 'user-123' });
 * ```
 */
export async function createMlsProvider(opts: MlsProviderOptions): Promise<MlsProvider> {
  // Create the AEAD layer (sframe-ratchet chat/mls provider).
  // uidToPeerId MUST match defaultCredentialToPeerId in sframe-ratchet/mls:
  // basic credential → base64(identity bytes).
  const uidToPeerId = (uid: string): string =>
    bytesToBase64(new TextEncoder().encode(uid));
  const aead = createMlsChatProvider({
    suite: 'AES_128_GCM_SHA256',
    uidToPeerId,
    ...(opts.replayWindow !== undefined ? { replayWindow: opts.replayWindow } : {}),
    durableReplayNamespace: opts.durableReplayNamespace ?? 'oxpulse-mls',
  });

  // Create the state store (IndexedDB-backed by default).
  const { createIdbMlsStateStore } = await import('./mls-state-store.js');
  const stateStore = opts.stateStore ?? createIdbMlsStateStore();

  // Create the group manager.
  const manager = new MLSGroupManager(opts, aead, stateStore);

  return {
    manager,

    async seal(plaintext: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const result = await aead.seal(new Uint8Array(plaintext), ctx);
      return result.slice().buffer as ArrayBuffer;
    },

    async unseal(
      sealed: ArrayBuffer,
      ctx: SealContext,
      signal?: AbortSignal,
    ): Promise<ArrayBuffer> {
      signal?.throwIfAborted();
      const result = await aead.unseal(new Uint8Array(sealed), ctx);
      return result.slice().buffer as ArrayBuffer;
    },

    dispose(): void {
      manager.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Uint8Array → standard base64 string (delegates to utils.arrayBufferToBase64). */
function bytesToBase64(bytes: Uint8Array): string {
  return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** Standard base64 string → Uint8Array (delegates to utils.base64ToArrayBuffer). */
function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(b64));
}

/**
 * Does this inbound message advance the epoch WITHOUT rotating the key material
 * away from a member it just removed?
 *
 * True for a commit that carries a Remove proposal and no UpdatePath. RFC 9420
 * §12.4 says that combination should not exist; ts-mls 1.6.2 produces it for a
 * single Remove, and the resulting epoch is derivable by the removed member.
 *
 * Returns false for anything it cannot read, which is the right default for the
 * cases that reach it: a commit with only Adds legitimately omits the path (the
 * new member is served by the Welcome and nobody is being revoked), and a
 * private-message commit is opaque before processing. Our own sender always
 * frames commits as public messages, so the inspectable path is the one that
 * carries our removals.
 *
 * Proposals sent by reference cannot be classified from the wire, so a pathless
 * commit carrying any of them is treated as revoking — deferring an epoch is
 * recoverable, installing an exposed one is not.
 */
function commitRevokesWithoutPath(msg: MLSMessage): boolean {
  if (msg.wireformat !== 'mls_public_message') return false;
  const framed = (msg as { publicMessage?: { content?: unknown } }).publicMessage?.content as
    | { contentType?: string; commit?: { path?: unknown; proposals?: unknown[] } }
    | undefined;
  if (framed?.contentType !== 'commit' || !framed.commit) return false;
  if (framed.commit.path !== undefined) return false;

  const proposals = framed.commit.proposals ?? [];
  return proposals.some((entry) => {
    const p = entry as { proposalOrRefType?: string; proposal?: { proposalType?: string } };
    if (p.proposalOrRefType !== 'proposal') return true; // by-reference: unclassifiable
    return p.proposal?.proposalType === 'remove';
  });
}

/** Constant-time array equality (avoids timing side-channels on identity match). */
function arrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
