/**
 * Shared utility functions for @oxpulse/chat-sdk.
 *
 * Mirror: web/src/lib/api/sdkChat.ts contains equivalent implementations.
 * Keep in sync when modifying either file.
 */

import type { SDKChatErrorCode, TypingEvent, PresenceEvent, ReadReceiptEvent } from './types.js';

/** Callbacks accepted by dispatchTransient — subset of SubscribeArgs / SubscribeOpts. */
export interface TransientCallbacks {
  onTyping?: (event: TypingEvent) => void;
  onPresence?: (event: PresenceEvent) => void;
  onReadReceipt?: (event: ReadReceiptEvent) => void;
}

/**
 * Route a transient SSE event (typing / presence / read_receipt) to the
 * appropriate callback.
 *
 * Single source of truth — imported by both packages/chat-sdk/src/client.ts
 * and web/src/lib/api/sdkChat.ts. Keep in sync with the event shapes emitted
 * by sdk_presence.rs.
 */
export function dispatchTransient(
  evType: string,
  data: Record<string, unknown>,
  callbacks: TransientCallbacks,
): void {
  if (evType === 'typing' && callbacks.onTyping) {
    callbacks.onTyping({
      userId: String(data['user_id'] ?? ''),
      ttlSecs:
        typeof data['ttl_secs'] === 'number'
          ? data['ttl_secs']
          : undefined,
    });
  } else if (evType === 'presence' && callbacks.onPresence) {
    callbacks.onPresence({
      userId: String(data['user_id'] ?? ''),
      lastSeenAt: String(data['last_seen_at'] ?? ''),
    });
  } else if (evType === 'read_receipt' && callbacks.onReadReceipt) {
    callbacks.onReadReceipt({
      userId: String(data['user_id'] ?? ''),
      lastSeq:
        typeof data['last_seq'] === 'number'
          ? data['last_seq']
          : 0,
    });
  }
}

/**
 * ArrayBuffer → standard base64 string (with `+`/`/`, with padding).
 *
 * B2 fix: server uses `base64::engine::general_purpose::STANDARD` which rejects
 * URL-safe characters (`-`, `_`). All sealed payload round-trips MUST use this
 * function so client-produced base64 survives server decode.
 *
 * @deprecated `arrayBufferToBase64url` (URL-safe, no padding) is kept for
 * backward-compat with any existing callers outside this package; new code
 * MUST use `arrayBufferToBase64`.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** base64 (standard or url-safe, with or without padding) → ArrayBuffer. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Map an HTTP status code to an SDKChatErrorCode. */
export function httpStatusToCode(status: number): SDKChatErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_args';
  if (status >= 500) return 'server_error';
  return 'server_error'; // unreachable fallback
}

/**
 * Default exponential backoff schedule (ms) used by `backoffWithJitter` /
 * `backoffMs`. Caps at 30 s: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
 *
 * ADR-009: shared schedule across the SDK reconnect path so concurrent client
 * retries spread across a ±20% jitter window instead of synchronised waves.
 */
const DEFAULT_BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/**
 * Reconnect backoff with ±20% jitter and a configurable schedule.
 *
 * `base = schedule[attempt] ?? fallback`, then `Math.round(base * (0.8 +
 * Math.random() * 0.4))` spreads concurrent client retries across a window so
 * a server restart with N peers doesn't trigger N synchronised retry waves at
 * T+1s, T+2s…
 *
 * Same shape as `web/src/lib/reconnect-backoff.ts` — mirrored here as the
 * canonical SDK implementation. `backoffMs` is a thin opt-out wrapper over
 * this function using the default exponential schedule + 30 s fallback.
 *
 * @param attempt   0-based reconnect attempt index.
 * @param schedule  readonly base delays indexed by attempt; defaults to the
 *                  exponential `[1000, 2000, 4000, 8000, 16000, 30000]`.
 * @param fallback  base delay used once `attempt` exceeds `schedule.length`;
 *                  defaults to `30000`.
 * @returns jittered delay in ms (±20% of the base).
 */
export function backoffWithJitter(
  attempt: number,
  schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE,
  fallback = 30_000,
): number {
  const base = schedule[attempt] ?? fallback;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Returns jittered backoff in ms. Caps at 30 s.
 *
 * Thin wrapper over `backoffWithJitter` using the default exponential schedule
 * + 30 s fallback. Signature unchanged (backward compatible) — existing
 * callers (`client.ts`) are unaffected.
 */
export function backoffMs(attempt: number): number {
  return backoffWithJitter(attempt);
}

/**
 * Generate a UUID v4 using a cryptographically-secure RNG.
 *
 * F13 (fail-closed CSPRNG): `crypto.randomUUID` is preferred; otherwise the 16 random bytes
 * come from `crypto.getRandomValues`. When NEITHER is available we THROW rather than fall back
 * to `Math.random()` — a non-CSPRNG would be a SILENT security downgrade for any caller that
 * treats the id as unpredictable, and this is a public export (index.ts) usable for nonces /
 * session ids, not only message ids. On every supported runtime — a browser secure origin, or
 * Node >= 18 with WebCrypto (`globalThis.crypto`) — `getRandomValues` is present, so the throw
 * is unreachable in practice; it converts an unsupported/insecure runtime into a loud error
 * instead of weak randomness.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error(
      'generateUUID: no cryptographically-secure RNG available (crypto.randomUUID and ' +
        'crypto.getRandomValues are both absent). Refusing to fall back to Math.random() — ' +
        'run on a secure origin / a runtime with WebCrypto.',
    );
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // RFC 4122 variant/version bits.
  bytes.set([((bytes[6] ?? 0) & 0x0f) | 0x40], 6);
  bytes.set([((bytes[8] ?? 0) & 0x3f) | 0x80], 8);

  const parts = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    parts.slice(0, 4).join('') + '-' +
    parts.slice(4, 6).join('') + '-' +
    parts.slice(6, 8).join('') + '-' +
    parts.slice(8, 10).join('') + '-' +
    parts.slice(10).join('')
  );
}
