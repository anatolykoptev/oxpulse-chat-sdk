/**
 * SFrame E2EE adapter for @oxpulse/chat-sdk.
 *
 * Thin wrapper around sframe-ratchet/chat that converts ArrayBuffer↔Uint8Array
 * at the boundary and exposes a CryptoProvider interface consumed by SDKChatClient.
 *
 * ## Key contract
 * `getKey(roomId)` MUST return a CryptoKey with usages `['deriveKey','deriveBits']`
 * (HKDF base-key). Do NOT pass an AES-GCM key — the library will throw.
 *
 * ## Threat model (see design doc § C)
 * - Defends: message confidentiality, integrity, in-session sender auth, replay —
 *   including cross-reload replay when IndexedDB is available (SEC-CR-003, see
 *   `durableReplay` below and `sframe-replay.ts`).
 * - Does NOT defend: forward secrecy, post-compromise security, sender deniability
 *   (symmetric key — any room member can forge messages from any other member).
 *   Document loudly in production SDKs.
 *
 * @example
 * ```ts
 * // Demo: shared HKDF key imported from a 32-byte constant.
 * // Production: key is delivered out-of-band (X25519 + HKDF, or KMS).
 * const sharedHkdfKey = await crypto.subtle.importKey(
 *   'raw', sharedSecret32Bytes, 'HKDF', false, ['deriveKey', 'deriveBits']
 * );
 * const provider = createSFrameProvider({
 *   getKey: async (_roomId) => sharedHkdfKey,
 * });
 * ```
 */

import { createChatProvider, ReplayError } from 'sframe-ratchet/chat';
import type { ChatSFrameProvider, ChatProviderOptions } from 'sframe-ratchet/chat';
import { parseHeader } from 'sframe-ratchet';
import { DurableReplayGuard } from './sframe-replay.js';
import type { CryptoProvider, SealContext } from './types.js';

export interface SFrameProviderOptions {
  /**
   * Return an HKDF base-key with usages `['deriveKey', 'deriveBits']`.
   * Called once per room on first seal/unseal; result is cached by sframe-ratchet.
   *
   * CRITICAL: must NOT return an AES-GCM key — the library derives its own
   * per-sender AES-128-GCM key via HKDF internally.
   */
  getKey: (roomId: string) => Promise<CryptoKey>;

  /**
   * CTR allocation strategy passed through to sframe-ratchet. Default `'random-64'`.
   *
   * `'monotonic-idb'` persists the SENDER's per-frame counter to IndexedDB (requires
   * `ctrKeyspace`) and avoids the random-64 birthday bound. NOTE: it does NOT by itself
   * protect the RECEIVER across reloads — that is what `durableReplay` (below) does.
   */
  ctrStrategy?: 'random-64' | 'monotonic-idb';
  /** Required by sframe-ratchet when `ctrStrategy` is `'monotonic-idb'`; namespaces its CTR store. */
  ctrKeyspace?: string;
  /**
   * In-memory replay window size passed through to sframe-ratchet (recent CTRs tracked per
   * sender per room within a session). Default 1024. `0` disables the library's in-memory
   * window (debug only) — it does NOT disable the durable window; set `durableReplay: false`
   * for that.
   */
  replayWindow?: number;

  /**
   * SEC-CR-003: durable, cross-reload receiver-side anti-replay. Default ON when IndexedDB is
   * available, graceful no-op (with a one-time warning) when it is not (SSR / Node / private
   * mode). Set `false` to opt out entirely (reverts to the library's session-scoped in-memory
   * window only).
   */
  durableReplay?: boolean;
  /** Namespace for the durable replay IDB store (isolate independent key-spaces). Default `'default'`. */
  durableReplayNamespace?: string;
  /** Durable replay window size (distinct recent CTRs per sender per room). Default 1024. */
  durableReplayWindow?: number;
}

/**
 * Create a CryptoProvider backed by sframe-ratchet v0.5 chat-mode.
 *
 * The returned provider is stateful (key cache + replay window).
 * Create one instance per application lifetime and share it across
 * SDKChatClient instances that share the same key space.
 */
export function createSFrameProvider(opts: SFrameProviderOptions): CryptoProvider {
  const chatOpts: ChatProviderOptions = { getKey: opts.getKey };
  if (opts.ctrStrategy !== undefined) chatOpts.ctrStrategy = opts.ctrStrategy;
  if (opts.ctrKeyspace !== undefined) chatOpts.ctrKeyspace = opts.ctrKeyspace;
  if (opts.replayWindow !== undefined) chatOpts.replayWindow = opts.replayWindow;
  const inner: ChatSFrameProvider = createChatProvider(chatOpts);

  // SEC-CR-003: durable receiver-side replay window (default-on when IndexedDB is available).
  const durable =
    opts.durableReplay === false
      ? null
      : new DurableReplayGuard({
          namespace: opts.durableReplayNamespace ?? opts.ctrKeyspace,
          window: opts.durableReplayWindow,
        });

  return {
    async seal(plaintext: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const result = await inner.seal(new Uint8Array(plaintext), ctx);
      // Materialize a fresh ArrayBuffer containing only the view's bytes.
      // result.buffer may be a pooled/shared buffer; slicing isolates our data.
      return result.slice().buffer as ArrayBuffer;
    },

    async unseal(sealed: ArrayBuffer, ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
      // Advisory cancel: the SDK aborts `signal` at its per-row deadline. We honor it
      // (stdlib signal.throwIfAborted) only at await boundaries, because the AES-GCM
      // decrypt below is atomic and non-cancellable; an abort during a slow durable step
      // skips the uncancellable decrypt entirely. Once the decrypt has run we complete
      // normally (record + return) — a valid plaintext is never discarded.
      signal?.throwIfAborted();
      const bytes = new Uint8Array(sealed);

      // Durable pre-filter: reject a CTR we have already accepted (survives page reload).
      // The CTR lives in the RFC 9605 header, which is the AEAD AAD — authenticated, so the
      // server cannot alter it without failing AEAD below.
      //
      // check() and accept() straddle the `await inner.unseal` — the same check→decrypt→accept
      // ordering the library uses internally. Cross-reload replay protection is NOT weakened by
      // this gap: hydrate() atomically loads the persisted CTRs before any check() resolves, so a
      // frame accepted in a PRIOR session is always rejected regardless of concurrency.
      //
      // The only residual is a within-session double-DELIVERY of one genuinely-new CTR when two
      // unseal() calls for the same frame overlap. subscribe()/reconnect route every unseal
      // through the client's per-room serial decrypt chain (SEC-CR-14-01), so they are safe;
      // list() (client.ts) calls unseal() directly in a loop and is NOT serialized, so two
      // concurrent list() calls could double-deliver. This is a pre-existing, idempotent residual
      // tracked as tasks #44 / #42 (the public-list()-off-chain concurrency case) — not a replay
      // bypass introduced here.
      let ctr: bigint | undefined;
      if (durable?.available) {
        try {
          ctr = parseHeader(bytes).ctr;
        } catch {
          // Malformed header — let inner.unseal raise the authoritative parse/AEAD error.
        }
        if (ctr !== undefined && !(await durable.check(ctx.roomId, ctx.senderUid, ctr))) {
          throw new ReplayError(
            `sframe-chat: durable cross-reload replay detected ` +
              `(ctr=${ctr}, room=${ctx.roomId}, uid=${ctx.senderUid})`,
            { roomId: ctx.roomId, senderUid: ctx.senderUid, ctr },
          );
        }
      }

      // Last chance to skip the (uncancellable) decrypt if the deadline fired during
      // the durable pre-filter above. Past this point the decrypt runs to completion.
      signal?.throwIfAborted();
      const result = await inner.unseal(bytes, ctx);

      // Record ONLY after a successful AEAD verify (inner.unseal throws on forgery / in-session
      // replay), so a forged frame with a novel CTR cannot poison the durable window.
      if (durable?.available && ctr !== undefined) {
        await durable.accept(ctx.roomId, ctx.senderUid, ctr);
      }

      // Same pooled-buffer defense: materialize a fresh isolated ArrayBuffer.
      return result.slice().buffer as ArrayBuffer;
    },

    dispose(): void {
      inner.dispose();
    },
  };
}
