/**
 * @oxpulse/chat-widget — auth error detection utility (W2.2 slice 5).
 */

import type { WriteFailureReason } from '../types.js';

/**
 * Regex patterns in error messages that indicate an authentication failure.
 * Uses word-boundary anchors to prevent false positives like "offer expired",
 * "session expired (cache)", or "subscription will expire soon".
 */
const AUTH_MESSAGE_PATTERNS: RegExp[] = [
  /\btoken\s+expired\b/i,
  /\bjwt\s+expired\b/i,
  /\bunauthorized\b/i,
  /\binvalid\s+token\b/i,
  /\bauthentication\s+(?:failed|required)\b/i,
];

/**
 * Returns true if the given error indicates an authentication failure
 * (401, 403, auth_expired kind, unauthorized/forbidden code, or message
 * containing an auth-related pattern).
 *
 * Used to differentiate auth errors (require fresh JWT) from network errors
 * (can be retried with same JWT).
 *
 * Understands both the widget's own bridged shape (`{status, kind}`, used by
 * the subscribe/reconnect path) and the raw SDKChatError shape
 * (`{statusCode, code}`, thrown directly by sendReaction/removeReaction/
 * sendText) — a call site never needs to hand-build a bridge object before
 * calling this (write-401 fix, issue #78: that bridging used to live only
 * inline in element.ts's handleSubscribeError; extended here instead of
 * copying it a 2nd and 3rd time into message-list.ts and the composer path).
 */
export function isAuthError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;

  const e = err as Record<string, unknown>;

  // kind-based detection (widget-bridged shape)
  if (e['kind'] === 'auth_expired') return true;

  // code-based detection (raw SDKChatError shape). Deliberate broadening
  // (pr-review-council #80 MINOR): the old inline subscribe-path check this
  // replaced only matched code === 'unauthorized'; 'forbidden' is added
  // here as a superset — a 403 is auth-shaped the same way a 401 is (both
  // already matched via the status branch below), so a raw SDKChatError
  // with code 'forbidden' should be treated identically.
  if (e['code'] === 'unauthorized' || e['code'] === 'forbidden') return true;

  // status-based detection — widget shape uses `status`, SDKChatError uses `statusCode`.
  const status = e['status'] ?? e['statusCode'];
  if (status === 401 || status === 403) return true;

  // message pattern detection (status-first — patterns only when no status available)
  if (typeof e['message'] === 'string') {
    const msg = e['message'] as string;
    for (const pattern of AUTH_MESSAGE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
  }

  return false;
}

/**
 * Classify a write-op failure (sendReaction/removeReaction/sendText) into
 * the coarse reason bucket the write-failure telemetry hook reports (issue
 * #78: onWriteError / oxpulse-chat:write-error detail.reason). auth_expired
 * takes priority over a 'network' code — an expired token is actionable
 * (refresh + retry), a transient network blip is not.
 */
export function classifyWriteFailureReason(err: unknown): WriteFailureReason {
  if (isAuthError(err)) return 'auth_expired';
  if (err != null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e['code'] === 'network') return 'network';
  }
  return 'other';
}
