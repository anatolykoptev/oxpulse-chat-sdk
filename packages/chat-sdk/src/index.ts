/**
 * @oxpulse/chat-sdk — W4 skeleton
 *
 * Re-exports the typed HTTP client primitives used by the OxPulse SDK.
 * This package is published separately so third-party marketplace
 * integrations can `npm install @oxpulse/chat-sdk` without pulling in the
 * full SvelteKit front-end bundle.
 *
 * The full widget (iframe embed + Web Component) ships in W8 as
 * `@oxpulse/chat-widget`.
 *
 * Usage:
 * ```ts
 * import { SDKChatClient, SDKChatError } from '@oxpulse/chat-sdk';
 *
 * const client = new SDKChatClient({
 *   baseUrl: 'https://chat.example.com',
 *   jwt: await mintToken(),   // POST /api/sdk/tokens
 * });
 *
 * await client.send(roomId, { senderUid: uid, sealed: sealedBytes.buffer });
 * const history = await client.list(roomId, { afterSeq: 0, limit: 50 });
 * const unsub = client.subscribe(roomId, { onMessage: msg => render(msg) });
 * ```
 */

// ─── Public API surface ───────────────────────────────────────────────────────

export { SDKChatClient, BATCH_ADD_MEMBERS_CHUNK } from './client.js';
export type { SDKChatClientOptions, SendArgs, ListArgs, ListResult, SubscribeArgs, MessageRow, SDKChatErrorCode, UpdateMessageArgs, PinnedMessage, MutationEvent, ReactionEvent, ReactionsResponse, OptimisticHandle, CryptoProvider, E2EEOptions, SealContext, BatchAppendItem, CryptoMode } from './types.js';
// ─── W5: Room management types ───────────────────────────────────────────────
export type { Room, RoomSummary, Member, RoomVisibility } from './types.js';
export { createSFrameProvider } from './sframe.js';
// Re-export ReplayError from sframe-ratchet/chat so consumers can inspect unsealError: 'replay'.
export { ReplayError } from 'sframe-ratchet/chat';
export type { SFrameProviderOptions } from './sframe.js';
export type { PendingMessage } from './outbox.js';
export { SDKChatError, SDKChatBatchError } from './errors.js';

// ─── Push notification SDK ────────────────────────────────────────────────────

export { SDKPushClient, SDKPushError } from './push.js';
export type { SDKPushErrorCode, SubscribeResult, SubscriptionChangeListenerOpts } from './push.js';

// ─── Anon-read token minting ─────────────────────────────────────────────────

export { mintAnonReadToken, AnonReadMintError } from './anon-read.js';
export type { AnonReadMintResult, AnonReadMintErrorCode } from './anon-read.js';

// ─── Wire-codec re-exports (compression API) ─────────────────────────────────
// Production-safe symbols only. Test-only helpers (_evictDictForTesting,
// _resetLoaderForTesting) are intentionally excluded.
export { setDictLoader, setDictBaseUrl, ensureWireCodecReady } from '@oxpulse/wire-codec';
export type { DictLoader, DictName } from '@oxpulse/wire-codec';
