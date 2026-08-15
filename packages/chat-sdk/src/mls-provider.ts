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
 * - MLS credential verification via ts-mls AuthenticationService. The default
 *   implementation validates basic credentials by matching the identity bytes.
 *   Callers can override via MlsProviderOptions.authService.
 * - The provider surfaces the epoch authenticator for optional out-of-band
 *   verification (partition detection / safety numbers).
 *
 * ## State persistence
 *
 * MLS ClientState is serialized via `clientStateEncoder`/`clientStateDecoder`
 * (ts-mls 2.0) and persisted to IndexedDB via `MLSStateStore`. Group state
 * survives page reloads.
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
import { equalBytes } from '@noble/curves/utils.js';

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

  /**
   * AuthenticationService for credential validation (KCI protection).
   * REQUIRED — the provider throws if this is not provided.
   * Implement this to validate basic credentials against a known
   * UID → identity-public-key mapping (e.g. fetched from the server DS).
   */
  authService: import('ts-mls').AuthenticationService;

  /**
   * Called when a non-fatal MLS event occurs that the SDK consumer should
   * surface to the user (e.g. a Welcome that could not be processed). The
   * error is also rethrown so the caller can react; the warning gives the
   * user visibility. The Welcome is NOT acked — the server re-delivers it
   * and the next attempt may succeed (e.g. after a KeyPackage restore).
   *
   * When omitted, warnings are emitted via `console.warn`.
   */
  onWarning?: (warning: MlsWarning) => void;
}

/**
 * A non-fatal MLS warning surfaced through `onWarning`.
 *
 * Emitted before the error is rethrown, so the calling operation IS
 * aborted — the warning gives the user visibility while the rethrow lets
 * the caller react. The Welcome is left queued for server re-delivery.
 */
export type MlsWarning =
  | {
      /** A Welcome could not be processed (wrong KeyPackage, decode failure, etc.). */
      code: 'mls_welcome_processing_failed';
      /** Room ID the Welcome was for. */
      roomId: string;
      /** Server-assigned Welcome ID. */
      welcomeId: string;
      /** Human-readable detail. */
      message: string;
    };

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
type MlsMessage = import('ts-mls').MlsMessage;
type MlsFramedMessage = import('ts-mls').MlsFramedMessage;
type MlsContext = import('ts-mls').MlsContext;
type AuthenticationService = import('ts-mls').AuthenticationService;
type RatchetTree = import('ts-mls').RatchetTree;

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
  /** Lazy-loaded MlsContext (cipherSuite + authService). */
  #ctx: MlsContext | null = null;
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
  /**
   * Warnings callback — called for non-fatal MLS events (e.g. a Welcome whose
   * KeyPackage was already consumed). Can be set after construction.
   * Defaults to `opts.onWarning` (or `console.warn` when not provided).
   */
  onWarning?: (warning: MlsWarning) => void;

  constructor(opts: MlsProviderOptions, aead: MlsChatProvider, stateStore: MLSStateStore) {
    this.#opts = opts;
    this.#aead = aead;
    this.#stateStore = stateStore;
    this.onWarning = opts.onWarning;
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
    this.#cs = await tsMls.getCiphersuiteImpl(name, tsMls.nobleCryptoProvider);
    return this.#cs;
  }

  /** Build the MlsContext (cipherSuite + authService). */
  async #getContext(): Promise<MlsContext> {
    if (this.#ctx) return this.#ctx;
    const cs = await this.#getCiphersuite();
    if (!this.#opts.authService) {
      throw new SDKChatError(
        'mls_auth_service_required',
        'MLS requires an AuthenticationService for credential validation (KCI protection). ' +
        'Pass options.authService to createMlsProvider — do not use unsafeTestingAuthenticationService in production.',
      );
    }
    this.#ctx = { cipherSuite: cs, authService: this.#opts.authService };
    return this.#ctx;
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

    const { generateKeyPackage, defaultCapabilities, defaultLifetime, encode, mlsMessageEncoder,
            defaultCredentialTypes, wireformats, protocolVersions } = tsMls;
    const credential = {
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(this.#opts.uid),
    };

    const { publicPackage, privatePackage } = await generateKeyPackage({
      credential,
      capabilities: defaultCapabilities(),
      lifetime: defaultLifetime(),
      cipherSuite: cs,
    });

    // Serialize and publish to the server directory.
    // The KeyPackage is a public key — safe to send over HTTPS.
    // Wrap it in an MlsKeyPackage message for encoding.
    const keyPackageMsg: MlsMessage = {
      wireformat: wireformats.mls_key_package,
      keyPackage: publicPackage,
      version: protocolVersions.mls10,
    };
    const keyPackageBytes = encode(mlsMessageEncoder, keyPackageMsg);
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
    const ctx = await this.#getContext();

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
    const { createGroup, createCommit, defaultProposalTypes } = tsMls;
    let state = await createGroup({
      context: ctx,
      groupId,
      keyPackage: myKp.publicPackage,
      privateKeyPackage: myKp.privatePackage,
    });

    // Fetch KeyPackages for all members and add them via commits.
    // v1: sequential commits (one per member). Simple, correct, slow for large groups.
    for (const uid of memberUids) {
      if (uid === this.#opts.uid) continue; // skip self

      const memberKp = await this.#fetchKeyPackage(uid);
      const commitResult = await createCommit({
        context: ctx,
        state,
        extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: memberKp } }],
        ratchetTreeExtension: true,
        wireAsPublicMessage: true,
      });
      state = commitResult.newState;

      // Send the Welcome message to the new member via the server.
      if (commitResult.welcome?.welcome) {
        await this.#sendWelcome(roomId, uid, commitResult.welcome.welcome, tsMls);
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
   *
   * ## SSE wiring contract (consumer responsibility)
   *
   * `SDKChatClient` does NOT auto-wire MLS SSE events. The SDK consumer
   * MUST listen for `mls-welcome` events on the server SSE stream and
   * call this method:
   *
   * ```ts
   * const manager = await client.getMlsManager();
   * // On SSE event "mls-welcome" with { room_id, welcome_b64 }:
   * await manager.processWelcome(roomId, base64ToBytes(welcome_b64));
   * ```
   */
  async processWelcome(roomId: string, welcome: Uint8Array): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const ctx = await this.#getContext();

    if (this.#pendingKeyPackages.length === 0) {
      throw new SDKChatError('mls_keypackage_not_found', 'MLSGroupManager.processWelcome: no pending KeyPackage');
    }

    const { decode, mlsMessageDecoder, joinGroup, wireformats } = tsMls;
    const decoded = decode(mlsMessageDecoder, welcome);
    if (!decoded) {
      throw new SDKChatError('mls_welcome_decrypt_failed', 'MLSGroupManager.processWelcome: failed to decode welcome message');
    }
    if (decoded.wireformat !== wireformats.mls_welcome) {
      throw new SDKChatError('mls_welcome_decrypt_failed', `MLSGroupManager.processWelcome: expected welcome, got ${decoded.wireformat}`);
    }

    const welcomeMsg = decoded as import('ts-mls').MlsWelcomeMessage;

    // Try each pending KeyPackage until one decrypts the Welcome. The group
    // creator picks key_packages[0] from the server's response, whose ordering
    // is unspecified; if the directory returns newest-first while our local
    // list is oldest-first, the creator seals to a key we never try. Trying
    // only #pendingKeyPackages[0] (the previous behaviour) fails the join even
    // when the client holds the right key. Remove only the KP that worked.
    let state: ClientState | undefined;
    let workedIndex = -1;
    let lastErr: unknown = null;
    for (let i = 0; i < this.#pendingKeyPackages.length; i++) {
      const kp = this.#pendingKeyPackages[i]!;
      try {
        state = await joinGroup({
          context: ctx,
          welcome: welcomeMsg.welcome,
          keyPackage: kp.publicPackage,
          privateKeys: kp.privatePackage,
        });
        workedIndex = i;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!state || workedIndex === -1) {
      throw lastErr ?? new SDKChatError(
        'mls_welcome_decrypt_failed',
        'MLSGroupManager.processWelcome: no pending KeyPackage could decrypt the welcome',
      );
    }

    // Extract groupId from the welcome's group info.
    const groupId = state.groupContext.groupId;

    // Verify the welcome's groupId is not already bound to a different room.
    // This prevents a confusion attack where a welcome for group A is sent
    // to a user expecting to join group B. The roomId → groupId mapping is
    // set by createGroup (creator) or here (joiner); if it's already set,
    // it must match.
    const existingGroupId = this.#roomGroupIds.get(roomId);
    if (existingGroupId && !equalBytes(existingGroupId, groupId)) {
      throw new SDKChatError(
        'mls_welcome_decrypt_failed',
        `MLSGroupManager.processWelcome: welcome groupId does not match existing binding for room ${roomId}`,
      );
    }

    this.#roomGroupIds.set(roomId, groupId);
    this.#roomStates.set(roomId, state);
    // Consume only the KeyPackage that worked.
    this.#pendingKeyPackages.splice(workedIndex, 1);
    await this.#applyEpoch(roomId, state);
    await this.#persistRoom(roomId);
  }

  /**
   * Process an inbound MLS protocol message (proposal/commit).
   * Called from the SSE handler on `mls-protocol` event.
   *
   * ## SSE wiring contract (consumer responsibility)
   *
   * `SDKChatClient` does NOT auto-wire MLS SSE events. The SDK consumer
   * MUST listen for `mls-protocol` events on the server SSE stream and
   * call this method:
   *
   * ```ts
   * const manager = await client.getMlsManager();
   * // On SSE event "mls-protocol" with { room_id, message_b64 }:
   * await manager.processMessage(roomId, base64ToBytes(message_b64));
   * ```
   */
  async processMessage(roomId: string, message: Uint8Array): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const ctx = await this.#getContext();

    const state = this.#roomStates.get(roomId);
    if (!state) {
      throw new SDKChatError('mls_epoch_desync', `MLSGroupManager.processMessage: no state for room ${roomId}`);
    }

    const { decode, mlsMessageDecoder, processMessage, acceptAll, wireformats } = tsMls;
    const decoded = decode(mlsMessageDecoder, message);
    if (!decoded) {
      throw new SDKChatError('mls_commit_validation_failed', 'MLSGroupManager.processMessage: failed to decode message');
    }

    // Only private/public messages are processable via processMessage.
    if (decoded.wireformat !== wireformats.mls_private_message &&
        decoded.wireformat !== wireformats.mls_public_message) {
      throw new SDKChatError('mls_commit_validation_failed', `MLSGroupManager.processMessage: unexpected wireformat ${decoded.wireformat}`);
    }

    const result = await processMessage({
      context: ctx,
      state,
      message: decoded as MlsFramedMessage,
      callback: acceptAll,
    });

    // If this was a commit, the state advances — apply the new epoch.
    if (result.kind === 'newState' && result.newState !== state) {
      this.#roomStates.set(roomId, result.newState);
      await this.#applyEpoch(roomId, result.newState);
      await this.#persistRoom(roomId);
    }
  }

  /**
   * Fetch and process all pending Welcome messages for a room.
   *
   * GETs the room's pending Welcomes from the server and processes each
   * in order, returning how many were applied. For each Welcome:
   *
   * - On success → acks it (DELETE) so the server stops re-notifying.
   * - On failure → reports a warning via `onWarning`/`console.warn` and
   *   rethrows. The Welcome is NOT acked — the server re-delivers it and
   *   the next attempt may succeed (e.g. the KeyPackage was sealed to a
   *   different pending one, or the private half has not been restored
   *   yet). A wrongly acked invite is silent and permanent; a stream of
   *   warnings is visible and bounded by the 7-day TTL.
   *
   * @returns The number of Welcomes successfully applied.
   */
  async fetchAndProcessWelcomes(roomId: string): Promise<number> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const baseUrl = this.#roomBaseUrl();
    const resp = await this.#fetchWithRetry(
      `${baseUrl}/rooms/${roomId}/mls-welcome`,
      { headers: { 'Authorization': `Bearer ${this.#opts.jwt}` } },
    );
    if (resp.status === 404) return 0; // no pending welcomes
    if (!resp.ok) {
      throw new SDKChatError('server_error', `fetchAndProcessWelcomes: GET failed: ${resp.status}`);
    }
    const data = await resp.json() as { welcomes: Array<{ welcome_id: string; welcome_b64: string }> };
    if (!data.welcomes) return 0;

    let applied = 0;
    for (const entry of data.welcomes) {
      const welcomeBytes = base64ToBytes(entry.welcome_b64);
      try {
        await this.processWelcome(roomId, welcomeBytes);
        applied++;
        // Ack on success — server stops re-notifying.
        await this.#ackWelcome(roomId, entry.welcome_id);
      } catch (err) {
        // Ack ONLY on success. A failure may be transient (the Welcome is
        // sealed to a different pending KeyPackage, or the private half has
        // not been restored yet) — acking would destroy a usable invite.
        // Report the warning and rethrow; re-delivery is the recovery.
        const warning: MlsWarning = {
          code: 'mls_welcome_processing_failed',
          roomId,
          welcomeId: entry.welcome_id,
          message: `Welcome ${entry.welcome_id} for room ${roomId} could not be processed: ${err instanceof Error ? err.message : String(err)}`,
        };
        if (this.onWarning) {
          this.onWarning(warning);
        } else {
          console.warn(`[chat-sdk] MLS: ${warning.message}`);
        }
        throw err;
      }
    }
    return applied;
  }

  /**
   * Fetch and process a single MLS protocol message by ID.
   *
   * GETs the protocol message from the server and feeds it to
   * `processMessage`. Not consumed server-side; the row expires after
   * an hour.
   */
  async fetchAndProcessMessage(roomId: string, messageId: string): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const baseUrl = this.#roomBaseUrl();
    const resp = await this.#fetchWithRetry(
      `${baseUrl}/rooms/${roomId}/mls-messages/${messageId}`,
      { headers: { 'Authorization': `Bearer ${this.#opts.jwt}` } },
    );
    if (resp.status === 404) {
      throw new SDKChatError('not_found', `fetchAndProcessMessage: message ${messageId} not found in room ${roomId}`);
    }
    if (!resp.ok) {
      throw new SDKChatError('server_error', `fetchAndProcessMessage: GET failed: ${resp.status}`);
    }
    const data = await resp.json() as { message_b64: string };
    const messageBytes = base64ToBytes(data.message_b64);
    await this.processMessage(roomId, messageBytes);
  }

  /**
   * Add a member: fetch their KeyPackage, create Add proposal + Commit, broadcast.
   */
  async addMember(roomId: string, uid: string): Promise<void> {
    if (this.#disposed) throw new SDKChatError('invalid_args', 'MLSGroupManager: disposed');
    const tsMls = await this.#loadTsMls();
    const ctx = await this.#getContext();

    const state = this.#roomStates.get(roomId);
    if (!state) {
      throw new SDKChatError('mls_epoch_desync', `MLSGroupManager.addMember: no state for room ${roomId}`);
    }

    const memberKp = await this.#fetchKeyPackage(uid);
    const { createCommit, defaultProposalTypes } = tsMls;
    const commitResult = await createCommit({
      context: ctx,
      state,
      extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: memberKp } }],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true,
    });

    this.#roomStates.set(roomId, commitResult.newState);

    if (commitResult.welcome?.welcome) {
      await this.#sendWelcome(roomId, uid, commitResult.welcome.welcome, tsMls);
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
    const ctx = await this.#getContext();

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
    const { createCommit, nodeTypes, defaultCredentialTypes, defaultProposalTypes } = tsMls;
    const targetIdentity = new TextEncoder().encode(uid);
    const tree = state.ratchetTree;
    let leafIndex = -1;
    for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex += 2) {
      const node = tree[nodeIndex];
      if (!node || node.nodeType !== nodeTypes.leaf || !node.leaf) continue;
      const cred = node.leaf.credential;
      if (cred.credentialType === defaultCredentialTypes.basic &&
          equalBytes((cred as { identity: Uint8Array }).identity, targetIdentity)) {
        leafIndex = Math.floor(nodeIndex / 2);
        break;
      }
    }
    if (leafIndex === -1) {
      throw new SDKChatError('not_found', `MLSGroupManager.removeMember: member ${uid} not found in room ${roomId}`);
    }

    const commitResult = await createCommit({
      context: ctx,
      state,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: leafIndex } }],
      ratchetTreeExtension: true,
      wireAsPublicMessage: true,
    });

    this.#roomStates.set(roomId, commitResult.newState);
    await this.#sendMlsMessage(roomId, commitResult.commit, 'commit', tsMls);
    await this.#applyEpoch(roomId, commitResult.newState);
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
   * Uses ts-mls 2.0 clientStateDecoder to deserialize ClientState.
   *
   * Integrity: MLS provides cryptographic integrity via the epoch authenticator
   * chain — a tampered ClientState will produce keys that fail AEAD verification
   * on the next seal/unseal. This method adds structural validation as
   * defence-in-depth: a corrupted state that fails to decode or has missing
   * fields is rejected before any crypto operation.
   */
  async restoreAll(): Promise<void> {
    const tsMls = await this.#loadTsMls();
    const { decode, clientStateDecoder } = tsMls;
    const roomIds = await this.#stateStore.listRoomIds();
    for (const roomId of roomIds) {
      const stateBytes = await this.#stateStore.loadClientState(roomId);
      if (stateBytes && stateBytes.length > 0) {
        let state: ClientState | undefined;
        try {
          state = decode(clientStateDecoder, stateBytes);
        } catch (err) {
          console.warn(`[chat-sdk] MLS: corrupted ClientState for room ${roomId}, dropping — ${err}`);
          await this.#stateStore.deleteClientState(roomId);
          continue;
        }
        if (!state?.groupContext?.groupId) {
          console.warn(`[chat-sdk] MLS: malformed ClientState for room ${roomId} (missing groupContext), dropping`);
          await this.#stateStore.deleteClientState(roomId);
          continue;
        }
        this.#roomStates.set(roomId, state);
        this.#roomGroupIds.set(roomId, state.groupContext.groupId);
        await this.#applyEpoch(roomId, state);
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

  /**
   * Derive the room base URL from the KeyPackage directory URL.
   *
   * Strips a single trailing `/keys` segment and nothing else.
   * This fixes #368: `String.prototype.replace('/keys', '')` replaces the
   * FIRST occurrence anywhere in the URL, silently mangling a directory URL
   * whose host or path contains `/keys` earlier (e.g.
   * `https://host/keys/api/sdk/keys` → `https://host/api/sdk/keys`).
   */
  #roomBaseUrl(): string {
    const dir = this.#opts.keyPackageDirectoryUrl;
    // Strip a single trailing '/keys' (with optional trailing slash before it).
    if (dir.endsWith('/keys')) return dir.slice(0, -'/keys'.length);
    if (dir.endsWith('/keys/')) return dir.slice(0, -'/keys/'.length);
    // If the directory URL doesn't end with /keys, use it as-is.
    return dir.replace(/\/$/, '');
  }

  /**
   * Fetch with bounded exponential backoff on 429 and transient 5xx.
   *
   * Retries 429, 502, 503, 504 (transient server-side failures). Other 4xx
   * are non-retryable — they indicate a permanent client-side problem.
   *
   * A transient 502/503/504 on `fetchAndProcessMessage` is a permanently
   * lost commit if not retried: the row expires after an hour and there is
   * no catch-up endpoint (oxpulse-chat#3090). Retrying 5xx with the same
   * bounded schedule gives transient blips a chance to recover.
   *
   * Honours `Retry-After` when the header is present (seconds or HTTP date),
   * otherwise 250 ms doubling, at most 3 retries, with ±20% jitter.
   * `Retry-After` is capped at 30 s — in this product's threat model the
   * server is the adversary, and an unbounded server-supplied sleep
   * (`Retry-After: 999999999`) would park the room's inbound path in a
   * setTimeout for ~31 years with nothing to cancel it: a denial-of-service
   * on the client, not a courtesy. When the header exceeds the cap we use
   * the cap rather than abandoning the attempt.
   *
   * Schedule note: 250 ms doubling over 3 retries is ~1.75 s of total
   * backoff. This gives up on any rate limit longer than ~2 s, but widening
   * it would let a malicious server stall the client longer by sending 429s
   * — the short schedule is defensive. `fetchAndProcessWelcomes` can be
   * re-called by the consumer later; `fetchAndProcessMessage` cannot, but
   * its 1-hour TTL is wider than any reasonable retry window, and the
   * consumer's SSE reconnection covers longer outages.
   *
   * After the last attempt throws `SDKChatError` — `mls_rate_limited` for
   * 429, `server_error` for 5xx — so a caller can tell the two apart.
   */
  async #fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const MAX_RETRIES = 3;
    const RETRY_AFTER_CAP_MS = 30_000;
    const RETRYABLE = new Set([429, 502, 503, 504]);
    let lastResp: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const resp = await fetch(url, init);
      if (!RETRYABLE.has(resp.status)) return resp;
      lastResp = resp;
      if (attempt === MAX_RETRIES) break;

      // Compute delay.
      let delayMs: number;
      const retryAfter = resp.headers.get('Retry-After');
      if (retryAfter !== null) {
        // Retry-After can be seconds or an HTTP-date.
        const asSeconds = Number(retryAfter);
        if (Number.isFinite(asSeconds)) {
          delayMs = Math.min(asSeconds * 1000, RETRY_AFTER_CAP_MS);
        } else {
          const asDate = Date.parse(retryAfter);
          delayMs = Number.isFinite(asDate)
            ? Math.min(Math.max(0, asDate - Date.now()), RETRY_AFTER_CAP_MS)
            : 0;
        }
      } else {
        // 250 ms doubling: 250, 500, 1000, ...
        delayMs = 250 * (2 ** attempt);
      }

      // Add ±20% jitter, then enforce the cap again so jitter never pushes
      // the delay above RETRY_AFTER_CAP_MS.
      const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
      delayMs = Math.min(Math.max(0, delayMs + jitter), RETRY_AFTER_CAP_MS);

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    // All retries exhausted — throw an error that reflects the last status.
    const code = lastResp?.status === 429 ? 'mls_rate_limited' : 'server_error';
    throw new SDKChatError(
      code,
      `MLSGroupManager: retries exhausted after ${MAX_RETRIES} attempts (last status ${lastResp?.status ?? 'unknown'})`,
      lastResp?.status,
    );
  }

  /** Ack a Welcome by deleting it from the server queue. */
  async #ackWelcome(roomId: string, welcomeId: string): Promise<void> {
    const baseUrl = this.#roomBaseUrl();
    const resp = await fetch(
      `${baseUrl}/rooms/${roomId}/mls-welcome/${welcomeId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.#opts.jwt}` },
      },
    );
    // 204 = acked, 404 = unknown or not ours — both are acceptable (idempotent).
    if (!resp.ok && resp.status !== 404) {
      throw new SDKChatError('server_error', `MLSGroupManager: ackWelcome failed: ${resp.status}`);
    }
  }

  async #fetchKeyPackage(uid: string): Promise<KeyPackage> {
    const tsMls = await this.#loadTsMls();
    const { decode, mlsMessageDecoder, wireformats } = tsMls;
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
    const decoded = decode(mlsMessageDecoder, kpBytes);
    if (!decoded) {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: failed to decode KeyPackage for ${uid}`);
    }
    if (decoded.wireformat !== wireformats.mls_key_package) {
      throw new SDKChatError('mls_keypackage_not_found', `MLSGroupManager: expected key_package, got ${decoded.wireformat}`);
    }
    // Extract the KeyPackage from the MlsKeyPackage message.
    const keyPackage = (decoded as unknown as { keyPackage: KeyPackage }).keyPackage;

    // Verify the KeyPackage's credential identity matches the requested UID.
    // The Delivery Service is untrusted in the MLS threat model — substituting
    // a KeyPackage is how a malicious DS would insert its own member into a
    // group while the UI reports the intended one.
    const cred = keyPackage.leafNode.credential as { credentialType: number; identity: Uint8Array };
    const expectedIdentity = new TextEncoder().encode(uid);
    if (cred.credentialType !== tsMls.defaultCredentialTypes.basic ||
        !equalBytes(cred.identity, expectedIdentity)) {
      throw new SDKChatError(
        'mls_keypackage_identity_mismatch',
        `MLSGroupManager: KeyPackage identity mismatch for ${uid} — the Delivery Service returned a KeyPackage for a different user.`,
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
  ): Promise<void> {
    // Wrap the Welcome in an MlsWelcome message for encoding.
    const welcomeMsg: MlsMessage = {
      wireformat: tsMls.wireformats.mls_welcome,
      welcome,
      version: tsMls.protocolVersions.mls10,
    };
    const welcomeBytes = tsMls.encode(tsMls.mlsMessageEncoder, welcomeMsg);
    const baseUrl = this.#roomBaseUrl();
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
    msg: MlsFramedMessage,
    type: 'proposal' | 'commit',
    tsMls: TsMlsModule,
  ): Promise<void> {
    const msgBytes = tsMls.encode(tsMls.mlsMessageEncoder, msg as MlsMessage);
    const baseUrl = this.#roomBaseUrl();
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
    const tsMls = await this.#loadTsMls();
    const stateBytes = tsMls.encode(tsMls.clientStateEncoder, state);
    await this.#stateStore.saveClientState(roomId, stateBytes);
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
