/**
 * @oxpulse/chat-widget — typed iframe ↔ parent postMessage protocol.
 *
 * All messages carry a "oxpulse-chat" namespace prefix to avoid collisions.
 * Type guards (isParentMessage / isIframeMessage) reject malformed payloads.
 *
 * Security (M1 + M2):
 *   M1: sendToParent() requires an explicit parent origin set via setParentOrigin().
 *       Messages are never sent with '*'. Unset → warn + drop.
 *   M2: onParentMessage() reads ?origin= from iframe URL and rejects events whose
 *       event.origin does not match.
 */

import type { ParentMessage, IframeMessage } from './types.js';

/** Namespace prefix on all postMessage payloads. */
const NS = 'oxpulse-chat' as const;

// ── Module state: expected parent origin (M1) ─────────────────────────────────

/**
 * The parent origin that iframe-side sendToParent() will target.
 * Must be set before calling sendToParent(). Set to null resets it.
 */
let expectedParentOrigin: string | null = null;

/**
 * Set (or clear) the expected parent origin for sendToParent().
 * Called from the iframe entry once the origin query param is read.
 */
export function setParentOrigin(origin: string | null): void {
  expectedParentOrigin = origin;
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasStringProp(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === 'string';
}

/**
 * Type guard: check that a raw postMessage event data is a well-formed ParentMessage.
 * Returns false for any malformed or unrelated message.
 */
export function isParentMessage(data: unknown): data is ParentMessage {
  if (!isObject(data)) return false;
  if (data['ns'] !== NS) return false;
  const type = data['type'];
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'init':
      return isObject(data['config']) && hasStringProp(data['config'] as Record<string, unknown>, 'appId');
    case 'refresh-token':
      return hasStringProp(data, 'jwt');
    case 'set-theme':
      return data['theme'] === 'light' || data['theme'] === 'dark' || data['theme'] === 'auto';
    default:
      return false;
  }
}

/**
 * Type guard: check that a raw postMessage event data is a well-formed IframeMessage.
 * Returns false for any malformed or unrelated message.
 */
export function isIframeMessage(data: unknown): data is IframeMessage {
  if (!isObject(data)) return false;
  if (data['ns'] !== NS) return false;
  const type = data['type'];
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'ready':
      return hasStringProp(data, 'roomId');
    case 'error':
      return hasStringProp(data, 'code') && hasStringProp(data, 'message');
    case 'token-expired':
      return hasStringProp(data, 'roomId');
    case 'resize':
      return typeof data['height'] === 'number';
    case 'user-action':
      return data['event'] === 'send' || data['event'] === 'reaction' || data['event'] === 'typing';
    default:
      return false;
  }
}

// ── Sender helpers ────────────────────────────────────────────────────────────

/** Wrap a ParentMessage with the namespace marker. */
function wrapParent(msg: ParentMessage): Record<string, unknown> {
  return { ns: NS, ...msg };
}

/** Wrap an IframeMessage with the namespace marker. */
function wrapIframe(msg: IframeMessage): Record<string, unknown> {
  return { ns: NS, ...msg };
}

/**
 * Send a token-refresh message from the parent to a specific iframe.
 *
 * M1 security: requires an EXPLICIT target origin (the resolved widget baseUrl).
 * A bearer JWT must never be posted to the '*' wildcard, so when no origin is
 * available the message is dropped with a warning — mirroring sendToParent()'s
 * "never send with '*'" discipline. There is no '*' fallback.
 */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function sendRefreshTokenToIframe(iframe: HTMLIFrameElement, jwt: string, targetOrigin: string): void {
  if (!targetOrigin) {
    // eslint-disable-next-line no-console
    console.warn('[oxpulse-chat-widget] sendRefreshTokenToIframe called without a target origin — token refresh dropped (JWT never posted to "*")');
    return;
  }
  iframe.contentWindow?.postMessage(
    wrapParent({ type: 'refresh-token', jwt }),
    targetOrigin,
  );
}

/**
 * Send an IframeMessage from the iframe to the parent window.
 * Used inside the iframe entry (iframe.ts).
 *
 * M1 security: requires expectedParentOrigin to be set via setParentOrigin().
 * If not set, logs a warning and drops the message (never targets '*').
 */
export function sendToParent(msg: IframeMessage): void {
  if (!expectedParentOrigin) {
    // eslint-disable-next-line no-console
    console.warn('[oxpulse-chat-widget] sendToParent called before origin init — message dropped');
    return;
  }
  try {
    window.parent.postMessage(wrapIframe(msg), expectedParentOrigin);
  } catch {
    // Cross-origin parent — best effort
  }
}

/**
 * Listen for ParentMessages sent to the current window (iframe-side listener).
 * Returns an unsubscribe function.
 *
 * M2 security: reads ?origin= from the iframe's URL at call time and rejects
 * messages whose event.origin does not match.
 * If ?origin= is absent, ALL non-namespace-matched messages are rejected (fail-closed).
 */
export function onParentMessage(
  handler: (msg: ParentMessage) => void,
): () => void {
  // Read expected origin from URL query param — must be present in iframe mode
  const expectedOrigin =
    typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('origin')
      : null;

  const listener = (ev: MessageEvent): void => {
    // M2: reject messages from unexpected origins. Fail-closed:
    // if expectedOrigin is null (?origin= missing), reject ALL messages —
    // contract violation by integrator, do not silently accept arbitrary origins.
    if (!expectedOrigin || ev.origin !== expectedOrigin) return;
    if (isParentMessage(ev.data)) {
      handler(ev.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/**
 * Listen for IframeMessages from the iframe (parent-side listener).
 * Returns an unsubscribe function.
 */
export function onIframeMessage(
  iframe: HTMLIFrameElement,
  handler: (msg: IframeMessage) => void,
): () => void {
  const listener = (ev: MessageEvent): void => {
    // Security: only accept messages from the iframe's contentWindow
    if (ev.source !== iframe.contentWindow) return;
    if (isIframeMessage(ev.data)) {
      handler(ev.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
