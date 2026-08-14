/**
 * Discrete failure modes returned by the SDKChat HTTP API.
 *
 * Defined HERE (not in types.ts) so the cycle types.ts↔errors.ts disappears.
 * Public API surface unchanged — `index.ts` and `types.ts` both re-export
 * this name so consumers' `import { SDKChatErrorCode } from '@oxpulse/chat-sdk'`
 * keeps resolving.
 */
export type SDKChatErrorCode =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'unsupported'
  | 'invalid_args'
  /** Phase 2 SEC-CR-1694: server emitted crypto_mode does not match client's configured expectation. */
  | 'crypto_mode_mismatch'
  /** Phase 2 SEC-CR-1695-02: client was poisoned by a prior crypto_mode_mismatch; recreate the instance. */
  | 'crypto_mode_poisoned'
  /** Phase 2 code-quality: sendText called before crypto_mode was discovered and e2ee is configured. */
  | 'crypto_mode_undiscovered'
  /** MLS: Welcome message could not be decrypted or processed. */
  | 'mls_welcome_decrypt_failed'
  /** MLS: No KeyPackage found for the requested user. */
  | 'mls_keypackage_not_found'
  /**
   * MLS: the directory returned a KeyPackage whose credential identity is not
   * the user that was asked for. The Delivery Service is untrusted in the MLS
   * threat model; substituting a KeyPackage is how it would insert its own
   * member into a group while the UI reports the intended one.
   */
  | 'mls_keypackage_identity_mismatch'
  /** MLS: Commit validation failed (invalid proposal, conflicting epoch, etc.). */
  | 'mls_commit_validation_failed'
  /** MLS: Local epoch does not match the expected epoch (desync). */
  | 'mls_epoch_desync'
  /** MLS: Persisted ClientState is corrupted or incompatible. */
  | 'mls_state_corruption'
  /** MLS: IndexedDB is unavailable for state persistence (private browsing, SSR). */
  | 'mls_idb_unavailable'
  /** MLS: No AuthenticationService provided (KCI protection required). */
  | 'mls_auth_service_required';

/**
 * Typed error thrown by SDKChatClient for all API failures.
 */
export class SDKChatError extends Error {
  readonly code: SDKChatErrorCode;
  readonly statusCode?: number;

  constructor(code: SDKChatErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'SDKChatError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown by `batchAddMembers` when a chunk fails mid-stream.
 *
 * Carries the partial-success aggregate from all chunks that completed
 * before the failure, so the caller can compute the residual and retry.
 *
 * @example
 * ```ts
 * try {
 *   const result = await client.batchAddMembers(roomId, userIds);
 * } catch (e) {
 *   if (e instanceof SDKChatBatchError) {
 *     console.log('partial:', e.partial);
 *     // retry e.failedChunk + e.remaining
 *     const toRetry = [...e.failedChunk, ...e.remaining];
 *   }
 * }
 * ```
 */
export class SDKChatBatchError extends SDKChatError {
  /** Aggregated successes from chunks completed before failure */
  readonly partial: { added: string[]; updated: string[] };
  /** Index into the user_ids array of the first user in the failed chunk */
  readonly failedAtIndex: number;
  /** user_ids in the failed chunk (i.e. the ones whose state is unknown) */
  readonly failedChunk: string[];
  /** user_ids not yet attempted (chunks after the failed one) */
  readonly remaining: string[];
  /** original underlying cause */
  readonly cause: Error | unknown;

  constructor(
    code: SDKChatErrorCode,
    message: string,
    opts: {
      partial: { added: string[]; updated: string[] };
      failedAtIndex: number;
      failedChunk: string[];
      remaining: string[];
      cause: Error | unknown;
    },
    statusCode?: number,
  ) {
    super(code, message, statusCode);
    this.name = 'SDKChatBatchError';
    this.partial = opts.partial;
    this.failedAtIndex = opts.failedAtIndex;
    this.failedChunk = opts.failedChunk;
    this.remaining = opts.remaining;
    this.cause = opts.cause;
  }
}
