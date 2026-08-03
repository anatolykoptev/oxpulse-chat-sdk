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
 *   including cross-reload replay when IndexedDB is available (SEC-CR-003).
 * - Does NOT defend: forward secrecy, post-compromise security, sender deniability
 *   (symmetric key — any room member can forge messages from any other member).
 *   Document loudly in production SDKs.
 *
 * ## Durable replay (SEC-CR-003, CWE-294)
 * Since sframe-ratchet 0.5.5 the library's `createChatProvider` builds the
 * `DurableReplayGuard` internally when `durableReplay` is not `false` and a
 * `namespace` is supplied. The SDK delegates entirely to the library — the
 * former custom 365-line guard (`sframe-replay.ts`) was removed and the
 * `namespace` / `durableReplayWindow` options are forwarded transparently.
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

import { createChatProvider } from 'sframe-ratchet/chat';
import type { ChatSFrameProvider, ChatProviderOptions } from 'sframe-ratchet/chat';
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
   * SEC-CR-003: durable, cross-reload receiver-side anti-replay. Default ON when a
   * `durableReplayNamespace` (or `ctrKeyspace`) is provided, graceful no-op (with a
   * one-time warning) when IndexedDB / Web Locks is unavailable (SSR / Node / private
   * mode / legacy Safari <15.4). Set `false` to opt out entirely (reverts to the
   * library's session-scoped in-memory window only).
   *
   * Since sframe-ratchet 0.5.5 the guard is built inside `createChatProvider`; the
   * SDK forwards `namespace` and `durableReplayWindow` transparently.
   */
  durableReplay?: boolean;
  /**
   * Namespace for the durable replay IDB store (isolate independent key-spaces).
   * Defaults to `ctrKeyspace` when available, otherwise `'default'` (preserves
   * the pre-0.5.5 behavior where the SDK's own guard defaulted to `'default'`).
   * The SDK's `SDKChatClient` overrides this with `appId` for per-tenant isolation.
   */
  durableReplayNamespace?: string;
  /**
   * Durable replay window size (distinct recent CTRs per sender per room). Default
   * equals `replayWindow` (1024). Must be <= `replayWindow` — the in-memory window
   * is the session-scoped backstop, and a durable window LARGER than the in-memory
   * one removes that backstop for the extra span (reopens a narrow in-session replay
   * window). `0` disables the durable window (mirrors `replayWindow: 0`).
   */
  durableReplayWindow?: number;
}

/**
 * Create a CryptoProvider backed by sframe-ratchet v0.5.5+ chat-mode.
 *
 * The returned provider is stateful (key cache + replay window + durable guard).
 * Create one instance per application lifetime and share it across
 * SDKChatClient instances that share the same key space.
 */
export function createSFrameProvider(opts: SFrameProviderOptions): CryptoProvider {
  // Resolve the durable-replay namespace: explicit override → ctrKeyspace → 'default'.
  // sframe-ratchet 0.5.5+ enables durable replay by default when a namespace is
  // provided (issue #41). Defaulting to 'default' preserves the pre-0.5.5 behavior
  // where the SDK's own DurableReplayGuard defaulted to 'default'. The library
  // constructs and owns the DurableReplayGuard internally — the SDK no longer ships its own.
  const namespace = opts.durableReplayNamespace ?? opts.ctrKeyspace ?? 'default';
  const chatOpts: ChatProviderOptions = {
    getKey: opts.getKey,
    ...(opts.ctrStrategy !== undefined ? { ctrStrategy: opts.ctrStrategy } : {}),
    ...(opts.ctrKeyspace !== undefined ? { ctrKeyspace: opts.ctrKeyspace } : {}),
    ...(opts.replayWindow !== undefined ? { replayWindow: opts.replayWindow } : {}),
    ...(opts.durableReplay !== undefined ? { durableReplay: opts.durableReplay } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(opts.durableReplayWindow !== undefined
      ? { durableReplayWindow: opts.durableReplayWindow }
      : {}),
  };
  const inner: ChatSFrameProvider = createChatProvider(chatOpts);

  return {
    async seal(plaintext: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const result = await inner.seal(new Uint8Array(plaintext), ctx);
      // Materialize a fresh ArrayBuffer containing only the view's bytes.
      // result.buffer may be a pooled/shared buffer; slicing isolates our data.
      return result.slice().buffer as ArrayBuffer;
    },

    async unseal(
      sealed: ArrayBuffer,
      ctx: SealContext,
      signal?: AbortSignal,
    ): Promise<ArrayBuffer> {
      // Advisory cancel: the SDK aborts `signal` at its per-row deadline. We honor it
      // (stdlib signal.throwIfAborted) only at await boundaries, because the AES-GCM
      // decrypt inside inner.unseal is atomic and non-cancellable; an abort during a
      // slow durable pre-check skips the uncancellable decrypt entirely. Once the
      // decrypt has run we complete normally (record + return) — a valid plaintext is
      // never discarded.
      signal?.throwIfAborted();
      const bytes = new Uint8Array(sealed);
      const result = await inner.unseal(bytes, ctx);
      // Same pooled-buffer defense: materialize a fresh isolated ArrayBuffer.
      return result.slice().buffer as ArrayBuffer;
    },

    dispose(): void {
      inner.dispose();
    },
  };
}
