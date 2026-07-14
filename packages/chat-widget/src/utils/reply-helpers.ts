/**
 * @oxpulse/chat-widget — reply preview helpers.
 *
 * Shared between MessageList (reply button + reply indicator) and Composer
 * (reply preview bar). Keeps the two surfaces consistent.
 */

/** Snapshot of a message shown as the target of a reply. */
export interface ReplySnapshot {
  /** msgId of the message being replied to. */
  msgId: string;
  /** Display name of the original sender ("You" for self). */
  sender: string;
  /** Body excerpt used in the preview; may be a plain body or an attachment fallback. */
  body: string;
}

/**
 * Clamp body to max codepoints with an ellipsis.
 * Ported from web/src/lib/chat/reply/reply-helpers.ts.
 */
export function formatBodyPreview(body: string, max = 80): string {
  const codepoints = Array.from(body);
  if (codepoints.length <= max) return body;
  return codepoints.slice(0, max).join('') + '…';
}
