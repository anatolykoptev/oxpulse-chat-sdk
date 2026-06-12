// Pure helpers for the Composer — ported verbatim from
// web/src/lib/chat/composer/textfield-helpers.ts (no Svelte deps).

/** Maximum message body length in characters. */
export const MAX_BODY_CHARS = 16384;

/** The character-count threshold above which the live counter chip
 *  appears. Show once `len` crosses 90 % of the cap. */
export function shouldShowCounter(len: number, max: number): boolean {
  return len > Math.floor(max * 0.9);
}

/** Cmd/Ctrl + Enter sends. Plain Enter inserts a newline (textarea
 *  default). Returns true when the keydown event matches the
 *  send-shortcut shape.
 *  M7: IME guard — isComposing=true or keyCode=229 (IME processing)
 *  suppresses the shortcut so CJK users don't accidentally send
 *  mid-composition. */
export function isCmdEnter(ev: KeyboardEvent): boolean {
  if (ev.isComposing || ev.keyCode === 229) return false;
  if (ev.key !== 'Enter') return false;
  return Boolean(ev.metaKey || ev.ctrlKey);
}

/** Auto-grow target height (px) for a textarea, capped at maxPx.
 *  Snap to scrollHeight, never exceed the cap. */
export function autogrowHeightPx(scrollHeight: number, maxPx: number): number {
  return Math.min(scrollHeight, maxPx);
}
