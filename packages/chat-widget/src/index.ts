/**
 * @oxpulse/chat-widget — public API.
 *
 * Drop-in embed widget for B2B marketplace integrations.
 *
 * Script-tag usage (auto-registers custom element):
 *   <script type="module" src="https://cdn.example.com/chat-widget/index.js"></script>
 *   <oxpulse-chat app-id="your-app-id" jwt="token" room-id="chat-room"></oxpulse-chat>
 *
 * ESM/React/Vue/Svelte: see README.md quickstart.
 */

// ── Re-export public surface ──────────────────────────────────────────────────

export { OxpulseChatElement, defineElement, mount } from './element.js';
export type { MountOptions } from './types.js';
export type { WidgetConfig, WidgetEventMap } from './types.js';
export type { ProductMeta } from './types.js';
export { WidgetError, OriginNotAllowedError } from './types.js';
export type { WidgetErrorCode } from './types.js';
export { checkOrigin, decodeJwtPayload, matchOriginPattern } from './bootstrap.js';
export type { OriginCheckResult } from './types.js';
export {
  isParentMessage,
  isIframeMessage,
  sendToParent,
  onParentMessage,
  onIframeMessage,
} from './postmessage.js';
export type { ParentMessage, IframeMessage } from './types.js';

// ── Auto-register when loaded as a script tag ─────────────────────────────────
// Side-effect: defines <oxpulse-chat> if not already registered.
import { defineElement as _defineElement } from './element.js';
_defineElement();
