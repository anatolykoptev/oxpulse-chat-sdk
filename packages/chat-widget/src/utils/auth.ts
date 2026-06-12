/**
 * @oxpulse/chat-widget — auth error detection utility (W2.2 slice 5).
 */

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
 * (401, 403, auth_expired kind, or message containing auth-related pattern).
 *
 * Used to differentiate auth errors (require fresh JWT) from network errors
 * (can be retried with same JWT).
 */
export function isAuthError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;

  const e = err as Record<string, unknown>;

  // kind-based detection
  if (e['kind'] === 'auth_expired') return true;

  // status-based detection
  if (e['status'] === 401 || e['status'] === 403) return true;

  // message pattern detection (status-first — patterns only when no status available)
  if (typeof e['message'] === 'string') {
    const msg = e['message'] as string;
    for (const pattern of AUTH_MESSAGE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
  }

  return false;
}
