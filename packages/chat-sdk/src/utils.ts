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

/** Returns jittered backoff in ms. Caps at 30 s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 30_000);
  return base * (0.8 + Math.random() * 0.4);
}

/**
 * Generate a UUID v4, with a safe fallback for environments where `crypto.randomUUID`
 * is unavailable (Node 18 without `--experimental-global-webcrypto`, non-secure HTTP,
 * test environments, etc.).
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

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
