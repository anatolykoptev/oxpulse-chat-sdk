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
 * - Defends: message confidentiality, integrity, in-session sender auth, replay.
 * - Does NOT defend: forward secrecy, post-compromise security, cross-session replay
 *   (under random-64 strategy), sender deniability (symmetric key — any room member
 *   can forge messages from any other member). Document loudly in production SDKs.
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
import type { ChatSFrameProvider } from 'sframe-ratchet/chat';
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
}

/**
 * Create a CryptoProvider backed by sframe-ratchet v0.5 chat-mode.
 *
 * The returned provider is stateful (key cache + replay window).
 * Create one instance per application lifetime and share it across
 * SDKChatClient instances that share the same key space.
 */
export function createSFrameProvider(opts: SFrameProviderOptions): CryptoProvider {
  const inner: ChatSFrameProvider = createChatProvider({ getKey: opts.getKey });

  return {
    async seal(plaintext: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const result = await inner.seal(new Uint8Array(plaintext), ctx);
      // Materialize a fresh ArrayBuffer containing only the view's bytes.
      // result.buffer may be a pooled/shared buffer; slicing isolates our data.
      return result.slice().buffer as ArrayBuffer;
    },

    async unseal(sealed: ArrayBuffer, ctx: SealContext): Promise<ArrayBuffer> {
      const result = await inner.unseal(new Uint8Array(sealed), ctx);
      // Same pooled-buffer defense: materialize a fresh isolated ArrayBuffer.
      return result.slice().buffer as ArrayBuffer;
    },

    dispose(): void {
      inner.dispose();
    },
  };
}
